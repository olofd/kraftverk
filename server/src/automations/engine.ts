import type { RoleBinding } from '@kraftverk/api-contract';
import { capabilitiesOf, MAIN_PART, meetsNeed, partsOf } from '@kraftverk/device-sdk';
import type { ActionGateway, AuditEntry, GatewayResult } from '@kraftverk/gateway';

import type { DeviceCatalog } from '../devices/catalog.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import { recipeOf, type AutomationRecord, type Decision, type RecipeDevice, type RunResult } from './recipes.ts';
import type { AutomationStore } from './store.ts';

/** The part filling a role, as the engine sees it: enough to check the role and to hand a recipe. */
export type EngineDevice = RecipeDevice & { removed: boolean; /** Whether the device still has that part. */ hasPart: boolean };

export type AutomationEngineDeps = {
  store: AutomationStore;
  device: (binding: RoleBinding) => EngineDevice | null;
  gateway: Pick<ActionGateway, 'execute'>;
  record: (entry: AuditEntry) => void;
  now?: () => Date;
  /** How often it looks at what is due. */
  everyMs?: number;
};

/**
 * Runs the automations (docs/ARCHITECTURE.md §4.7, step 14).
 *
 * Every little while it asks each automation's recipe whether it is due, lets
 * the recipe decide, and — only for one that is armed — sends what it decided
 * through the gateway, as `actor: 'automation'`: the gateway's dwell time,
 * freshness, read-only mode and verification all apply, and a recipe has no
 * way around them. One observing says what it would have done. Every run,
 * whatever it came to, is in the audit timeline and kept as the automation's
 * last result, so a run that could not reach its device says why.
 *
 * It runs on the server, because an automation needs something always on. A
 * device only a phone holds is out of the server's reach while the phone has
 * it; its runs are refused, with that reason.
 */
export class AutomationEngine {
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(private deps: AutomationEngineDeps) {}

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), this.deps.everyMs ?? 30_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Runs whatever is due. One tick at a time: a slow gateway must not start a second run of the same thing. */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = this.#now();
      for (const automation of this.deps.store.list()) {
        if (automation.mode === 'off') continue;
        const recipe = recipeOf(automation.recipe);
        if (!recipe?.due(automation, now)) continue;
        const result = await this.run(automation);
        this.deps.store.ran(automation.id, result);
      }
    } finally {
      this.#running = false;
    }
  }

  /**
   * One run. `check` only decides and says what would happen — the editor's
   * "Check now" — and is neither recorded nor acted on, whatever the mode.
   */
  async run(automation: AutomationRecord, options: { check?: boolean } = {}): Promise<RunResult> {
    const at = this.#now();
    const result = (outcome: RunResult['outcome'], summary: string): RunResult => ({ at: at.toISOString(), outcome, summary });
    const recipe = recipeOf(automation.recipe);
    const actor = `automation:${automation.name}`;
    const note = (entry: RunResult, resource?: string, detail?: unknown) => {
      if (!options.check) this.deps.record({ at: entry.at, kind: `automation.${entry.outcome}`, actor, resource, summary: `${automation.name}: ${entry.summary}`, detail: { automationId: automation.id, ...(detail as object) } });
      return entry;
    };

    if (!recipe) return note(result('unknown', `This server does not know the recipe "${automation.recipe}"`));
    const problems = this.roleProblems(automation);
    if (problems.length) return note(result('unknown', problems.join('; ')));

    let decision: Decision;
    try {
      decision = await recipe.decide({
        automation,
        now: at,
        device: (role) => {
          const binding = automation.roles[role];
          const device = binding ? this.deps.device(binding) : null;
          return device && !device.removed ? device : null;
        },
      });
    } catch (error) {
      return note(result('failed', `Could not decide: ${(error as Error).message}`));
    }

    if (decision.kind !== 'act') return note(result(decision.kind, decision.reason), undefined, { decision });

    const binding = automation.roles[decision.role]!;
    const deviceId = binding.device;
    const target = this.deps.device(binding)!;
    const setting = Object.values(decision.args).map((value) => (value === true ? 'on' : value === false ? 'off' : String(value))).join(', ');
    const what = `turn ${target.name} ${setting}`;
    if (options.check || automation.mode !== 'armed') {
      return note(result('would-act', `Would ${what}. ${decision.reason}`), deviceId, { decision });
    }

    const outcome: GatewayResult = await this.deps.gateway.execute({
      deviceId,
      part: binding.part,
      capability: decision.capability,
      command: decision.command,
      args: decision.args,
      reason: `${automation.name}: ${decision.reason}`,
      actor: 'automation',
      by: actor,
    });
    const kind = outcome.outcome === 'verified' ? 'acted' : outcome.outcome;
    const summary =
      outcome.outcome === 'verified' && outcome.detail.startsWith('Already')
        ? `${target.name} was already ${setting}. ${decision.reason}`
        : outcome.outcome === 'verified'
          ? `${capitalise(what)}: ${outcome.detail}. ${decision.reason}`
          : outcome.outcome === 'refused'
            ? `Did not ${what}: ${outcome.detail}`
            : `Tried to ${what}: ${outcome.detail}`;
    return note(result(kind, summary), deviceId, { decision, gateway: outcome });
  }

  /** Why an automation's roles cannot be used as they are filled: a removed device, one that no longer fits. */
  roleProblems(automation: AutomationRecord): string[] {
    const recipe = recipeOf(automation.recipe);
    if (!recipe) return [`Unknown recipe "${automation.recipe}"`];
    return Object.entries(recipe.roles).flatMap(([role, spec]) => {
      const binding = automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      if (!binding || !device) return [`${spec.label}: no device`];
      if (device.removed) return [`${spec.label}: ${device.name} has been removed`];
      if (!device.hasPart) return [`${spec.label}: ${device.name} no longer has that part`];
      return meetsNeed(spec, device.capabilities) ? [] : [`${spec.label}: ${device.name} cannot do that`];
    });
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Parts of devices as the server holds them, for the engine: a removed device
 * is still found, so an automation can say it was removed rather than that it
 * never existed; one only an app holds has no session here, and says whose it
 * is. A part is named with its device: "Garage station — AC outlets".
 */
export const serverDevices =
  (catalog: Pick<DeviceCatalog, 'get'>, sessions: Pick<DeviceSessionManager, 'get' | 'health' | 'description'>) =>
  (binding: RoleBinding): EngineDevice | null => {
    const record = catalog.get(binding.device);
    if (!record) return null;
    const removed = record.removedAt !== null;
    const description = removed ? record.description : sessions.description(record);
    const part = partsOf(description, record.name).find((candidate) => candidate.id === binding.part) ?? null;
    return {
      name: binding.part === MAIN_PART || !part ? record.name : `${record.name} — ${part.label}`,
      removed,
      hasPart: part !== null,
      part: binding.part,
      session: removed ? null : sessions.get(record.id),
      offline: removed ? 'It has been removed' : sessions.health(record).detail,
      capabilities: part ? capabilitiesOf(description, part.id) : [],
    };
  };
