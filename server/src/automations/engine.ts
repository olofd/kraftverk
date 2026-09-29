import type { AutomationMode, AutomationRun, RoleBinding } from '@kraftverk/api-contract';
import {
  attributeMeaning,
  capabilitiesOf,
  checkBinding,
  describeExpr,
  evaluate,
  evaluateNow,
  isCurrent,
  isScalar,
  localTime,
  MAIN_PART,
  partsOf,
  readingOf,
  readsRole,
  standardMeaning,
  unitOf,
  zonedInstant,
  type AutomationId,
  type AuditRecord,
  type BoundPart,
  type CapabilityId,
  type CapabilityName,
  type ConfigValues,
  type DeviceDescription,
  type Recipe,
  type RulePart,
  type RuleScope,
  type Trigger,
  type Value,
} from '@kraftverk/device-sdk';
import type { ActionGateway, GatewayResult } from '@kraftverk/gateway';
import { deviceReader, type LiveBus, type LiveMessage } from '@kraftverk/holder';

import type { DeviceCatalog } from '../devices/catalog.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import type { AutomationLibrary } from './library.ts';
import type { AutomationStore } from './store.ts';

/** One run's result, as the API shows it. */
export type RunResult = AutomationRun;
export type { AutomationMode };

export type AutomationRecord = {
  id: AutomationId;
  name: string;
  /** Where its rule comes from: a recipe an installed package ships. */
  recipe: string;
  /** Which part of which device fills each role. */
  roles: Record<string, RoleBinding>;
  params: ConfigValues;
  /** The owner's clock, from the app it was made in: "Europe/Stockholm". */
  timeZone: string;
  mode: AutomationMode;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastResult: RunResult | null;
};

/** The part filling a role, as the engine sees it: enough to check the role, read it, and hand it to a function. */
export type EngineDevice = RulePart & {
  removed: boolean;
  /** Whether the device still has that part. */
  hasPart: boolean;
  description: DeviceDescription;
  /** What the part offers. */
  capabilities: readonly CapabilityId[];
};

/**
 * Where each `becomes` trigger's state is kept — what its condition was last,
 * since when it has held, and whether this hold has run — so a restart
 * continues from where it was. The server passes its database; tests keep it
 * in memory.
 */
export type TriggerMemory = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** Forgets every key under a prefix. */
  forget(prefix: string): void;
};

/** One `becomes` trigger's state, as kept. */
type TriggerState = { last: boolean; heldSince: string | null; fired: boolean };

export type AutomationEngineDeps = {
  store: AutomationStore;
  library: Pick<AutomationLibrary, 'recipe' | 'fn'>;
  device: (binding: RoleBinding) => EngineDevice | null;
  gateway: Pick<ActionGateway, 'execute'>;
  record: (entry: AuditRecord) => void;
  /** What devices say as they say it: events and readings start runs. */
  bus?: LiveBus;
  now?: () => Date;
  /** How often it looks at what is due by the clock. */
  everyMs?: number;
  memory?: TriggerMemory;
};

/** Late, but not too late: a server that was down at 07:00 still acts at 07:20, not at 15:00. */
const GRACE_MS = 60 * 60_000;

/**
 * Runs the automations (docs/AUTOMATIONS.md).
 *
 * Every automation is a rule — its recipe's, with its roles and settings
 * filled in — and runs the same way, whoever wrote the rule:
 *
 * - `at`: looked at every little while; due once a day at that time, on the
 *   owner's clock.
 * - `event`: heard on the live bus as the device raises it.
 * - `becomes`: evaluated when a reading of a device it reads moves; fires when
 *   the condition turns true, and with `heldForMinutes` once it has stayed
 *   true that long. Its state is kept, so a restart continues from where it
 *   was — a hold resumes with what it had left, and nothing fires twice. An
 *   automation with no state yet — new, or just changed or armed — takes a
 *   condition already true as the edge: a charge window armed at 8 % starts
 *   charging, rather than waiting for the battery to rise and fall again.
 *
 * A run evaluates the rule's condition — unknown is never true — and then its
 * actions: one that observes says what it would have done; one armed sends it
 * through the gateway as `actor: 'automation'`, where dwell, freshness,
 * read-only mode and verification apply and a rule has no way around them.
 * Every run, whatever it came to, is on the timeline with the reason it gives.
 *
 * It runs on the server, because an automation needs something always on. A
 * device only a phone holds is out of the server's reach while the phone has
 * it; its runs say so.
 */
