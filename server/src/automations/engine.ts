import type { AutomationMode, AutomationRun, ConditionState, RoleBinding, RunStep } from '@kraftverk/api-contract';
import {
  attributeMeaning,
  capabilitiesOf,
  capabilityIn,
  checkBinding,
  describeExpr,
  describeSteps,
  evaluate,
  evaluateNow,
  isCurrent,
  isScalar,
  localTime,
  MAIN_PART,
  partsOf,
  readingOf,
  readsRole,
  ruleCommands,
  ruleUses,
  secondsText,
  standardMeaning,
  stepKind,
  takesSteps,
  unitOf,
  zonedInstant,
  type AutomationId,
  type AuditRecord,
  type BoundPart,
  type CapabilityId,
  type CapabilityName,
  type Command,
  type ConfigValues,
  type DeviceDescription,
  type Expr,
  type Recipe,
  type RulePart,
  type RuleScope,
  type Step,
  type StepLine,
  type Trigger,
  type Value,
} from '@kraftverk/device-sdk';
import type { ActionGateway, GatewayResult } from '@kraftverk/gateway';
import { deviceReader, type LiveBus, type LiveMessage } from '@kraftverk/holder';

import type { DeviceCatalog } from '../devices/catalog.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import type { AutomationLibrary } from './library.ts';
import type { AutomationStore, TriggerState } from './store.ts';

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
  /** Every this many minutes, a condition that still holds runs it again, unless what it would do is already so. Null: never. */
  recheckMinutes: number | null;
  /** When it last looked again to keep things so, or started afresh. */
  lookedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Its latest run that has ended. */
  lastRun: RunResult | null;
  /** The run it is taking now. */
  running: RunResult | null;
};

/** The part filling a role, as the engine sees it: enough to check the role, read it, and hand it to a function. */
export type EngineDevice = RulePart & {
  removed: boolean;
  /** Whether the device still has that part. */
  hasPart: boolean;
  description: DeviceDescription;
  /** What the part offers. */
  capabilities: readonly CapabilityId[];
  /** Whether it can be reached now: its holder says it is connected — and, when not, why. */
  reachable(): { reachable: boolean; detail: string };
  /** Someone waits on its readings until then: its holder asks it more often, as its type sees fit. */
  wantFresh(until: number): void;
};

/** One action a run would take: the command, its arguments evaluated, and how it reads. */
type PlannedAction = { binding: RoleBinding; role: string; name: string; capability: CapabilityName; command: string; args: Record<string, Value>; what: string };

export type AutomationEngineDeps = {
  store: AutomationStore;
  library: Pick<AutomationLibrary, 'recipe' | 'fn'>;
  device: (binding: RoleBinding) => EngineDevice | null;
  gateway: Pick<ActionGateway, 'execute'>;
  record: (entry: AuditRecord) => void;
  /** What devices say as they say it: events and readings start runs; and where a run in progress is said to have moved. */
  bus?: LiveBus;
  now?: () => Date;
  /** How often it looks at what is due by the clock. */
  everyMs?: number;
  /** How long a second of a step is: a second, but shorter in tests. */
  secondMs?: number;
};

/** Late, but not too late: a server that was down at 07:00 still acts at 07:20, not at 15:00. */
const GRACE_MS = 60 * 60_000;

/** How often a step that waits looks at its condition, in seconds of the step. */
const LOOK_EVERY_SECONDS = 1;

/** Why a run cannot be started or stopped, in words for the person who asked. */
export class RunRefusal extends Error {}

/** A run taking steps now: its record as it goes, and whether someone has stopped it. */
type LiveRun = {
  id: string;
  automation: AutomationRecord;
  recipe: Recipe;
  run: RunResult;
  /** A person, or an assistant for one, started it. */
  asked: boolean;
  /** Who stopped it, once someone has. */
  stoppedBy: string | null;
  /** What a wait is woken by when it is stopped. */
  wake: Set<() => void>;
  /** How often its rule may switch each role's part, at most: what it tells the gateway. */
  allowance: Record<string, number>;
};

type Walked = 'ok' | 'failed' | 'stopped';

/**
 * Runs the automations (docs/AUTOMATIONS.md, docs/SEQUENCES.md).
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
 *   condition already true as the edge.
 * - `asked`: when a person, or an assistant for one, starts it.
 *
 * A condition fires once: what it did then stays until it turns true again,
 * and a person may change it in between. An automation that keeps things so
 * (`recheckMinutes`) looks again on that schedule.
 *
 * A run evaluates the rule's condition — unknown is never true — and then its
 * steps, in order: one that observes says what it would have done; one armed
 * sends each command through the gateway as `actor: 'automation'`, where
 * dwell, freshness, read-only mode and verification apply and a rule has no
 * way around them. A rule of commands alone is done at once; one that takes
 * steps runs for as long as they last — never longer than their limits — its
 * row written at every step, and said on the live bus, so a screen follows
 * it. If a step does not succeed, or someone stops it, its `otherwise` steps
 * run. A run found unended when the server starts was interrupted: ended as
 * such, never resumed.
 *
 * It runs on the server, because an automation needs something always on.
 */
export class AutomationEngine {
  #timer: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => void) | null = null;
  #ticking = false;
  /** Automations running now: one run of the same automation at a time. */
  #running = new Set<string>();
  /** Runs taking steps now, by automation. */
  #live = new Map<string, LiveRun>();
  /** Each `becomes` trigger's state, read once from the store, and its hold when one is waiting it out. */
  #becoming = new Map<string, { state: TriggerState; hold: ReturnType<typeof setTimeout> | null }>();
  /** Which automations each device's messages concern, by store revision: not every automation for every reading. */
  #index: { revision: number; byDevice: Map<string, AutomationRecord[]> } | null = null;