export class AutomationEngine {
  #timer: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => void) | null = null;
  #ticking = false;
  /** Automations running now: one run of the same automation at a time. */
  #running = new Set<string>();
  /** Each `becomes` trigger's state, read once from memory, and its hold when one is waiting it out. */
  #becoming = new Map<string, { state: TriggerState; hold: ReturnType<typeof setTimeout> | null }>();
  #memory: TriggerMemory;
  /** Which automations each device's messages concern, by store revision: not every automation for every reading. */
  #index: { revision: number; byDevice: Map<string, AutomationRecord[]> } | null = null;

  constructor(private deps: AutomationEngineDeps) {
    const kept = new Map<string, string>();
    this.#memory = deps.memory ?? {
      get: (key) => kept.get(key) ?? null,
      set: (key, value) => void kept.set(key, value),
      forget: (prefix) => [...kept.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => kept.delete(key)),
    };
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), this.deps.everyMs ?? 30_000);
    this.#unsubscribe ??= this.deps.bus?.subscribe((message) => void this.hear(message)) ?? null;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const entry of this.#becoming.values()) if (entry.hold) clearTimeout(entry.hold);
    this.#becoming.clear();
  }

  /**
   * Forgets what an automation's conditions were: after it changed — its
   * settings, its parts, its mode — what it now watches starts afresh, and a
   * condition already true is its edge.
   */
  reset(automationId: string): void {
    for (const [key, entry] of this.#becoming) {
      if (!key.startsWith(`${automationId}:`)) continue;
      if (entry.hold) clearTimeout(entry.hold);
      this.#becoming.delete(key);
    }
    this.#memory.forget(`automation.trigger.${automationId}:`);
  }

  /** The automations a device's events and readings can start: bound to it, and with a trigger that listens. */
  #concerning(deviceId: string): AutomationRecord[] {
    const revision = this.deps.store.revision;
    if (this.#index?.revision !== revision) {
      const byDevice = new Map<string, AutomationRecord[]>();
      for (const automation of this.deps.store.list()) {
        const recipe = this.deps.library.recipe(automation.recipe);
        if (!recipe?.when.some((trigger) => 'event' in trigger || 'becomes' in trigger)) continue;
        for (const device of new Set(Object.values(automation.roles).map((binding) => binding.device))) {
          byDevice.set(device, [...(byDevice.get(device) ?? []), automation]);
        }
      }
      this.#index = { revision, byDevice };
    }
    return this.#index.byDevice.get(deviceId) ?? [];
  }

  /** Runs whatever is due by the clock. One tick at a time. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const automation of this.deps.store.list()) {
        if (automation.mode === 'off') continue;
        const recipe = this.deps.library.recipe(automation.recipe);
        const due = recipe?.when.find((trigger) => 'at' in trigger && this.#dueAt(automation, recipe, trigger, now));
        if (due) await this.#runAndKeep(automation, null);
        // A condition is looked at on the clock too, not only when a reading moves: a battery that sits
        // at 8 % sends nothing, and an automation just armed must still see it is below its level.
        recipe?.when.forEach((trigger, index) => {
          if ('becomes' in trigger) this.#becomes(automation, recipe, trigger, index);
        });
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** What a device said: an event some automation waits for, or a reading some condition reads. */
  async hear(message: LiveMessage): Promise<void> {
    if (message.kind !== 'event' && message.kind !== 'readings') return;
    for (const indexed of this.#concerning(message.deviceId)) {
      // Its latest word — a run may have moved its last result since the index was built.
      const automation = this.deps.store.get(indexed.id) ?? indexed;
      if (automation.mode === 'off') continue;
      const recipe = this.deps.library.recipe(automation.recipe);
      if (!recipe) continue;
      for (const [index, trigger] of recipe.when.entries()) {
        if (message.kind === 'event' && 'event' in trigger) {
          const binding = automation.roles[trigger.event.role];
          const matches = binding?.device === message.deviceId && binding.part === (message.event.part ?? MAIN_PART) && trigger.event.event === message.event.id;
          if (!matches) continue;
          const device = this.deps.device(binding);
          const label = device?.description.events?.find((event) => event.id === message.event.id)?.label ?? message.event.id;
          await this.#runAndKeep(automation, `${device?.name ?? 'A device'} said: ${label}`);
        }
        if (message.kind === 'readings' && 'becomes' in trigger) {
          const watched = Object.entries(automation.roles).some(([role, binding]) => binding.device === message.deviceId && readsRole(recipe, role));
          if (watched) this.#becomes(automation, recipe, trigger, index);
        }
      }
    }
  }

  /**
   * A `becomes` trigger, looked at again: fires on the change to true — or
   * once it has held that long — and, with no state kept yet, on a condition
   * already true. Its state is kept after every change, so a restart resumes
   * a hold with the time it had left and never fires one twice.
   */
  #becomes(automation: AutomationRecord, recipe: Recipe, trigger: Extract<Trigger, { becomes: unknown }>, index: number): void {
    const key = `${automation.id}:${index}`;
    const memoryKey = `automation.trigger.${key}`;
    const scope = this.#scope(automation, recipe);
    const now = evaluateNow(trigger.becomes, scope);
    // Unknown — a device gone quiet — changes nothing: neither a start nor an end.
    if (typeof now !== 'boolean') return;

    let entry = this.#becoming.get(key);
    if (!entry) {
      const kept = this.#memory.get(memoryKey);
      // Nothing kept: as if it had been false, so a condition already true is its edge.
      entry = { state: kept ? (JSON.parse(kept) as TriggerState) : { last: false, heldSince: null, fired: false }, hold: null };
      this.#becoming.set(key, entry);
    }
    const { state } = entry;
    const keep = () => this.#memory.set(memoryKey, JSON.stringify(state));

    if (!now) {
      if (entry.hold) clearTimeout(entry.hold);
      entry.hold = null;
      if (state.last || state.heldSince || state.fired) {
        Object.assign(state, { last: false, heldSince: null, fired: false });
        keep();
      }
      return;
    }

    const turned = !state.last;
    if (turned) {
      Object.assign(state, { last: true, heldSince: this.#now().toISOString(), fired: false });
      keep();
    }
    // True, and already dealt with — or already waiting it out.
    if (state.fired || entry.hold) return;

    const trace: string[] = [];
    evaluateNow(trigger.becomes, scope, trace);
    const minutes = trigger.heldForMinutes ? Number(evaluateNow(trigger.heldForMinutes, scope)) : 0;
    const fire = (because: string) => {
      state.fired = true;
      keep();
      void this.#runAndKeep(this.deps.store.get(automation.id) ?? automation, because);
    };
    const since = Date.parse(state.heldSince ?? this.#now().toISOString());
    const remaining = minutes > 0 ? since + minutes * 60_000 - this.#now().getTime() : 0;
    if (remaining <= 0) {
      fire(minutes > 0 ? `${trace.join('; ')}, for ${minutes} min` : trace.join('; '));
      return;
    }
    entry.hold = setTimeout(() => {
      entry.hold = null;
      // Still true, all this time? Only then.
      const held: string[] = [];
      if (evaluateNow(trigger.becomes, this.#scope(automation, recipe), held) !== true) return;
      fire(`${held.join('; ')}, for ${minutes} min`);
    }, remaining);
    (entry.hold as { unref?: () => void }).unref?.();
  }

  #dueAt(automation: AutomationRecord, recipe: Recipe, trigger: Extract<Trigger, { at: unknown }>, now: Date): boolean {
    const at = evaluateNow(trigger.at, this.#scope(automation, recipe));
    const [hour, minute] = typeof at === 'string' ? at.split(':').map(Number) : [];
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return false;
    const today = localTime(now, automation.timeZone);
    const time = zonedInstant({ ...today, hour, minute }, automation.timeZone);
    const since = now.getTime() - time.getTime();
    if (since < 0 || since > GRACE_MS) return false;
    return automation.lastRunAt === null || Date.parse(automation.lastRunAt) < time.getTime();
  }

  async #runAndKeep(automation: AutomationRecord, because: string | null): Promise<void> {
    if (this.#running.has(automation.id)) return;
    this.#running.add(automation.id);
    try {
      const result = await this.run(automation, { because });
      this.deps.store.ran(automation.id, result);
    } finally {
      this.#running.delete(automation.id);
    }
  }

  /** What a rule is evaluated against: its settings, and the parts filling its roles as they are now. */
  #scope(automation: AutomationRecord, recipe: Recipe, now = this.#now()): RuleScope {
    const part = (role: string): EngineDevice | null => {
      const binding = automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      return device && !device.removed ? device : null;
    };
    return {
      param: (name) => {
        const field = recipe.params.fields[name];
        return (automation.params[name] ?? (field && 'default' in field ? field.default : undefined) ?? null) as Value;
      },
      read: (role, means) => {
        const device = part(role);
        const attribute = device ? attributeMeaning(device.description, device.part, means) : null;
        const reading = device?.device && attribute ? readingOf(device.device.readings(), attribute.key) : null;
        // What it reports now: a reading past how long it stays current is not known, and neither is structure.
        if (!attribute || !reading || !isCurrent(attribute, reading, now.getTime()) || !isScalar(reading.value)) return null;
        return { value: reading.value, label: standardMeaning(means)?.label ?? attribute.label, unit: unitOf(attribute) };
      },
      call: async (id, role, args) => {
        const fn = this.deps.library.fn(id);
        const device = part(role);
        if (!fn) return { value: null, detail: `No installed package offers ${id}` };
        if (!device) return { value: null, detail: `${recipe.roles[role]?.label ?? role}: no device` };
        return fn.evaluate({ part: device, args, now, timeZone: automation.timeZone });
      },
      name: (role) => part(role)?.name ?? 'a device you no longer have',
    };
  }

  /**
   * One run. `check` only decides and says what would happen — the editor's
   * "Check now" — and is neither recorded nor acted on, whatever the mode.
   */
  async run(automation: AutomationRecord, options: { check?: boolean; because?: string | null } = {}): Promise<RunResult> {
    const at = this.#now();
    const result = (outcome: RunResult['outcome'], summary: string): RunResult => ({ at: at.toISOString(), outcome, summary });
    const recipe = this.deps.library.recipe(automation.recipe);
    const actor = `automation:${automation.name}`;
    // A run is about its automation; the device it acted on, if any, is in the detail.
    const note = (entry: RunResult, device?: string, detail?: unknown) => {
      if (!options.check) this.deps.record({ at: entry.at, kind: `automation.${entry.outcome}`, actor, resourceKind: 'automation', resource: automation.id, summary: `${automation.name}: ${entry.summary}`, detail: { ...(device ? { device } : {}), ...(detail as object) } });
      return entry;
    };

    if (!recipe) return note(result('unknown', `This server has no recipe "${automation.recipe}": the package that brought it is not installed`));
    const problems = this.roleProblems(automation);
    if (problems.length) return note(result('unknown', problems.join('; ')));

    const scope = this.#scope(automation, recipe, at);
    const trace: string[] = options.because ? [options.because] : [];
    // A check is not started by its trigger: say what it read, once, and whether each condition it waits for holds now.
    if (options.check) {
      const read: string[] = [];
      const judged: string[] = [];
      const settled = Object.fromEntries(Object.keys(recipe.params.fields).map((key) => [key, scope.param(key)]));
      for (const trigger of recipe.when) {
        if (!('becomes' in trigger)) continue;
        const holds = evaluateNow(trigger.becomes, scope, read);
        const condition = describeExpr(recipe, trigger.becomes, settled, (role) => scope.name(role), this.deps.library);
        judged.push(`${condition}: ${holds === true ? 'yes, now' : holds === false ? 'not now' : 'cannot be judged now'}`);
      }
      if (judged.length) trace.push(...new Set(read), ...judged);
    }
    try {
      if (recipe.if) {
        const condition = await evaluate(recipe.if, scope, trace);
        if (condition === null) return note(result('unknown', trace.join('; ') || 'It could not tell'), undefined, { trace });
        if (condition !== true) return note(result('idle', trace.join('; ') || 'The condition is not met'), undefined, { trace });
      }
    } catch (error) {
      return note(result('failed', `Could not decide: ${(error as Error).message}`));
    }
    const reason = trace.join('; ');

    // What it will do, each action's arguments evaluated: an unknown one is not guessed.
    const planned: { binding: RoleBinding; name: string; capability: CapabilityName; command: string; args: Record<string, Value>; what: string }[] = [];
    for (const { command } of recipe.then) {
      const args: Record<string, Value> = {};
      for (const [name, expr] of Object.entries(command.args)) args[name] = await evaluate(expr, scope, []);
      if (Object.values(args).some((value) => value === null)) return note(result('unknown', `Could not tell what to send ${scope.name(command.role)}`));
      const binding = automation.roles[command.role]!;
      const name = scope.name(command.role);
      const setting = Object.values(args).map((value) => (value === true ? 'on' : value === false ? 'off' : String(value))).join(', ');
      const what = command.capability === 'switch' && command.command === 'set' ? `turn ${name} ${setting}` : `${command.capability}.${command.command} ${name} (${setting})`;
      planned.push({ binding, name, capability: command.capability, command: command.command, args, what });
    }
    const target = planned[0]?.binding.device;
    if (options.check || automation.mode !== 'armed') {
      return note(result('would-act', `Would ${planned.map((action) => action.what).join(', then ')}.${reason ? ` ${reason}` : ''}`), target, { trace, planned });
    }

    // Armed: through the gateway, in order, as an automation.
    const outcomes: { action: (typeof planned)[number]; outcome: GatewayResult }[] = [];
    for (const action of planned) {
      const outcome = await this.deps.gateway.execute({
        deviceId: action.binding.device,
        part: action.binding.part,
        capability: action.capability,
        command: action.command,
        args: action.args,
        reason: `${automation.name}: ${reason || 'as it was set up to'}`,
        actor: 'automation',
        by: actor,
      });
      outcomes.push({ action, outcome });
      if (outcome.outcome !== 'verified') break; // what follows may depend on it
    }
    const last = outcomes.at(-1)!;
    const kind = last.outcome.outcome === 'verified' ? 'acted' : last.outcome.outcome;
    const said = outcomes
      .map(({ action, outcome }) =>
        outcome.outcome === 'verified' && outcome.detail.startsWith('Already')
          ? `${action.name} was already ${action.what.split(' ').at(-1)}`
          : outcome.outcome === 'verified'
            ? `${capitalise(action.what)}: ${outcome.detail}`
            : outcome.outcome === 'refused'
              ? `Did not ${action.what}: ${outcome.detail}`
              : `Tried to ${action.what}: ${outcome.detail}`
      )
      .join('. ');
    return note(result(kind, `${said}.${reason ? ` ${reason}` : ''}`.replace('..', '.')), target, { trace, gateway: outcomes.map(({ outcome }) => outcome) });
  }

  /** Why an automation cannot run as its roles are filled: a removed device, a part that no longer fits, a meaning it does not report. */
  roleProblems(automation: AutomationRecord): string[] {
    const recipe = this.deps.library.recipe(automation.recipe);
    if (!recipe) return [`Unknown recipe "${automation.recipe}"`];
    const removed = Object.entries(recipe.roles).flatMap(([role, spec]) => {
      const binding = automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      return device?.removed ? [`${spec.label}: ${device.name} has been removed`] : [];
    });
    if (removed.length) return removed;
    return checkBinding(recipe, (role): BoundPart | null => {
      const binding = automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      return device ? { name: device.name, description: device.description, part: device.part, capabilities: device.hasPart ? device.capabilities : [] } : null;
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
    const session = removed ? null : sessions.get(record.id);
    return {
      name: binding.part === MAIN_PART || !part ? record.name : `${record.name} — ${part.label}`,
      removed,
      hasPart: part !== null,
      part: binding.part,
      description,
      // What a function may see: readings, health and checked queries — never the session itself.
      device: session ? deviceReader(session, () => sessions.description(record)) : null,
      offline: removed ? 'It has been removed' : sessions.health(record).detail,
      capabilities: part ? capabilitiesOf(description, part.id) : [],
    };
  };