  constructor(private deps: AutomationEngineDeps) {}

  start(): void {
    this.#endInterrupted();
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
   * condition already true is its edge. Keeping things so starts afresh too:
   * its first look a whole interval from now.
   */
  reset(automationId: string): void {
    for (const [key, entry] of this.#becoming) {
      if (!key.startsWith(`${automationId}:`)) continue;
      if (entry.hold) clearTimeout(entry.hold);
      this.#becoming.delete(key);
    }
    this.deps.store.startAfresh(automationId, this.#now().toISOString());
  }

  /**
   * Looks at an automation's conditions at once — just made, changed or
   * armed — rather than at the next reading or the next tick: armed while a
   * condition already holds, it acts now.
   */
  poke(automationId: string): void {
    const automation = this.deps.store.get(automationId);
    const recipe = automation ? this.deps.library.recipe(automation.recipe) : null;
    if (!automation || !recipe || automation.mode === 'off') return;
    recipe.when.forEach((trigger, index) => {
      if ('becomes' in trigger) this.#becomes(automation, recipe, trigger, index);
    });
  }

  /** Lets go of an automation that is gone: a run it takes is stopped; what the store kept went with it. */
  forget(automationId: string): void {
    const live = this.#live.get(automationId);
    if (live) this.#stopLive(live, 'its automation was deleted');
    for (const [key, entry] of this.#becoming) {
      if (!key.startsWith(`${automationId}:`)) continue;
      if (entry.hold) clearTimeout(entry.hold);
      this.#becoming.delete(key);
    }
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
        if (due && 'at' in due) {
          // A run that takes steps goes on by itself: the clock does not wait for it.
          const going = this.#runAndKeep(automation, `Every day at ${String(evaluateNow(due.at, this.#scope(automation, recipe!, now)))}`);
          if (!takesSteps(recipe!)) await going;
        }
        // A condition is looked at on the clock too, not only when a reading moves: a battery that sits
        // at 8 % sends nothing, and an automation just armed must still see it is below its level.
        recipe?.when.forEach((trigger, index) => {
          if ('becomes' in trigger) this.#becomes(automation, recipe, trigger, index);
        });
        // Keeping things so is for what a rule does at once: a sequence is started, not kept.
        if (recipe && automation.recheckMinutes && !takesSteps(recipe)) await this.#recheck(automation, recipe, now);
      }
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Keeping things so, when it is time to: the first condition that holds,
   * and has held as long as it must, runs the automation again — unless what
   * it would do is already so. The schedule runs from the last look, the
   * last run or the last change, whichever came last.
   */
  async #recheck(automation: AutomationRecord, recipe: Recipe, now: Date): Promise<void> {
    const since = Math.max(...[automation.lookedAt, automation.lastRun?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    if (now.getTime() - since < automation.recheckMinutes! * 60_000) return;
    this.deps.store.looked(automation.id, now.toISOString());

    const scope = this.#scope(automation, recipe, now);
    for (const [index, trigger] of recipe.when.entries()) {
      if (!('becomes' in trigger)) continue;
      // Fired and still true: a hold still waiting it out, or a condition that has ended, is not one.
      const state = this.#becoming.get(`${automation.id}:${index}`)?.state;
      if (!state?.last || !state.fired) continue;
      if (evaluateNow(trigger.becomes, scope) !== true) continue;
      const planned = await this.#plan(automation, recipe, scope);
      if ('unknown' in planned) continue;
      if (planned.every((action) => this.#alreadySo(action))) return;
      await this.#runAndKeep(automation, `Looked again after ${automation.recheckMinutes} min, and it still holds: ${this.#said(automation, recipe, trigger.becomes)}`);
      return;
    }
  }

  /**
   * Whether an action would change nothing: every attribute its command sets,
   * as the capability declares, already reads what it would be set to, and
   * currently. Anything not known is not so: it is sent, and the gateway says.
   */
  #alreadySo(action: PlannedAction): boolean {
    const device = this.deps.device(action.binding);
    if (!device?.device || device.removed) return false;
    const capability = capabilityIn(device.description, action.capability);
    const sets = Object.entries(capability?.commands[action.command]?.sets ?? {});
    if (!capability || !sets.length) return false;
    const readings = device.device.readings();
    const at = this.#now().getTime();
    return sets.every(([arg, name]) => {
      const means = capability.attributes[name]?.means;
      const attribute = means ? attributeMeaning(device.description, action.binding.part, means) : null;
      const reading = attribute ? readingOf(readings, attribute.key) : null;
      return attribute !== null && reading !== null && isCurrent(attribute, reading, at) && String(reading.value) === String(action.args[arg]);
    });
  }

  /** One command as it would be sent, its arguments evaluated: an unknown one is not guessed. */
  async #planCommand(automation: AutomationRecord, command: Command, scope: RuleScope): Promise<PlannedAction | { unknown: string }> {
    const args: Record<string, Value> = {};
    for (const [name, expr] of Object.entries(command.args)) args[name] = await evaluate(expr, scope, []);
    if (Object.values(args).some((value) => value === null)) return { unknown: scope.name(command.role) };
    const binding = automation.roles[command.role]!;
    const name = scope.name(command.role);
    const setting = Object.values(args).map((value) => (value === true ? 'on' : value === false ? 'off' : String(value))).join(', ');
    const what = command.capability === 'switch' && command.command === 'set' ? `turn ${name} ${setting}` : `${command.capability}.${command.command} ${name} (${setting})`;
    return { binding, role: command.role, name, capability: command.capability, command: command.command, args, what };
  }

  /** What a rule of commands alone would do, each evaluated: an unknown one is not guessed. */
  async #plan(automation: AutomationRecord, recipe: Recipe, scope: RuleScope): Promise<PlannedAction[] | { unknown: string }> {
    const planned: PlannedAction[] = [];
    for (const step of recipe.then) {
      if (!('command' in step)) continue;
      const action = await this.#planCommand(automation, step.command, scope);
      if ('unknown' in action) return action;
      planned.push(action);
    }
    return planned;
  }

  /** What a device said: an event some automation waits for, or a reading some condition reads. */
  async hear(message: LiveMessage): Promise<void> {
    if (message.kind !== 'event' && message.kind !== 'readings') return;
    for (const indexed of this.#concerning(message.deviceId)) {
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
          const going = this.#runAndKeep(automation, `${device?.name ?? 'A device'} said: ${label}`);
          if (!takesSteps(recipe)) await going;
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
    const scope = this.#scope(automation, recipe);
    const now = evaluateNow(trigger.becomes, scope);
    // Unknown — a device gone quiet — changes nothing: neither a start nor an end.
    if (typeof now !== 'boolean') return;

    let entry = this.#becoming.get(key);
    if (!entry) {
      // Nothing kept: as if it had been false, so a condition already true is its edge.
      entry = { state: this.deps.store.trigger(automation.id, index) ?? { last: false, heldSince: null, fired: false }, hold: null };
      this.#becoming.set(key, entry);
    }
    const { state } = entry;
    const keep = () => this.deps.store.keepTrigger(automation.id, index, state);

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

    const said = this.#said(automation, recipe, trigger.becomes);
    const minutes = trigger.heldForMinutes ? Number(evaluateNow(trigger.heldForMinutes, scope)) : 0;
    const fire = (why: string) => {
      state.fired = true;
      keep();
      void this.#runAndKeep(this.deps.store.get(automation.id) ?? automation, why);
    };
    const since = Date.parse(state.heldSince ?? this.#now().toISOString());
    const remaining = minutes > 0 ? since + minutes * 60_000 - this.#now().getTime() : 0;
    if (remaining <= 0) {
      fire(minutes > 0 ? `${said}, for ${minutes} min` : said);
      return;
    }
    entry.hold = setTimeout(() => {
      entry.hold = null;
      // Still true, all this time? Only then.
      if (evaluateNow(trigger.becomes, this.#scope(automation, recipe)) !== true) return;
      fire(`${said}, for ${minutes} min`);
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
    const lastStarted = Math.max(...[automation.lastRun?.at, automation.running?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    return !Number.isFinite(lastStarted) || lastStarted < time.getTime();
  }

  async #runAndKeep(automation: AutomationRecord, why: string, startedBy: string | null = null): Promise<RunResult | null> {
    if (this.#running.has(automation.id)) return null;
    this.#running.add(automation.id);
    try {
      return await this.run(automation, { why, startedBy });
    } finally {
      this.#running.delete(automation.id);
    }
  }

  // --- asked: started, and stopped, by a person -------------------------------------------

  /**
   * Starts an automation a person — or an assistant for one — asked for: one
   * started when asked, and not off. One that only watches answers with what
   * it would do, and nothing is sent or kept. One that acts starts, and the
   * run is answered as it stands once it has begun; it goes on taking its
   * steps, said on the live bus as it does.
   */
  async startAsked(automationId: string, by: string): Promise<RunResult> {
    const automation = this.deps.store.get(automationId);
    const recipe = automation ? this.deps.library.recipe(automation.recipe) : null;
    if (!automation) throw new RunRefusal('No such automation');
    if (!recipe) throw new RunRefusal(`This server has no recipe "${automation.recipe}": the package that brought it is not installed`);
    if (!recipe.when.some((trigger) => 'asked' in trigger)) throw new RunRefusal('It is not started when asked: it runs on its own, as it is set up to');
    if (automation.mode === 'off') throw new RunRefusal('It is off: turn it on to start it');
    if (this.#running.has(automation.id)) throw new RunRefusal('It is already running');
    if (automation.mode !== 'armed') return this.run(automation, { check: true, why: `Started by ${by}` });

    let begun!: (run: RunResult) => void;
    const started = new Promise<RunResult>((resolve) => (begun = resolve));
    this.#running.add(automation.id);
    void this.run(automation, { why: `Started by ${by}`, startedBy: by, onBegun: (run) => begun(run) })
      .then((run) => begun(run))
      .finally(() => this.#running.delete(automation.id));
    return started;
  }

  /** Stops a run in progress: the step it is in ends as stopped, and its `otherwise` steps run. */
  stopAsked(automationId: string, by: string): RunResult {
    const live = this.#live.get(automationId);
    if (!live) throw new RunRefusal('It is not running');
    this.#stopLive(live, by);
    return live.run;
  }

  /** The run an automation is taking now, as it stands; null when none. */
  running(automationId: string): RunResult | null {
    return this.#live.get(automationId)?.run ?? null;
  }

  #stopLive(live: LiveRun, by: string): void {
    live.stoppedBy ??= by;
    for (const wake of live.wake) wake();
  }

  /** Runs that never ended — the server stopped during them — ended as interrupted, and said so: never resumed. */
  #endInterrupted(): void {
    for (const { automationId, run } of this.deps.store.unended()) {
      if (this.#live.has(automationId)) continue;
      const at = this.#now().toISOString();
      const inStep = run.steps.find((step) => step.endedAt === null);
      const ended: RunResult = {
        ...run,
        outcome: 'interrupted',
        endedAt: at,
        steps: run.steps.map((step) => (step.endedAt === null ? { ...step, outcome: 'stopped', detail: 'The server stopped during it', endedAt: at, until: null } : step)),
        summary: `Interrupted: the server stopped${inStep ? ` during “${inStep.what}”` : ''}. It was not resumed — check what it had switched`,
      };
      this.deps.store.endRun(run.id!, ended);
      const automation = this.deps.store.get(automationId);
      this.deps.record({
        at,
        kind: 'automation.interrupted',
        actor: `automation:${automation?.name ?? automationId}`,
        resourceKind: 'automation',
        resource: automationId,
        summary: `${automation?.name ?? 'An automation'}: ${ended.summary}`,
        detail: { run: run.id },
      });
    }
  }

  // --- a run --------------------------------------------------------------------------

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
      reachable: (role) => {
        const device = part(role);
        return device ? device.reachable() : { reachable: false, detail: `${recipe.roles[role]?.label ?? role}: no device` };
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

  /** Its settings as a sentence reads them: each one's value, or its default. */
  #settled(automation: AutomationRecord, recipe: Recipe): Record<string, Value> {
    const scope = this.#scope(automation, recipe);
    return Object.fromEntries(Object.keys(recipe.params.fields).map((key) => [key, scope.param(key)]));
  }

  /** A condition in words, its settings filled in: "Garage station's charge is at least 50 %". */
  #said(automation: AutomationRecord, recipe: Recipe, expr: Expr): string {
    const scope = this.#scope(automation, recipe);
    return describeExpr(recipe, expr, this.#settled(automation, recipe), (role) => scope.name(role), this.deps.library);
  }

  /** Its steps in words, numbered and nested, as its card shows them. */
  steps(automation: AutomationRecord): { steps: StepLine[]; otherwise: StepLine[] } {
    const recipe = this.deps.library.recipe(automation.recipe);
    if (!recipe) return { steps: [], otherwise: [] };
    const scope = this.#scope(automation, recipe);
    return describeSteps(recipe, this.#settled(automation, recipe), (role) => scope.name(role), this.deps.library);
  }

  /**
   * Each condition an automation waits for, as it stands at `at`, and what it
   * read to say so: how a run explains itself, and what its card shows now.
   */
  judge(automation: AutomationRecord, at = this.#now()): { conditions: ConditionState[]; saw: string[] } {
    const recipe = this.deps.library.recipe(automation.recipe);
    if (!recipe) return { conditions: [], saw: [] };
    const scope = this.#scope(automation, recipe, at);
    const saw: string[] = [];
    const conditions = recipe.when.flatMap((trigger): ConditionState[] => {
      if (!('becomes' in trigger)) return [];
      const holds = evaluateNow(trigger.becomes, scope, saw);
      const minutes = trigger.heldForMinutes ? Number(evaluateNow(trigger.heldForMinutes, scope)) : 0;
      const text = `${this.#said(automation, recipe, trigger.becomes)}${minutes > 0 ? ` for ${minutes} min` : ''}`;
      return [{ text, holds: typeof holds === 'boolean' ? holds : null }];
    });
    return { conditions, saw: [...new Set(saw)] };
  }

  /** When it next looks again to keep things so: null when it does not, or is off. */
  nextLookAt(automation: AutomationRecord): string | null {
    if (!automation.recheckMinutes || automation.mode === 'off') return null;
    const since = Math.max(...[automation.lookedAt, automation.lastRun?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    const next = Number.isFinite(since) ? since + automation.recheckMinutes * 60_000 : this.#now().getTime();
    return new Date(Math.max(next, this.#now().getTime())).toISOString();
  }

  /**
   * One run, and what it came to — with why it ran, what it read, how each
   * condition stood and each step it took, so a person can follow it. `check`
   * only decides and says what would happen, and is neither kept nor acted
   * on, whatever the mode. A run that takes steps is said on the live bus at
   * every step, and `onBegun` is given it once it has begun.
   */
  async run(automation: AutomationRecord, options: { check?: boolean; why?: string; startedBy?: string | null; onBegun?: (run: RunResult) => void } = {}): Promise<RunResult> {
    const at = this.#now();
    const recipe = this.deps.library.recipe(automation.recipe);
    const why = options.why ?? (options.check ? 'Asked what it would do now' : 'As it was set up to');
    const judged = this.judge(automation, at);
    const run: RunResult = {
      id: null,
      at: at.toISOString(),
      endedAt: null,
      startedBy: options.startedBy ?? null,
      outcome: 'running',
      summary: '',
      why,
      saw: judged.saw,
      conditions: judged.conditions,
      steps: [],
    };
    /** A run over as it began: kept, and on the timeline, unless it was only asked what it would do. */
    const over = (outcome: RunResult['outcome'], summary: string, steps: RunStep[] = [], device?: string): RunResult => {
      Object.assign(run, { outcome, summary, steps, endedAt: run.at });
      if (!options.check) {
        run.id = this.deps.store.ran(automation.id, run);
        this.#note(automation, run, device);
      }
      return run;
    };

    if (!recipe) return over('unknown', `This server has no recipe "${automation.recipe}": the package that brought it is not installed`);
    const problems = this.roleProblems(automation);
    if (problems.length) return over('unknown', problems.join('; '));

    const scope = this.#scope(automation, recipe, at);
    try {
      if (recipe.if) {
        const trace: string[] = [];
        const condition = await evaluate(recipe.if, scope, trace);
        run.saw = [...new Set([...run.saw, ...trace])];
        // In the words of what it asked — "Tomorrow looks cloudy: 90 % cloud" — or, with none, the condition's own.
        const said = trace.join('; ');
        if (condition === null) return over('unknown', said || `Could not tell whether ${this.#said(automation, recipe, recipe.if)}`);
        if (condition !== true) return over('idle', said || `Not now: it is not so that ${this.#said(automation, recipe, recipe.if)}`);
      }
    } catch (error) {
      return over('failed', `Could not decide: ${(error as Error).message}`);
    }

    if (options.check || automation.mode !== 'armed') {
      const detail = options.check ? 'You only asked what it would do' : 'It only watches: let it act to have it done';
      const steps = await this.#wouldDo(automation, recipe, scope, detail);
      if ('unknown' in steps) return over('unknown', `Could not tell what to send ${steps.unknown}`);
      const said = steps.filter((step) => step.depth === 0).map((step) => lowerFirst(step.what));
      return over('would-act', `Would ${said.join(', then ')}`, steps, actsOn(automation, recipe));
    }

    // Acting: step by step, through the gateway, as an automation — kept and said as it goes when it takes steps.
    const live: LiveRun = {
      id: '',
      automation,
      recipe,
      run,
      asked: run.startedBy !== null,
      stoppedBy: null,
      wake: new Set(),
      allowance: this.#allowance(recipe, scope),
    };
    const stepped = takesSteps(recipe);
    if (stepped) {
      run.summary = 'Running';
      live.id = run.id = this.deps.store.beginRun(automation.id, run);
      this.#live.set(automation.id, live);
      this.#moved(live);
    } else live.id = `once-${automation.id}-${at.getTime()}`;
    options.onBegun?.(run);

    let walked: Walked;
    try {
      walked = await this.#walk(live, recipe.then, 0, null, 'then');
      if (walked !== 'ok' && recipe.otherwise?.length) {
        await this.#walk(live, recipe.otherwise, 0, walked === 'stopped' ? `After it was stopped by ${live.stoppedBy}` : 'After a step did not succeed', 'otherwise');
      }
    } catch (error) {
      walked = 'failed';
      this.#add(live, { kind: 'command', depth: 0, within: null, what: 'The run itself', outcome: 'failed', detail: (error as Error).message, until: null });
    }

    const top = run.steps;
    const refused = top.some((step) => step.outcome === 'refused');
    const unverified = top.some((step) => step.outcome === 'unverified');
    run.outcome = walked === 'stopped' ? 'stopped' : walked === 'failed' ? (refused && !top.some((step) => step.outcome === 'timed-out' || step.outcome === 'failed') ? 'refused' : 'failed') : unverified ? 'unverified' : 'acted';
    run.summary = this.#summaryOf(live, walked);
    run.endedAt = this.#now().toISOString();
    const device = actsOn(automation, recipe);
    if (stepped) {
      this.deps.store.endRun(live.id, run);
      this.#live.delete(automation.id);
      this.#note(automation, run, device);
      this.#moved(live);
    } else {
      run.id = this.deps.store.ran(automation.id, run);
      this.#note(automation, run, device);
    }
    return run;
  }

  /** A run on the timeline: what it came to, in a line, and which run it is. */
  #note(automation: AutomationRecord, run: RunResult, device?: string): void {
    this.deps.record({
      at: run.endedAt ?? run.at,
      kind: `automation.${run.outcome}`,
      actor: run.startedBy ?? `automation:${automation.name}`,
      resourceKind: 'automation',
      resource: automation.id,
      summary: `${automation.name}: ${run.summary}`,
      detail: { run: run.id, why: run.why, ...(device ? { device } : {}) },
    });
  }

  /** A run taking steps moved: kept, and said on the live bus, so its screen follows. */
  #moved(live: LiveRun): void {
    if (this.#live.has(live.automation.id)) this.deps.store.stepRun(live.id, live.run);
    this.deps.bus?.publish({ kind: 'automation', automationId: live.automation.id });
  }

  /** A step, as it begins — or, with an outcome that ends it, as it went. */
  #add(live: LiveRun, step: Omit<RunStep, 'at' | 'endedAt'> & { endedAt?: string | null }): RunStep {
    const now = this.#now().toISOString();
    const done = step.outcome !== 'waiting';
    const entry: RunStep = { ...step, at: now, endedAt: step.endedAt !== undefined ? step.endedAt : done ? now : null };
    live.run.steps.push(entry);
    this.#moved(live);
    return entry;
  }

  #end(live: LiveRun, entry: RunStep, outcome: RunStep['outcome'], detail: string): void {
    Object.assign(entry, { outcome, detail, endedAt: this.#now().toISOString(), until: null });
    this.#moved(live);
  }

  /**
   * How often each role's part may be switched within one run, at most, as
   * its rule can: every command to it in its steps, a retry's as often as
   * its tries, both ways of a choice. What it tells the gateway, which holds
   * it to its own ceiling besides.
   */
  #allowance(recipe: Recipe, scope: RuleScope): Record<string, number> {
    const counts: Record<string, number> = {};
    const count = (steps: readonly Step[], times: number): void => {
      for (const step of steps) {
        if ('command' in step) counts[step.command.role] = (counts[step.command.role] ?? 0) + times;
        else if ('ensure' in step) {
          const tries = evaluateNow(step.ensure.tries, scope);
          count(step.ensure.retry, times * (typeof tries === 'number' ? Math.max(0, Math.floor(tries)) : 0));
        } else if ('choose' in step) (count(step.choose.then, times), count(step.choose.else ?? [], times));
        else if ('watch' in step) (count(step.watch.then ?? [], times), count(step.watch.else ?? [], times));
      }
    };
    count(recipe.then, 1);
    count(recipe.otherwise ?? [], 1);
    return counts;
  }

  /** Seconds a step's expression says, held to what the language allows. */
  #seconds(expr: Expr, scope: RuleScope, max: number): number | null {
    const value = evaluateNow(expr, scope);
    return typeof value === 'number' && value >= 1 ? Math.min(value, max) : null;
  }

  /**
   * Steps, in order, as it acts. `then` and a choice's or watch's steps in it
   * stop at the first that does not succeed; `otherwise` tries every one
   * whatever the others do, and is not stopped; a retry stops where it
   * cannot go on.
   */
  async #walk(live: LiveRun, steps: readonly Step[], depth: number, within: string | null, mode: 'then' | 'retry' | 'otherwise'): Promise<Walked> {
    const scope = () => this.#scope(live.automation, live.recipe);
    const stopping = () => live.stoppedBy !== null && mode !== 'otherwise';
    let result: Walked = 'ok';
    for (const step of steps) {
      if (stopping()) return 'stopped';
      const kind = stepKind(step);
      const line = describeSteps({ ...live.recipe, then: [step], otherwise: [] }, this.#settled(live.automation, live.recipe), (role) => scope().name(role), this.deps.library).steps[0]!;
      let walked: Walked = 'ok';

      if ('command' in step) {
        walked = await this.#command(live, step.command, depth, within);
      } else if ('wait' in step) {
        const seconds = this.#seconds(step.wait.seconds, scope(), 3_600) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: line.text, outcome: 'waiting', detail: `For ${secondsText(seconds)}`, until: this.#after(seconds) });
        const woke = await this.#sleep(live, seconds, mode === 'otherwise');
        if (woke === 'stopped') {
          this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
          walked = 'stopped';
        } else this.#end(live, entry, 'done', `Waited ${secondsText(seconds)}`);
      } else if ('waitUntil' in step) {
        const seconds = this.#seconds(step.waitUntil.atMostSeconds, scope(), 3_600) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: line.text, outcome: 'waiting', detail: 'Waiting', until: this.#after(seconds) });
        const came = await this.#until(live, step.waitUntil.condition, seconds);
        if (came.outcome === 'met') this.#end(live, entry, 'met', `${came.seconds < 1 ? 'At once' : `After ${secondsText(came.seconds)}`}${came.saw ? ` — ${came.saw}` : ''}`);
        else if (came.outcome === 'stopped') (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`), (walked = 'stopped'));
        else (this.#end(live, entry, 'timed-out', `Not in ${secondsText(seconds)}${came.saw ? ` — ${came.saw}` : ''}`), (walked = 'failed'));
      } else if ('ensure' in step) {
        const { condition, withinSeconds, tries: triesExpr, retry } = step.ensure;
        const seconds = this.#seconds(withinSeconds, scope(), 600) ?? 1;
        const triesValue = evaluateNow(triesExpr, scope());
        const tries = typeof triesValue === 'number' ? Math.max(0, Math.min(10, Math.floor(triesValue))) : 0;
        const entry = this.#add(live, { kind, depth, within, what: line.text, outcome: 'waiting', detail: 'Watching', until: this.#after(seconds) });
        for (let attempt = 0; ; attempt++) {
          Object.assign(entry, { until: this.#after(seconds), detail: attempt === 0 ? 'Watching' : `Watching, after try ${attempt} of ${tries}` });
          this.#moved(live);
          const came = await this.#until(live, condition, seconds);
          if (came.outcome === 'met') {
            this.#end(live, entry, 'met', `${attempt === 0 ? 'At once' : `After ${attempt} ${attempt === 1 ? 'try' : 'tries'}`}${came.saw ? ` — ${came.saw}` : ''}`);
            break;
          }
          if (came.outcome === 'stopped') {
            this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
            walked = 'stopped';
            break;
          }
          if (attempt >= tries) {
            this.#end(live, entry, 'timed-out', `Not ${tries ? `in ${tries} ${tries === 1 ? 'try' : 'tries'}` : `in ${secondsText(seconds)}`}${came.saw ? ` — ${came.saw}` : ''}`);
            walked = 'failed';
            break;
          }
          const retried = await this.#walk(live, retry, depth + 1, `Try ${attempt + 1} of ${tries}`, 'retry');
          if (retried !== 'ok') {
            this.#end(live, entry, retried === 'stopped' ? 'stopped' : 'failed', retried === 'stopped' ? `Stopped by ${live.stoppedBy}` : `Try ${attempt + 1} could not be made`);
            walked = retried;
            break;
          }
        }
      } else if ('choose' in step) {
        const trace: string[] = [];
        const holds = await evaluate(step.choose.if, scope(), trace).catch(() => null);
        const branch = holds === true ? step.choose.then : (step.choose.else ?? []);
        this.#add(live, { kind, depth, within, what: line.text, outcome: 'done', detail: `${holds === true ? 'It is so' : holds === false ? 'It is not so' : 'It cannot be told, so taken as not so'}${trace.length ? ` — ${trace.join('; ')}` : ''}`, until: null });
        walked = await this.#walk(live, branch, depth + 1, holds === true ? 'Then' : 'Otherwise', mode);
      } else {
        const seconds = this.#seconds(step.watch.seconds, scope(), 3_600) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: line.text, outcome: 'waiting', detail: 'Watching', until: this.#after(seconds) });
        const held = await this.#hold(live, step.watch.condition, seconds, mode === 'otherwise');
        if (held.outcome === 'stopped') {
          this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
          walked = 'stopped';
        } else {
          const stayed = held.outcome === 'held';
          this.#end(live, entry, stayed ? 'met' : 'not-met', `${stayed ? `It stayed so for ${secondsText(seconds)}` : `It did not, after ${secondsText(held.seconds)}`}${held.saw ? ` — ${held.saw}` : ''}`);
          walked = await this.#walk(live, stayed ? (step.watch.then ?? []) : (step.watch.else ?? []), depth + 1, stayed ? 'It stayed so' : 'It did not', mode);
        }
      }

      if (walked === 'ok') continue;
      if (mode === 'otherwise') {
        result = walked === 'failed' ? 'failed' : result;
        continue;
      }
      return walked;
    }
    return result;
  }

  /** A command, through the gateway, with the run's allowance: one step. */
  async #command(live: LiveRun, command: Command, depth: number, within: string | null): Promise<Walked> {
    const scope = this.#scope(live.automation, live.recipe);
    const planned = await this.#planCommand(live.automation, command, scope);
    if ('unknown' in planned) {
      this.#add(live, { kind: 'command', depth, within, what: `Send ${planned.unknown}`, outcome: 'failed', detail: 'Could not tell what to send', until: null });
      return 'failed';
    }
    const entry = this.#add(live, { kind: 'command', depth, within, what: capitalise(planned.what), outcome: 'waiting', detail: 'Sending', until: null });
    // Why, and what it read to decide: what the device's timeline says the command was for.
    const saw = live.run.saw;
    const reason = `${live.automation.name}: ${live.run.why}${saw.length ? ` (${saw.join('; ')})` : ''}`;
    let outcome: GatewayResult;
    try {
      outcome = await this.deps.gateway.execute({
        deviceId: planned.binding.device,
        part: planned.binding.part,
        capability: planned.capability,
        command: planned.command,
        args: planned.args,
        reason,
        actor: 'automation',
        by: `automation:${live.automation.name}`,
        run: { id: live.id, asked: live.asked, switches: live.allowance[planned.role] ?? 1 },
      });
    } catch (error) {
      outcome = { outcome: 'failed', detail: (error as Error).message };
    }
    const already = outcome.outcome === 'verified' && outcome.detail.startsWith('Already');
    this.#end(live, entry, already ? 'already' : outcome.outcome === 'verified' ? 'done' : outcome.outcome, outcome.detail);
    // Unverified is sent, and the step goes on: what follows may be what proves it — a charger that draws.
    return outcome.outcome === 'refused' || outcome.outcome === 'failed' ? 'failed' : 'ok';
  }

  /** In a run's words, how it came out. */
  #summaryOf(live: LiveRun, walked: Walked): string {
    // What it did, and — from the first step of its `otherwise` on — what it did after.
    const split = live.run.steps.findIndex((step) => step.depth === 0 && step.within?.startsWith('After'));
    const steps = split < 0 ? live.run.steps : live.run.steps.slice(0, split);
    const later = split < 0 ? [] : live.run.steps.slice(split);
    const done = steps.filter((step) => step.kind === 'command' && (step.outcome === 'done' || step.outcome === 'already' || step.outcome === 'unverified') && !step.within?.startsWith('Try'));
    const did = done.map((step) => (step.outcome === 'already' ? `${lowerFirst(step.what)}: it already was` : lowerFirst(pastOf(step.what))));
    const made = steps.filter((step) => step.kind === 'ensure' && step.outcome === 'met').map((step) => step.detail);
    const afterwards = later.filter((step) => step.kind === 'command' && (step.outcome === 'done' || step.outcome === 'already'));
    const then = afterwards.length ? `; then ${afterwards.map((step) => lowerFirst(pastOf(step.what))).join(', ')}` : '';
    if (walked === 'stopped') return `Stopped by ${live.stoppedBy}${did.length ? ` after it ${did.join(', ')}` : ''}${then}`;
    if (walked === 'failed') {
      const failing = steps.find((step) => step.depth === 0 && (step.outcome === 'timed-out' || step.outcome === 'failed' || step.outcome === 'refused')) ?? steps.find((step) => step.outcome === 'failed' || step.outcome === 'refused');
      return `Did not succeed: ${failing ? `${lowerFirst(failing.what)} — ${lowerFirst(failing.detail)}` : 'a step did not'}${then}`;
    }
    // What changed leads; what was already so is said once; what it made sure of is said as the reading it saw.
    const changed = done.filter((step) => step.outcome !== 'already').map((step) => lowerFirst(pastOf(step.what)));
    const sure = made.map((detail) => {
      const [when = '', saw] = detail.split(' — ');
      return saw ? `${saw}, ${lowerFirst(when)}` : lowerFirst(detail);
    });
    const parts = [...(changed.length ? [changed.join(', ')] : done.length ? ['all was already so'] : []), ...sure];
    return parts.length ? capitalise(parts.join('; ')) : 'Nothing needed doing';
  }

  /** What it would do, each step as it would take it: its commands evaluated as they stand now. */
  async #wouldDo(automation: AutomationRecord, recipe: Recipe, scope: RuleScope, detail: string): Promise<RunStep[] | { unknown: string }> {
    const at = this.#now().toISOString();
    const lines = this.steps(automation).steps;
    const steps: RunStep[] = [];
    const flatten = (line: StepLine, depth: number, within: string | null) => {
      steps.push({ kind: line.kind, depth, within, what: line.text, outcome: 'would', detail, at, endedAt: at, until: null });
      for (const branch of line.branches) for (const inner of branch.steps) flatten(inner, depth + 1, branch.label);
    };
    for (const [index, step] of recipe.then.entries()) {
      if ('command' in step) {
        const planned = await this.#planCommand(automation, step.command, scope);
        if ('unknown' in planned) return planned;
        steps.push({ kind: 'command', depth: 0, within: null, what: capitalise(planned.what), outcome: 'would', detail, at, endedAt: at, until: null });
      } else flatten(lines[index]!, 0, null);
    }
    return steps;
  }

  /** In `seconds` of a step, as an instant. */
  #after(seconds: number): string {
    return new Date(this.#now().getTime() + seconds * 1000).toISOString();
  }

  /** A pause that a stop ends early — unless it is to be taken whatever happens. */
  #sleep(live: LiveRun, seconds: number, regardless: boolean): Promise<'slept' | 'stopped'> {
    return new Promise((resolve) => {
      const done = (outcome: 'slept' | 'stopped') => {
        clearTimeout(timer);
        live.wake.delete(stop);
        resolve(outcome);
      };
      const stop = () => {
        if (!regardless) done('stopped');
      };
      const timer = setTimeout(() => done('slept'), seconds * (this.deps.secondMs ?? 1000));
      live.wake.add(stop);
    });
  }

  /** Keeps what a condition reads fresh while a step waits on it: its holders ask their devices more often, until then. */
  #freshen(live: LiveRun, condition: Expr, seconds: number): void {
    const { reads, reaches } = ruleUses({ ...live.recipe, when: [], then: [{ waitUntil: { condition, atMostSeconds: { value: 1 } } }], otherwise: [] });
    const until = Date.now() + seconds * 1000 + 5_000;
    for (const role of new Set([...reads.map((read) => read.role), ...reaches])) {
      const binding = live.automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      device?.wantFresh(until);
    }
  }

  /** Waits until a condition is true, looking every second: at most `seconds`, or until the run is stopped. */
  async #until(live: LiveRun, condition: Expr, seconds: number): Promise<{ outcome: 'met' | 'timed-out' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, condition, seconds);
    const started = Date.now();
    const unit = this.deps.secondMs ?? 1000;
    for (;;) {
      const saw: string[] = [];
      const holds = evaluateNow(condition, this.#scope(live.automation, live.recipe), saw);
      const elapsed = (Date.now() - started) / unit;
      if (holds === true) return { outcome: 'met', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if (live.stoppedBy !== null) return { outcome: 'stopped', seconds: elapsed, saw: '' };
      if (elapsed >= seconds) return { outcome: 'timed-out', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if ((await this.#sleep(live, Math.min(LOOK_EVERY_SECONDS, seconds - elapsed), false)) === 'stopped') return { outcome: 'stopped', seconds: elapsed, saw: '' };
    }
  }

  /** Watches a condition for `seconds`: held if it is true every time it is looked at; not, the moment it is not — or cannot be told. */
  async #hold(live: LiveRun, condition: Expr, seconds: number, regardless: boolean): Promise<{ outcome: 'held' | 'broke' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, condition, seconds);
    const started = Date.now();
    const unit = this.deps.secondMs ?? 1000;
    for (;;) {
      const saw: string[] = [];
      const holds = evaluateNow(condition, this.#scope(live.automation, live.recipe), saw);
      const elapsed = (Date.now() - started) / unit;
      if (holds !== true) return { outcome: 'broke', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if (elapsed >= seconds) return { outcome: 'held', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if ((await this.#sleep(live, Math.min(LOOK_EVERY_SECONDS, seconds - elapsed), regardless)) === 'stopped') return { outcome: 'stopped', seconds: elapsed, saw: '' };
    }
  }

  /** Why an automation cannot run as its roles are filled: a removed device, a part that no longer fits, a meaning it does not report. */
  roleProblems(automation: Pick<AutomationRecord, 'recipe' | 'roles'>): string[] {
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

/** The device a run is about on the timeline: the one its first command acts on. */
const actsOn = (automation: AutomationRecord, recipe: Recipe): string | undefined => {
  const first = ruleCommands(recipe)[0];
  return first ? automation.roles[first.role]?.device : undefined;
};

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
/** "Turn Heater plug off" as done: "Turned Heater plug off"; anything else, "Sent …". */
const pastOf = (what: string) => (/^turn /i.test(what) ? `Turned ${what.slice(5)}` : `Sent ${lowerFirst(what)}`);

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
      reachable: () => {
        if (removed) return { reachable: false, detail: 'It has been removed' };
        const health = sessions.health(record);
        return { reachable: health.status === 'connected', detail: health.detail };
      },
      wantFresh: (until) => sessions.get(record.id)?.wantFresh?.(until),
    };
  };
