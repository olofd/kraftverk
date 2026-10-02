import type {
  AutomationMode,
  AutomationRun,
  ConditionState,
  RoleBinding,
  RunLog,
  RunLogKey,
  RunLogReach,
  RunLogReading,
  RunLogRole,
  RunStep,
} from '@kraftverk/api-contract';
import {
  attributeMeaning,
  capabilityIn,
  clockTime,
  isCurrent,
  isScalar,
  localTime,
  MAIN_PART,
  quantityOf,
  readingOf,
  standardMeaning,
  unitOf,
  zonedInstant,
  type AutomationId,
  type AuditRecord,
  type CapabilityId,
  type CapabilityName,
  type DeviceDescription,
  type Reading,
  type Value,
} from '@kraftverk/device-sdk';
import {
  changedRoles,
  checkBinding,
  describeExpr,
  EVERY_MINUTES,
  slotOf,
  describeSteps,
  describeTriggers,
  settledChoice,
  evaluate,
  evaluateNow,
  readsRole,
  isAutomationRole,
  partRoles,
  writtenAttribute,
  runsOn,
  ruleCommands,
  ruleUses,
  secondsText,
  stepKind,
  takesSteps,
  type BoundPart,
  type Command,
  type Expr,
  type Rule,
  type RulePart,
  type RuleScope,
  type RuleVocabulary,
  type Step,
  type StepLine,
  type Trigger,
  type Write,
} from '@kraftverk/automation';
import type { ActionGateway, GatewayResult, WriteResult } from '@kraftverk/gateway';
import type { LiveBus, LiveMessage } from '@kraftverk/holder';

import type { AutomationLibrary } from './library.ts';
import type { AutomationStorage, TriggerState } from './storage.ts';

/** One run's result, as the API shows it. */
export type RunResult = AutomationRun;
export type { AutomationMode };

export type AutomationRecord = {
  id: AutomationId;
  /** Its name in configuration: what a file and an import know it by (docs/CONFIG.md). */
  key: string;
  name: string;
  /** Its own rule, as its owner built it — or copied it from a recipe (docs/AUTOMATION-EDITOR.md). */
  rule: Rule;
  /** The recipe it was copied from, to say so; null when built from nothing. */
  madeFrom: string | null;
  /** Which part of which device fills each role a part fills. */
  roles: Record<string, RoleBinding>;
  /** Which automation fills each role a `start` step starts. */
  starts: Record<string, AutomationId>;
  /** The owner's clock, from the app it was made in: "Europe/Stockholm". */
  timeZone: string;
  mode: AutomationMode;
  /** Every this many minutes, a condition that still holds runs it again, unless what it would do is already so. Null: never. */
  recheckMinutes: number | null;
  /** Its place among the shortcuts on the home page; null when it is not there. */
  homePlace: number | null;
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
  /** The device's own name, without its part's: "Garage station". */
  deviceName: string;
  /** Its type: "acme.station". */
  typeId: string;
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

/** A setting a run would change, its value evaluated. */
type PlannedWrite = { binding: RoleBinding; key: string; value: Value };

/** What a rule of commands and settings alone would change: a command, or a setting. */
type Planned = { command: PlannedAction } | { write: PlannedWrite };

export type AutomationEngineDeps = {
  store: AutomationStorage;
  library: Pick<AutomationLibrary, 'fn'>;
  device: (binding: RoleBinding) => EngineDevice | null;
  gateway: Pick<ActionGateway, 'execute' | 'write' | 'runEnded' | 'lastSwitch' | 'lastWrite'>;
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
/**
 * After a run changes something, how long a step that judges readings waits
 * for readings taken since, at most: a station that reports every few seconds
 * still says what its outlets gave before the plug on them was switched off.
 */
const SETTLE_AT_MOST_SECONDS = 15;
/** What devices said while one run ran: at most this many readings kept, so a run left waiting long cannot fill the disk. */
const READINGS_PER_RUN = 20_000;

/** How many automations deep one may start another, counting the first: a chain stays one a person can follow. */
export const CHAIN_LIMIT = 4;

/** How the gateway's audit and memory name what an automation did: by its id, which a rename does not change. */
const AUTOMATION_ACTOR = 'automation:';
const actorOf = (automation: Pick<AutomationRecord, 'id'>): string => `${AUTOMATION_ACTOR}${automation.id}`;

/** Why a run cannot be started or stopped, in words for the person who asked. */
export class RunRefusal extends Error {}

/**
 * Who asked for a run: a person, or an assistant for one. `name` is how the
 * run says it ("olof", "assistant for olof"); `actor` is how the gateway
 * treats its first switches — a person's dwell, or an assistant's.
 */
export type Asker = { name: string; actor: 'user' | 'agent' };

/** A run taking steps now: its record as it goes, and whether someone has stopped it. */
type LiveRun = {
  id: string;
  automation: AutomationRecord;
  rule: Rule;
  run: RunResult;
  /** Who asked for it — or for the run that started it; null, triggers did. */
  asker: Asker | null;
  /** The automations whose runs started this one, the first first: what a `start` step may not start again. */
  chain: readonly AutomationId[];
  /** The first run of its chain: runs of one chain hold their parts together. */
  root: symbol;
  /** The parts it holds while it runs — every part it may change, as `device:part` — and what it calls each. */
  holds: ReadonlyMap<string, string>;
  /** Who stopped it, once someone has. */
  stoppedBy: string | null;
  /** Its automation was deleted while it ran: it ends at the next step, and is neither kept nor on the timeline. */
  gone: boolean;
  /** What a wait is woken by when it is stopped. */
  wake: Set<() => void>;
  /** How often its rule may switch each role's part, at most: what it tells the gateway. */
  allowance: Record<string, number>;
  /** When it last changed something — switched a part, changed a setting: what is judged after is read after. 0, not yet. By this server's clock. */
  changedAt: number;
  /** Where its last change falls in what the engine heard and did, in order: what a reading heard after it is after, in the same millisecond too. */
  changedOrder: number;
  /**
   * Where this server heard each reading it uses take its value now, by "device key", in the order the engine
   * hears and does things — not by a clock, whose milliseconds two events can share, and not by the reading's
   * `at`, which a device with a clock of its own may stamp.
   */
  heard: Map<string, number>;
  /** Its log, for a run that takes steps: `look` keeps what its devices say now; `stop` ends it, after one last look. Null for a run that takes none. */
  log: { look: () => void; stop: () => void } | null;
};

type Walked = 'ok' | 'failed' | 'stopped';

/**
 * Runs the automations (docs/AUTOMATIONS.md, docs/SEQUENCES.md).
 *
 * Every automation is its own rule, with its roles filled in, and runs the
 * same way, whoever wrote the rule — its owner, block by block, or a recipe
 * it was copied from:
 *
 * - `at`: looked at every little while; due once a day at that time, on the
 *   owner's clock and on the days it names.
 * - `event`: heard on the live bus as the device raises it.
 * - `becomes`: evaluated when a reading of a device it reads moves; fires when
 *   the condition turns true, and with `heldForMinutes` once it has stayed
 *   true that long. Its state is kept, so a restart continues from where it
 *   was — a hold resumes with what it had left, and nothing fires twice. An
 *   automation with no state yet — new, just changed, or just let act — takes a
 *   condition already true as the edge.
 * - `asked`: when a person, or an assistant for one, starts it.
 *
 * A condition fires once: what it did then stays until it turns true again,
 * and a person may change it in between. An automation that keeps things so
 * (`recheckMinutes`) looks again on that schedule.
 *
 * A run evaluates the rule's condition — unknown is never true — and then its
 * steps, in order: one that watches says what it would have done; one that acts
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
  /** Runs of commands alone, acting now: not shown as running, but stopped all the same when their automation goes. */
  #once = new Map<string, LiveRun>();
  /** Each `becomes` trigger's state, read once from the store, and its hold when one is waiting it out. */
  #becoming = new Map<string, { state: TriggerState; hold: ReturnType<typeof setTimeout> | null }>();
  /** Which automations each device's messages concern, by store revision: not every automation for every reading. */
  #index: { revision: number; byDevice: Map<string, AutomationRecord[]> } | null = null;
  /** What the engine heard and did, counted in the order it happened: a run's readings and changes, told apart in the same millisecond. */
  #order = 0;

  constructor(private deps: AutomationEngineDeps) {}

  start(): void {
    this.#endInterrupted();
    // Nobody waits on a tick or on what was heard: what goes wrong is said, never left to bring the server down.
    this.#timer ??= setInterval(() => void this.tick().catch((error) => console.error('[automations] a tick failed:', error)), this.deps.everyMs ?? 30_000);
    this.#unsubscribe ??= this.deps.bus?.subscribe((message) => void this.hear(message).catch((error) => console.error('[automations] hearing a device failed:', error))) ?? null;
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
   * Forgets everything it holds of the automations it had: their database was
   * emptied beneath it (`Hub.reset`). Every run ends as if its automation were
   * deleted — neither kept nor on the new timeline — every hold is let go,
   * and what concerns each device is read again from what there is now.
   */
  clear(): void {
    for (const live of [...this.#live.values(), ...this.#once.values()]) {
      live.gone = true;
      this.#stopLive(live, 'everything was erased');
    }
    for (const entry of this.#becoming.values()) if (entry.hold) clearTimeout(entry.hold);
    this.#becoming.clear();
    this.#index = null;
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
   * let act — rather than at the next reading or the next tick: let act
   * while a condition already holds, it acts now.
   */
  poke(automationId: string): void {
    const automation = this.deps.store.get(automationId);
    if (!automation || automation.mode === 'off') return;
    automation.rule.when.forEach((trigger, index) => {
      if ('becomes' in trigger) this.#becomes(automation, automation.rule, trigger, index);
    });
  }

  /** Lets go of an automation that is gone: a run it takes is stopped; what the store kept went with it. */
  forget(automationId: string): void {
    const live = this.#live.get(automationId) ?? this.#once.get(automationId);
    if (live) {
      live.gone = true;
      this.#stopLive(live, 'its automation was deleted');
    }
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
        if (!automation.rule.when.some((trigger) => 'event' in trigger || 'becomes' in trigger)) continue;
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
        const rule = automation.rule;
        const due = rule.when.find((trigger) => ('at' in trigger && this.#dueAt(automation, rule, trigger, now)) || ('every' in trigger && this.#dueEvery(automation, rule, trigger, now)));
        if (due) {
          // A run that takes steps goes on by itself: the clock does not wait for it.
          // Why, as the trigger reads: "Every day at 07:00", "At 07:00 on weekdays".
          const why = describeTriggers({ ...rule, when: [due] }, this.#settled(automation, rule), (role) => this.#scope(automation, rule, now).name(role), this.#vocabulary(automation))[0]!;
          const going = this.#runAndKeep(automation, why);
          if (!takesSteps(rule)) await going;
        }
        // A condition is looked at on the clock too, not only when a reading moves: a battery that sits
        // at 8 % sends nothing, and an automation just let act must still see it is below its level.
        rule.when.forEach((trigger, index) => {
          if ('becomes' in trigger) this.#becomes(automation, rule, trigger, index);
        });
        // Keeping things so is for what a rule does at once: a sequence is started, not kept.
        if (automation.recheckMinutes && !takesSteps(rule)) await this.#recheck(automation, rule, now);
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
  async #recheck(automation: AutomationRecord, rule: Rule, now: Date): Promise<void> {
    const since = Math.max(...[automation.lookedAt, automation.lastRun?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    if (now.getTime() - since < automation.recheckMinutes! * 60_000) return;
    this.deps.store.looked(automation.id, now.toISOString());

    const scope = this.#scope(automation, rule, now);
    for (const [index, trigger] of rule.when.entries()) {
      if (!('becomes' in trigger)) continue;
      // Fired and still true: a hold still waiting it out, or a condition that has ended, is not one.
      const state = this.#becoming.get(`${automation.id}:${index}`)?.state;
      if (!state?.last || !state.fired) continue;
      if (evaluateNow(trigger.becomes, scope) !== true) continue;
      const planned = await this.#plan(automation, rule, scope);
      if ('unknown' in planned) continue;
      const differing = planned.filter((change) => !('command' in change ? this.#alreadySo(change.command) : this.#settingSo(change.write)));
      if (!differing.length) return;
      // The last edge wins: what another automation set since stays, until a condition of this one turns to
      // yes again. What a person or an assistant changed is switched back: that is what keeping things so is for.
      const own = actorOf(automation);
      const others = differing.some((change) => {
        const by = ('command' in change ? this.deps.gateway.lastSwitch(change.command.binding.device, change.command.binding.part) : this.deps.gateway.lastWrite(change.write.binding.device, change.write.key))?.by;
        return by !== undefined && by.startsWith(AUTOMATION_ACTOR) && by !== own;
      });
      if (others) return;
      await this.#runAndKeep(automation, `Looked again after ${automation.recheckMinutes} min, and it still holds: ${this.#said(automation, rule, trigger.becomes)}`);
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

  /** The key of the setting a write names — by its key, or by its meaning — on the part filling its role; null when it has none. */
  #settingKey(binding: RoleBinding, write: Write): string | null {
    const device = this.deps.device(binding);
    return device ? (writtenAttribute(device.description, binding.part, write)?.key ?? null) : null;
  }

  /** Whether a setting already reads what it would be set to — as the write step itself decides. */
  #settingSo(write: PlannedWrite): boolean {
    const device = this.deps.device(write.binding);
    if (!device?.device || device.removed) return false;
    const reading = readingOf(device.device.readings(), write.key);
    return reading !== null && String(reading.value) === String(write.value);
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

  /** What a rule of commands and settings alone would change, each evaluated: an unknown one is not guessed. */
  async #plan(automation: AutomationRecord, rule: Rule, scope: RuleScope): Promise<Planned[] | { unknown: string }> {
    const planned: Planned[] = [];
    for (const step of rule.then) {
      if ('command' in step) {
        const action = await this.#planCommand(automation, step.command, scope);
        if ('unknown' in action) return action;
        planned.push({ command: action });
      } else if ('write' in step) {
        const binding = automation.roles[step.write.role];
        const value = await evaluate(step.write.value, scope, []).catch(() => null);
        const key = binding ? this.#settingKey(binding, step.write) : null;
        if (!binding || value === null || !key) return { unknown: scope.name(step.write.role) };
        planned.push({ write: { binding, key, value } });
      }
    }
    return planned;
  }

  /** What a device said: an event some automation waits for, or a reading some condition reads. */
  async hear(message: LiveMessage): Promise<void> {
    if (message.kind !== 'event' && message.kind !== 'readings') return;
    for (const indexed of this.#concerning(message.deviceId)) {
      const automation = this.deps.store.get(indexed.id) ?? indexed;
      if (automation.mode === 'off') continue;
      const rule = automation.rule;
      for (const [index, trigger] of rule.when.entries()) {
        if (message.kind === 'event' && 'event' in trigger) {
          const binding = automation.roles[trigger.event.role];
          const matches = binding?.device === message.deviceId && binding.part === (message.event.part ?? MAIN_PART) && trigger.event.event === message.event.id;
          if (!matches) continue;
          const device = this.deps.device(binding);
          const label = device?.description.events?.find((event) => event.id === message.event.id)?.label ?? message.event.id;
          const going = this.#runAndKeep(automation, `${device?.name ?? 'A device'} said: ${label}`);
          if (!takesSteps(rule)) await going;
        }
        if (message.kind === 'readings' && 'becomes' in trigger) {
          const watched = Object.entries(automation.roles).some(([role, binding]) => binding.device === message.deviceId && readsRole(rule, role));
          if (watched) this.#becomes(automation, rule, trigger, index);
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
  #becomes(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { becomes: unknown }>, index: number): void {
    const key = `${automation.id}:${index}`;
    const scope = this.#scope(automation, rule);
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

    const said = capitalise(this.#said(automation, rule, trigger.becomes));
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
      try {
        // Still true, all this time? Only then.
        if (evaluateNow(trigger.becomes, this.#scope(automation, rule)) !== true) return;
        fire(`${said}, for ${minutes} min`);
      } catch (error) {
        // A timer has nobody to throw to: what went wrong is said, never left to bring the server down.
        console.error(`[automations] ${automation.id} could not fire after its hold:`, error);
      }
    }, remaining);
    (entry.hold as { unref?: () => void }).unref?.();
  }

  #dueAt(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { at: unknown }>, now: Date): boolean {
    const at = evaluateNow(trigger.at, this.#scope(automation, rule));
    const [hour, minute] = typeof at === 'string' ? at.split(':').map(Number) : [];
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return false;
    const today = localTime(now, automation.timeZone);
    // Only on its days, on the owner's calendar.
    if (!runsOn(trigger, today)) return false;
    const time = zonedInstant({ ...today, hour, minute }, automation.timeZone);
    const since = now.getTime() - time.getTime();
    if (since < 0 || since > GRACE_MS) return false;
    const lastStarted = Math.max(...[automation.lastRun?.at, automation.running?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    return !Number.isFinite(lastStarted) || lastStarted < time.getTime();
  }

  /** Whether an interval's latest slot, on the owner's clock, has come and it has not run since: once a slot, never catching up. */
  #dueEvery(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { every: unknown }>, now: Date): boolean {
    const every = evaluateNow(trigger.every, this.#scope(automation, rule));
    if (typeof every !== 'number' || every < EVERY_MINUTES.min || every > EVERY_MINUTES.max) return false;
    const today = localTime(now, automation.timeZone);
    const slot = slotOf(today.hour * 60 + today.minute, every);
    const time = zonedInstant({ ...today, hour: Math.floor(slot / 60), minute: slot % 60 }, automation.timeZone);
    const lastStarted = Math.max(...[automation.lastRun?.at, automation.running?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    return time.getTime() <= now.getTime() && (!Number.isFinite(lastStarted) || lastStarted < time.getTime());
  }

  async #runAndKeep(automation: AutomationRecord, why: string): Promise<RunResult | null> {
    if (this.#running.has(automation.id)) return null;
    this.#running.add(automation.id);
    try {
      return await this.run(automation, { why });
    } catch (error) {
      // Started by a trigger, nobody waits on it: what went wrong is said, never left to bring the server down.
      console.error(`[automations] ${automation.id} could not run:`, error);
      return null;
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
  async startAsked(automationId: string, by: Asker): Promise<RunResult> {
    const automation = this.deps.store.get(automationId);
    if (!automation) throw new RunRefusal('No such automation');
    // Starting is a person's yes to act: one that only watches is its owner's to start, not an assistant's.
    if (by.actor === 'agent' && automation.mode !== 'act') throw new RunRefusal('It only watches: its owner lets it act before an assistant may start it');
    return this.#start(automation, { asker: by, from: null }).begun;
  }

  /**
   * Starts a run — played by a person or an assistant for one, or started by
   * a step of another automation's run (`from`) — for real, whatever its
   * mode: its `if` is looked at, then its steps. Refused when it is off,
   * already running, already in the chain that would start it, or at the
   * end of a chain as long as chains go. `begun`: the run as it stands once
   * it has begun; `ended`: as it came out.
   */
  #start(automation: AutomationRecord, how: { asker: Asker | null; from: LiveRun | null }): { begun: Promise<RunResult>; ended: Promise<RunResult> } {
    if (automation.mode === 'off') throw new RunRefusal('It is off: turn it on to start it');
    if (this.#running.has(automation.id)) throw new RunRefusal('It is already running');
    const chain = how.from ? [...how.from.chain, how.from.automation.id] : [];
    if (chain.includes(automation.id)) throw new RunRefusal('It is already in this chain: started again, it would start itself');
    if (chain.length >= CHAIN_LIMIT) throw new RunRefusal(`A chain of automations goes ${CHAIN_LIMIT} deep at most`);

    let begun!: (run: RunResult) => void;
    let failed!: (error: unknown) => void;
    const started = new Promise<RunResult>((resolve, reject) => ((begun = resolve), (failed = reject)));
    this.#running.add(automation.id);
    const why = how.from ? `Started by “${how.from.automation.name}”` : `Started by ${how.asker!.name}`;
    const ended = this.run(automation, { why, askedBy: how.asker, from: how.from, chain, onBegun: (run) => begun(run) })
      .then(
        (run) => (begun(run), run),
        (error: unknown) => {
          // Before it began, the one who asked is told; after, it is said here.
          console.error(`[automations] ${automation.id} could not run:`, error);
          failed(error);
          throw error;
        }
      )
      .finally(() => this.#running.delete(automation.id));
    // Nobody may wait on its end: what went wrong is already said.
    ended.catch(() => undefined);
    return { begun: started, ended };
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
  #scope(automation: AutomationRecord, rule: Rule, now = this.#now()): RuleScope {
    const part = (role: string): EngineDevice | null => {
      const binding = automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      return device && !device.removed ? device : null;
    };
    return {
      clock: () => clockTime(now, automation.timeZone),
      // An automation's own rule has no settings: its values are in its blocks. A recipe's are its defaults.
      param: (name) => {
        const field = rule.params.fields[name];
        return ((field && 'default' in field ? field.default : undefined) ?? null) as Value;
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
        return device ? device.reachable() : { reachable: false, detail: `${rule.roles[role]?.label ?? role}: no device` };
      },
      call: async (id, role, args) => {
        const fn = this.deps.library.fn(id);
        const device = part(role);
        if (!fn) return { value: null, detail: `No installed package offers ${id}` };
        if (!device) return { value: null, detail: `${rule.roles[role]?.label ?? role}: no device` };
        return fn.evaluate({ part: device, args, now, timeZone: automation.timeZone });
      },
      name: (role) => {
        const started = automation.starts[role];
        if (started) return quoted(this.deps.store.get(started)?.name ?? null);
        return part(role)?.name ?? 'a device you no longer have';
      },
    };
  }

  /**
   * What its words need: the installed functions, and — its roles filled —
   * each setting a step changes as its device names it ("Live readings").
   */
  #vocabulary(automation: AutomationRecord): RuleVocabulary {
    return {
      fn: (id) => this.deps.library.fn(id),
      attribute: (role, target) => {
        const binding = automation.roles[role];
        const device = binding ? this.deps.device(binding) : null;
        return device ? writtenAttribute(device.description, binding!.part, target) : null;
      },
    };
  }

  /** Its settings as a sentence reads them: each one's value, or its default. */
  #settled(automation: AutomationRecord, rule: Rule): Record<string, Value> {
    const scope = this.#scope(automation, rule);
    return Object.fromEntries(Object.keys(rule.params.fields).map((key) => [key, scope.param(key)]));
  }

  /** A condition in words, its settings filled in: "Garage station's charge is at least 50 %". */
  #said(automation: AutomationRecord, rule: Rule, expr: Expr): string {
    const scope = this.#scope(automation, rule);
    return describeExpr(rule, expr, this.#settled(automation, rule), (role) => scope.name(role), this.#vocabulary(automation));
  }

  /** Its steps in words, numbered and nested, as its card shows them. */
  steps(automation: AutomationRecord): { steps: StepLine[]; otherwise: StepLine[] } {
    const rule = automation.rule;
    const scope = this.#scope(automation, rule);
    return describeSteps(rule, this.#settled(automation, rule), (role) => scope.name(role), this.#vocabulary(automation));
  }

  /**
   * Each condition an automation waits for, as it stands at `at`, and what it
   * read to say so: how a run explains itself, and what its card shows now.
   */
  judge(automation: AutomationRecord, at = this.#now()): { conditions: ConditionState[]; saw: string[] } {
    const rule = automation.rule;
    const scope = this.#scope(automation, rule, at);
    const saw: string[] = [];
    const conditions = rule.when.flatMap((trigger): ConditionState[] => {
      if (!('becomes' in trigger)) return [];
      const holds = evaluateNow(trigger.becomes, scope, saw);
      const minutes = trigger.heldForMinutes ? Number(evaluateNow(trigger.heldForMinutes, scope)) : 0;
      const text = `${capitalise(this.#said(automation, rule, trigger.becomes))}${minutes > 0 ? ` for ${minutes} min` : ''}`;
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
   * every step, and `onBegun` is given it once it has begun. `askedBy`: who
   * asked for it; none, its own triggers started it.
   */
  async run(
    automation: AutomationRecord,
    options: {
      check?: boolean;
      why?: string;
      askedBy?: Asker | null;
      /** The run whose step started it, in a chain; and the automations already in that chain. */
      from?: LiveRun | null;
      chain?: readonly AutomationId[];
      onBegun?: (run: RunResult) => void;
    } = {}
  ): Promise<RunResult> {
    const at = this.#now();
    const rule = automation.rule;
    const why = options.why ?? (options.check ? 'Asked what it would do now' : 'As it was set up to');
    const judged = this.judge(automation, at);
    const from = options.from ?? null;
    const run: RunResult = {
      id: null,
      at: at.toISOString(),
      endedAt: null,
      startedBy: options.askedBy?.name ?? null,
      startedByRun: from && from.run.id ? { id: from.run.id, automationId: from.automation.id, name: from.automation.name } : null,
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
        if (run.id) this.#note(automation, run, device);
      }
      return run;
    };

    const problems = this.roleProblems(automation);
    if (problems.length) return over('unknown', problems.join('; '));

    const scope = this.#scope(automation, rule, at);
    try {
      if (rule.if) {
        const trace: string[] = [];
        const condition = await evaluate(rule.if, scope, trace);
        run.saw = [...new Set([...run.saw, ...trace])];
        // In the words of what it asked — "Tomorrow looks cloudy: 90 % cloud" — or, with none, the condition's own.
        const said = trace.join('; ');
        if (condition === null) return over('unknown', said || `Could not tell whether ${this.#said(automation, rule, rule.if)}`);
        if (condition !== true) return over('idle', said || `Not now: it is not so that ${this.#said(automation, rule, rule.if)}`);
      }
    } catch (error) {
      return over('failed', `Could not decide: ${(error as Error).message}`);
    }

    // It acts when it is let act — or when a person played it, or another automation's run started it: the
    // mode says what it does on its own, not what it does when asked. Only asked what it would do, or only
    // watching on its own: what it would do, said once — why it did not act is the run's own why and outcome.
    const acts = !options.check && (automation.mode === 'act' || Boolean(options.askedBy) || from !== null);
    if (!acts) {
      const steps = await this.#wouldDo(automation, rule, scope);
      if ('unknown' in steps) return over('unknown', `Could not tell what to send ${steps.unknown}`);
      const said = steps.filter((step) => step.depth === 0).map((step) => `${lowerFirst(step.what)}${step.outcome === 'already' ? ' (already so)' : ''}`);
      return over('would-act', `Would ${said.join(', then ')}`, steps, actsOn(automation, rule));
    }

    // Automations take turns with a part: one a run of another chain holds is not changed under it, and this
    // run does nothing rather than wait — what starts it starts it again (docs/SHARED-PARTS-AND-RESERVE.md).
    const holds = new Map(
      changedRoles(rule).flatMap((role): [string, string][] => {
        const binding = automation.roles[role];
        return binding ? [[`${binding.device}:${binding.part}`, scope.name(role)]] : [];
      })
    );
    const root = from?.root ?? Symbol(automation.id);
    for (const other of [...this.#live.values(), ...this.#once.values()]) {
      if (other.root === root) continue;
      const shared = [...holds.keys()].find((key) => other.holds.has(key));
      if (shared) return over('refused', `${capitalise(holds.get(shared)!)} is in use by ${quoted(other.automation.name)}, running now`, [], actsOn(automation, rule));
    }

    // Acting: step by step, through the gateway, as an automation — kept and said as it goes when it takes steps.
    const live: LiveRun = {
      id: '',
      automation,
      rule,
      run,
      asker: options.askedBy ?? null,
      chain: options.chain ?? [],
      root,
      holds,
      stoppedBy: null,
      gone: false,
      wake: new Set(),
      allowance: this.#allowance(rule, scope),
      changedAt: 0,
      changedOrder: 0,
      heard: new Map(),
      log: null,
    };
    const stepped = takesSteps(rule);
    if (stepped) {
      run.summary = 'Running';
      live.id = run.id = this.deps.store.beginRun(automation.id, run);
      this.#live.set(automation.id, live);
      live.log = this.#listen(live);
      this.#moved(live);
    } else {
      live.id = `once-${automation.id}-${at.getTime()}`;
      this.#once.set(automation.id, live);
    }
    options.onBegun?.(run);

    let walked: Walked;
    try {
      walked = await this.#walk(live, rule.then, 0, null, 'then');
      if (walked !== 'ok' && rule.otherwise?.length) {
        await this.#walk(live, rule.otherwise, 0, walked === 'stopped' ? `After it was stopped by ${live.stoppedBy}` : 'After a step did not succeed', 'otherwise');
      }
    } catch (error) {
      walked = 'failed';
      this.#add(live, { kind: 'command', depth: 0, within: null, what: 'The run itself', outcome: 'failed', detail: (error as Error).message, until: null });
    }
    // It switches nothing more: the gateway lets go of what it counted for it.
    this.deps.gateway.runEnded(live.id);
    live.log?.stop();

    const top = run.steps;
    const refused = top.some((step) => step.outcome === 'refused');
    const unverified = top.some((step) => step.outcome === 'unverified');
    run.outcome = walked === 'stopped' ? 'stopped' : walked === 'failed' ? (refused && !top.some((step) => step.outcome === 'timed-out' || step.outcome === 'failed') ? 'refused' : 'failed') : unverified ? 'unverified' : 'acted';
    run.summary = this.#summaryOf(live, walked);
    run.endedAt = this.#now().toISOString();
    const device = actsOn(automation, rule);
    if (stepped) {
      this.#live.delete(automation.id);
      if (!live.gone) {
        this.deps.store.endRun(live.id, run);
        this.#note(automation, run, device);
      }
      this.deps.bus?.publish({ kind: 'automation', automationId: automation.id });
    } else {
      this.#once.delete(automation.id);
      // Deleted while it ran, told or not: its runs went with it, and so does this one.
      run.id = live.gone ? null : this.deps.store.ran(automation.id, run);
      if (run.id) this.#note(automation, run, device);
    }
    if (live.gone) run.id = null;
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
  #allowance(rule: Rule, scope: RuleScope): Record<string, number> {
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
    count(rule.then, 1);
    count(rule.otherwise ?? [], 1);
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
    const scope = () => this.#scope(live.automation, live.rule);
    const stopping = () => live.stoppedBy !== null && mode !== 'otherwise';
    let result: Walked = 'ok';
    for (const step of steps) {
      if (stopping()) return 'stopped';
      const kind = stepKind(step);
      let walked: Walked = 'ok';
      /** The step in words, as its plan shows it. */
      const what = () => describeSteps({ ...live.rule, then: [step], otherwise: [] }, this.#settled(live.automation, live.rule), (role) => scope().name(role), this.#vocabulary(live.automation)).steps[0]!.text;
      // A choice its owner already made is no step of its own: the steps it chose are taken in its place.
      const chosen = 'choose' in step ? settledChoice(live.rule, step, this.#settled(live.automation, live.rule)) : null;

      if (chosen) {
        walked = await this.#walk(live, chosen, depth, within, mode);
      } else if ('command' in step) {
        walked = await this.#command(live, step.command, depth, within, mode === 'otherwise');
      } else if ('write' in step) {
        walked = await this.#write(live, step.write, depth, within, what());
      } else if ('start' in step) {
        walked = await this.#startStep(live, step.start, depth, within, what(), mode);
      } else if ('wait' in step) {
        const seconds = this.#seconds(step.wait.seconds, scope(), 3_600) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: `For ${secondsText(seconds)}`, until: this.#after(seconds) });
        const woke = await this.#sleep(live, seconds, mode === 'otherwise');
        if (woke === 'stopped') {
          this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
          walked = 'stopped';
        } else this.#end(live, entry, 'done', `Waited ${secondsText(seconds)}`);
      } else if ('waitUntil' in step) {
        const seconds = this.#seconds(step.waitUntil.atMostSeconds, scope(), 3_600) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: 'Waiting', until: this.#after(seconds) });
        const came = await this.#until(live, step.waitUntil.condition, seconds);
        if (came.outcome === 'met') this.#end(live, entry, 'met', `${came.seconds < 1 ? 'At once' : `After ${secondsText(came.seconds)}`}${came.saw ? ` — ${came.saw}` : ''}`);
        else if (came.outcome === 'stopped') (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`), (walked = 'stopped'));
        else (this.#end(live, entry, 'timed-out', `Not in ${secondsText(seconds)}${came.saw ? ` — ${came.saw}` : ''}`), (walked = 'failed'));
      } else if ('ensure' in step) {
        const { condition, withinSeconds, tries: triesExpr, retry } = step.ensure;
        const seconds = this.#seconds(withinSeconds, scope(), 600) ?? 1;
        const triesValue = evaluateNow(triesExpr, scope());
        const tries = typeof triesValue === 'number' ? Math.max(0, Math.min(10, Math.floor(triesValue))) : 0;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: 'Watching', until: this.#after(seconds) });
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
        this.#add(live, { kind, depth, within, what: what(), outcome: 'done', detail: `${holds === true ? 'It is so' : holds === false ? 'It is not so' : 'It cannot be told, so taken as not so'}${trace.length ? ` — ${trace.join('; ')}` : ''}`, until: null });
        walked = await this.#walk(live, branch, depth + 1, holds === true ? 'Then' : 'Otherwise', mode);
      } else {
        const seconds = this.#seconds(step.watch.seconds, scope(), 3_600) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: 'Watching', until: this.#after(seconds) });
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
  async #command(live: LiveRun, command: Command, depth: number, within: string | null, regardless: boolean): Promise<Walked> {
    const scope = this.#scope(live.automation, live.rule);
    const planned = await this.#planCommand(live.automation, command, scope);
    if ('unknown' in planned) {
      this.#add(live, { kind: 'command', depth, within, what: `Send ${planned.unknown}`, outcome: 'failed', detail: 'Could not tell what to send', until: null });
      return 'failed';
    }
    const entry = this.#add(live, { kind: 'command', depth, within, what: capitalise(planned.what), outcome: 'waiting', detail: 'Sending', until: null });
    // Why, and what it read to decide: what the device's timeline says the command was for.
    const saw = live.run.saw;
    const reason = `${live.automation.name}: ${live.run.why}${saw.length ? ` (${saw.join('; ')})` : ''}`;
    const send = async (): Promise<GatewayResult> => {
      try {
        return await this.deps.gateway.execute({
          deviceId: planned.binding.device,
          part: planned.binding.part,
          capability: planned.capability,
          command: planned.command,
          args: planned.args,
          reason,
          actor: 'automation',
          by: actorOf(live.automation),
          run: { id: live.id, askedBy: live.asker?.actor ?? null, switches: live.allowance[planned.role] ?? 1 },
        });
      } catch (error) {
        return { outcome: 'failed', detail: (error as Error).message };
      }
    };
    let outcome = await send();
    /*
      Switched a moment ago in this run: the gateway's gap is waited out, and
      it is sent once more — a plug to be switched off after a stop that came
      just after it was switched on is still switched off, not left on.
    */
    if (outcome.outcome === 'refused' && outcome.retryInMs !== undefined) {
      const seconds = Math.ceil(outcome.retryInMs / 1000);
      Object.assign(entry, { detail: `Waiting ${secondsText(seconds)}: it was switched a moment ago`, until: this.#after(seconds) });
      this.#moved(live);
      if ((await this.#sleep(live, seconds, regardless)) === 'stopped') {
        this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
        return 'stopped';
      }
      outcome = await send();
    }
    const already = outcome.outcome === 'verified' && outcome.detail.startsWith('Already');
    if (!already && (outcome.outcome === 'verified' || outcome.outcome === 'unverified')) this.#changed(live);
    // What the switch left — the device's own readback — is in the log as it was then.
    live.log?.look();
    this.#end(live, entry, already ? 'already' : outcome.outcome === 'verified' ? 'done' : outcome.outcome, outcome.detail);
    // Unverified is sent, and the step goes on: what follows may be what proves it — a charger that draws.
    return outcome.outcome === 'refused' || outcome.outcome === 'failed' ? 'failed' : 'ok';
  }

  /**
   * A setting changed: through the gateway's write path, read back as any
   * setting is — and not written at all when the part already reads it, so
   * a setting's own dwell is not spent on what is already so.
   */
  async #write(live: LiveRun, write: Write, depth: number, within: string | null, what: string): Promise<Walked> {
    const value = await evaluate(write.value, this.#scope(live.automation, live.rule), []).catch(() => null);
    const binding = live.automation.roles[write.role];
    const device = binding ? this.deps.device(binding) : null;
    const entry = this.#add(live, { kind: 'write', depth, within, what, outcome: 'waiting', detail: 'Setting', until: null });
    if (!binding || !device || device.removed) {
      this.#end(live, entry, 'failed', `${live.rule.roles[write.role]?.label ?? write.role}: no device`);
      return 'failed';
    }
    if (value === null) {
      this.#end(live, entry, 'failed', 'Could not tell what to set it to');
      return 'failed';
    }
    // By its key, or by what it means: the setting of this part that has the meaning.
    const key = this.#settingKey(binding, write);
    if (!key) {
      this.#end(live, entry, 'failed', `${device.name} has no such setting`);
      return 'failed';
    }
    const reading = device.device ? readingOf(device.device.readings(), key) : null;
    if (reading && String(reading.value) === String(value)) {
      this.#end(live, entry, 'already', 'It already was');
      return 'ok';
    }
    let result: WriteResult;
    try {
      result = await this.deps.gateway.write({ deviceId: binding.device, patch: { [key]: value }, actor: 'automation', by: actorOf(live.automation) });
    } catch (error) {
      result = { outcome: 'failed', detail: (error as Error).message };
    }
    if (result.outcome === 'verified' || result.outcome === 'unverified') this.#changed(live);
    this.#end(live, entry, result.outcome === 'verified' ? 'done' : result.outcome, result.detail);
    return result.outcome === 'refused' || result.outcome === 'failed' ? 'failed' : 'ok';
  }

  /**
   * Another automation started, as a person's play would, asked by whoever
   * asked for this run. With a wait: until its run ends — done if it acted —
   * or the wait runs out; a stop here stops it too.
   */
  async #startStep(
    live: LiveRun,
    start: Extract<Step, { start: unknown }>['start'],
    depth: number,
    within: string | null,
    what: string,
    mode: 'then' | 'retry' | 'otherwise'
  ): Promise<Walked> {
    const seconds = start.waitSeconds ? (this.#seconds(start.waitSeconds, this.#scope(live.automation, live.rule), 3_600) ?? 1) : null;
    const entry = this.#add(live, { kind: 'start', depth, within, what, outcome: 'waiting', detail: 'Starting', until: seconds ? this.#after(seconds) : null });
    const target = live.automation.starts[start.role];
    const automation = target ? this.deps.store.get(target) : null;
    if (!automation) {
      this.#end(live, entry, 'failed', 'There is no automation to start: it was deleted');
      return 'failed';
    }
    let started: { begun: Promise<RunResult>; ended: Promise<RunResult> };
    try {
      started = this.#start(automation, { asker: live.asker, from: live });
    } catch (error) {
      if (!(error instanceof RunRefusal)) throw error;
      this.#end(live, entry, 'refused', error.message);
      return 'failed';
    }
    const begun = await started.begun.catch(() => null);
    if (!begun) {
      this.#end(live, entry, 'failed', 'It could not start');
      return 'failed';
    }
    if (seconds === null) {
      this.#end(live, entry, 'done', 'Started');
      return 'ok';
    }
    this.#moved(live);
    const came = await Promise.race([started.ended.then((run) => ({ run })).catch(() => null), this.#sleep(live, seconds, mode === 'otherwise').then((slept) => ({ slept }))]);
    if (came && 'run' in came) {
      const acted = came.run.outcome === 'acted';
      this.#end(live, entry, acted ? 'done' : 'failed', `It ${acted ? 'ran' : 'did not succeed'}: ${lowerFirst(came.run.summary)}`);
      return acted ? 'ok' : 'failed';
    }
    // Stopped while it waits: what it waits on stops too. Or the wait ran out: it goes on, and this does not.
    const child = this.#live.get(automation.id);
    if (came && came.slept === 'stopped') {
      // Stopped by the run that started it: "Stopped by “Morning” after it …".
      if (child) this.#stopLive(child, quoted(live.automation.name));
      this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
      return 'stopped';
    }
    this.#end(live, entry, 'timed-out', `It had not ended after ${secondsText(seconds)}`);
    return 'failed';
  }

  /** In a run's words, how it came out. */
  #summaryOf(live: LiveRun, walked: Walked): string {
    // What it did, and — from the first step of its `otherwise` on — what it did after.
    const split = live.run.steps.findIndex((step) => step.depth === 0 && step.within?.startsWith('After'));
    const steps = split < 0 ? live.run.steps : live.run.steps.slice(0, split);
    const later = split < 0 ? [] : live.run.steps.slice(split);
    const done = steps.filter((step) => ACTS.has(step.kind) && (step.outcome === 'done' || step.outcome === 'already' || step.outcome === 'unverified') && !step.within?.startsWith('Try'));
    // What it changed: what was already so is no deed of its own.
    const changed = done.filter((step) => step.outcome !== 'already').map((step) => lowerFirst(pastOf(step.what)));
    const made = steps.filter((step) => step.kind === 'ensure' && step.outcome === 'met').map((step) => step.detail);
    const afterwards = later.filter((step) => ACTS.has(step.kind) && (step.outcome === 'done' || step.outcome === 'already'));
    const then = afterwards.length ? `; then ${afterwards.map((step) => lowerFirst(pastOf(step.what))).join(', ')}` : '';
    if (walked === 'stopped') return `Stopped by ${live.stoppedBy}${changed.length ? ` after it ${changed.join(', ')}` : ''}${then}`;
    if (walked === 'failed') {
      const failing = steps.find((step) => step.depth === 0 && (step.outcome === 'timed-out' || step.outcome === 'failed' || step.outcome === 'refused')) ?? steps.find((step) => step.outcome === 'failed' || step.outcome === 'refused');
      return `Did not succeed: ${failing ? `${lowerFirst(failing.what)} — ${lowerFirst(failing.detail)}` : 'a step did not'}${then}`;
    }
    // What changed leads; what was already so is said once; what it made sure of is said as the reading it saw.
    const sure = made.map((detail) => {
      const [when = '', saw] = detail.split(' — ');
      return saw ? `${saw}, ${lowerFirst(when)}` : lowerFirst(detail);
    });
    const parts = [...(changed.length ? [changed.join(', ')] : done.length ? ['all was already so'] : []), ...sure];
    return parts.length ? capitalise(parts.join('; ')) : 'Nothing needed doing';
  }

  /**
   * What it would do, each step as it would take it: its commands evaluated
   * as they stand now, and one already so said to be — as far as it can be
   * told before the steps before it have run.
   */
  async #wouldDo(automation: AutomationRecord, rule: Rule, scope: RuleScope): Promise<RunStep[] | { unknown: string }> {
    const at = this.#now().toISOString();
    const settled = this.#settled(automation, rule);
    const steps: RunStep[] = [];
    const flatten = (line: StepLine, depth: number, within: string | null) => {
      steps.push({ kind: line.kind, depth, within, what: line.text, outcome: 'would', detail: '', at, endedAt: at, until: null });
      for (const branch of line.branches) for (const inner of branch.steps) flatten(inner, depth + 1, branch.label);
    };
    const visit = async (list: readonly Step[]): Promise<{ unknown: string } | null> => {
      for (const step of list) {
        // A choice its owner already made: the steps it chose, in its place.
        const chosen = 'choose' in step ? settledChoice(rule, step, settled) : null;
        if (chosen) {
          const unknown = await visit(chosen);
          if (unknown) return unknown;
        } else if ('command' in step) {
          const planned = await this.#planCommand(automation, step.command, scope);
          if ('unknown' in planned) return planned;
          const already = this.#alreadySo(planned);
          steps.push({ kind: 'command', depth: 0, within: null, what: capitalise(planned.what), outcome: already ? 'already' : 'would', detail: already ? 'It is so now' : '', at, endedAt: at, until: null });
        } else if ('write' in step) {
          // A setting: already so when the part reads what it would be set to.
          const what = describeSteps({ ...rule, then: [step], otherwise: [] }, settled, (role) => scope.name(role), this.#vocabulary(automation)).steps[0]!.text;
          const value = await evaluate(step.write.value, scope, []).catch(() => null);
          const binding = automation.roles[step.write.role];
          const reader = binding ? this.deps.device(binding)?.device : null;
          const key = binding ? this.#settingKey(binding, step.write) : null;
          const reading = reader && key ? readingOf(reader.readings(), key) : null;
          const already = value !== null && reading !== null && String(reading.value) === String(value);
          steps.push({ kind: 'write', depth: 0, within: null, what, outcome: already ? 'already' : 'would', detail: already ? 'It is so now' : '', at, endedAt: at, until: null });
        } else {
          for (const line of describeSteps({ ...rule, then: [step], otherwise: [] }, settled, (role) => scope.name(role), this.#vocabulary(automation)).steps) flatten(line, 0, null);
        }
      }
      return null;
    };
    return (await visit(rule.then)) ?? steps;
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
    const { reads, reaches } = ruleUses({ ...live.rule, when: [], then: [{ waitUntil: { condition, atMostSeconds: { value: 1 } } }], otherwise: [] });
    const until = Date.now() + seconds * 1000 + 5_000;
    for (const role of new Set([...reads.map((read) => read.role), ...reaches])) {
      const binding = live.automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      device?.wantFresh(until);
    }
  }

  /**
   * Keeps the run's log (docs/SEQUENCES.md): the devices and roles it uses as
   * it begins; then every reading of each device each time its value or time
   * changes — what the value is, the first time one is seen — and whether
   * each can be reached, each time that changes. Heard as each device says
   * it, on the live bus: a reading a step acts on is in the log at the moment
   * it came, not at the next look. Looked at every second as well, and once
   * more as it ends — for a reading said again at a new time, and a device
   * that does not say. Returns what ends it.
   */
  #listen(live: LiveRun): { look: () => void; stop: () => void } {
    const devices = new Map<string, EngineDevice>();
    const roles: RunLogRole[] = [];
    // In the rule's order of its roles: what it uses first, first.
    for (const role of Object.keys(live.rule.roles)) {
      const binding = live.automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      if (!binding) continue;
      if (!device) continue;
      if (!devices.has(binding.device)) devices.set(binding.device, device);
      roles.push({ role, label: live.rule.roles[role]?.label ?? role, device: binding.device, part: binding.part });
    }
    const keep = (log: Parameters<AutomationStorage['recordLog']>[1]) => {
      try {
        this.deps.store.recordLog(live.id, log);
      } catch (error) {
        // Its automation deleted while it ran: its run, and its log, are gone with it — that, and only that, is expected.
        if (live.gone || !this.deps.store.get(live.automation.id)) return;
        console.error(`[automations] the log of a run of "${live.automation.name}" could not be kept: ${(error as Error).message}`);
      }
    };
    keep({ devices: [...devices].map(([id, device]) => ({ id, name: device.deviceName, typeId: device.typeId })), roles });

    const described = new Set<string>();
    const last = new Map<string, string>();
    let kept = 0;
    /** What one device says now — some of its readings, or all — and whether it can be reached: what is new of it, kept. */
    const hear = (id: string, device: EngineDevice, readings: readonly Reading[], reachable: { reachable: boolean; detail: string } | null) => {
      const heardAt = this.#now().toISOString();
      const log: { keys: RunLogKey[]; readings: RunLogReading[]; reach: RunLogReach[] } = { keys: [], readings: [], reach: [] };
      if (reachable) {
        const said = `${reachable.reachable} ${reachable.detail}`;
        if (last.get(id) !== said) {
          last.set(id, said);
          log.reach.push({ device: id, at: heardAt, reachable: reachable.reachable, detail: reachable.detail });
        }
      }
      for (const reading of readings) {
        const mark = `${reading.at} ${JSON.stringify(reading.value)}`;
        const which = `${id} ${reading.key}`;
        if (last.get(which) === mark) continue;
        last.set(which, mark);
        // Heard now, in the order of what happens here: what a wait judges by, whatever the device stamped.
        live.heard.set(which, ++this.#order);
        if (kept >= READINGS_PER_RUN) continue;
        if (!described.has(which)) {
          described.add(which);
          log.keys.push(logKeyOf(id, reading.key, device.description));
        }
        kept += 1;
        log.readings.push({ device: id, key: reading.key, at: reading.at, heardAt, value: reading.value });
      }
      keep(log);
    };
    const look = () => {
      for (const [id, device] of devices) hear(id, device, device.device?.readings() ?? [], device.reachable());
    };
    look();
    // As each device says it.
    const unsubscribe = this.deps.bus?.subscribe((message) => {
      if (message.kind !== 'readings' && message.kind !== 'health') return;
      const device = devices.get(message.deviceId);
      if (!device) return;
      if (message.kind === 'readings') hear(message.deviceId, device, message.readings, null);
      else hear(message.deviceId, device, [], device.reachable());
    });
    const timer = setInterval(look, LOOK_EVERY_SECONDS * (this.deps.secondMs ?? 1000));
    return {
      look,
      stop: () => {
        clearInterval(timer);
        unsubscribe?.();
        look();
      },
    };
  }

  /** One of an automation's runs with its log; null when the run is not one of its. */
  runLog(automation: Pick<AutomationRecord, 'id'>, runId: string): RunLog | null {
    const log = this.deps.store.runLog(automation.id, runId);
    return log ? { ...log, capped: log.readings.length >= READINGS_PER_RUN } : null;
  }

  /** A run changed something — switched a part, changed a setting: what it judges after is judged on what it hears after. */
  #changed(live: LiveRun): void {
    live.changedAt = Date.now();
    live.changedOrder = ++this.#order;
  }

  /**
   * Whether every reading a condition reads was taken since the run last
   * changed something — and every device it asks can be reached has been
   * heard from since. A reading from before says how things were, not how
   * they are now: judged on, a supply still giving 190 W a moment after the
   * charger on it was switched off reads as "something else draws".
   */
  #readSince(live: LiveRun, condition: Expr): boolean {
    if (!live.changedAt) return true;
    const { reads, reaches } = ruleUses({ ...live.rule, when: [], then: [{ waitUntil: { condition, atMostSeconds: { value: 1 } } }], otherwise: [] });
    /*
      Whether it can be reached, likewise: only once something has been heard
      from it since. Its connection's word alone is not enough — a device
      that lost its power with the run's last change (a plug, and the gateway
      it is reached through, on the outlets just switched) keeps a connection
      that looks open for a while, and a command sent into it is lost.
    */
    const heardFrom = (device: string): number | null => {
      const times = [...live.heard].filter(([which]) => which.startsWith(`${device} `)).map(([, at]) => at);
      return times.length ? Math.max(...times) : null;
    };
    const reachedSince = reaches.every((role) => {
      const binding = live.automation.roles[role];
      const heard = binding ? heardFrom(binding.device) : null;
      // One that says nothing at all is judged by its connection, as it is.
      return heard === null || heard > live.changedOrder;
    });
    if (!reachedSince) return false;
    return reads.every(({ role, means }) => {
      const binding = live.automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      const attribute = device ? attributeMeaning(device.description, device.part, means) : null;
      const reading = device?.device && attribute ? readingOf(device.device.readings(), attribute.key) : null;
      // Nothing to wait for: what cannot be read is judged as it is.
      if (!reading) return true;
      // Heard after the change, by the order of what happens here; the reading's own time only when the run has not heard it.
      const heard = live.heard.get(`${binding!.device} ${reading.key}`);
      return heard !== undefined ? heard > live.changedOrder : Date.parse(reading.at) >= live.changedAt;
    });
  }

  /** Waits until a condition is true, looking every second: at most `seconds`, or until the run is stopped. */
  async #until(live: LiveRun, condition: Expr, seconds: number): Promise<{ outcome: 'met' | 'timed-out' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, condition, seconds);
    const started = Date.now();
    const unit = this.deps.secondMs ?? 1000;
    for (;;) {
      const saw: string[] = [];
      // Met only on readings taken since the run last changed something.
      const holds = this.#readSince(live, condition) ? evaluateNow(condition, this.#scope(live.automation, live.rule), saw) : null;
      const elapsed = (Date.now() - started) / unit;
      // What it judged on is in the log, as it was when it judged: the same readings, read at once.
      live.log?.look();
      if (holds === true) return { outcome: 'met', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if (live.stoppedBy !== null) return { outcome: 'stopped', seconds: elapsed, saw: '' };
      if (elapsed >= seconds) return { outcome: 'timed-out', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if ((await this.#sleep(live, Math.min(LOOK_EVERY_SECONDS, seconds - elapsed), false)) === 'stopped') return { outcome: 'stopped', seconds: elapsed, saw: '' };
    }
  }

  /** Watches a condition for `seconds`: held if it is true every time it is looked at; not, the moment it is not — or cannot be told. */
  async #hold(live: LiveRun, condition: Expr, seconds: number, regardless: boolean): Promise<{ outcome: 'held' | 'broke' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, condition, seconds + SETTLE_AT_MOST_SECONDS);
    const unit = this.deps.secondMs ?? 1000;
    // Watched from the first readings taken since the run last changed something — or, if none come, from when it gave up waiting for them.
    const settling = Date.now();
    while (!this.#readSince(live, condition) && (Date.now() - settling) / unit < SETTLE_AT_MOST_SECONDS) {
      if ((await this.#sleep(live, LOOK_EVERY_SECONDS, regardless)) === 'stopped') return { outcome: 'stopped', seconds: 0, saw: '' };
    }
    const started = Date.now();
    for (;;) {
      const saw: string[] = [];
      const holds = evaluateNow(condition, this.#scope(live.automation, live.rule), saw);
      const elapsed = (Date.now() - started) / unit;
      live.log?.look();
      if (holds !== true) return { outcome: 'broke', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if (elapsed >= seconds) return { outcome: 'held', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if ((await this.#sleep(live, Math.min(LOOK_EVERY_SECONDS, seconds - elapsed), regardless)) === 'stopped') return { outcome: 'stopped', seconds: elapsed, saw: '' };
    }
  }

  /**
   * Why an automation cannot run as its roles are filled: a removed device, a
   * part that no longer fits, a meaning it does not report, a setting it
   * cannot change — or an automation to start that is gone.
   */
  roleProblems(automation: Pick<AutomationRecord, 'rule' | 'roles' | 'starts'>): string[] {
    const rule = automation.rule;
    const removed = partRoles(rule).flatMap(([role, spec]) => {
      const binding = automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      return device?.removed ? [`${spec.label}: ${device.name} has been removed`] : [];
    });
    if (removed.length) return removed;
    const nothingToStart = Object.entries(rule.roles)
      .filter(([role, spec]) => isAutomationRole(spec) && !(automation.starts[role] && this.deps.store.get(automation.starts[role]!)))
      .map(([, spec]) => `${spec.label}: nothing to start — the automation it started is gone`);
    return [
      ...nothingToStart,
      ...checkBinding(rule, (role): BoundPart | null => {
        const binding = automation.roles[role];
        const device = binding ? this.deps.device(binding) : null;
        return device ? { name: device.name, description: device.description, part: device.part, capabilities: device.hasPart ? device.capabilities : [] } : null;
      }),
    ];
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/**
 * A value a run's log keeps, as its device describes it: its part and label
 * — "AC outlets: Power" for a part's — and its kind, unit, quantity and words.
 * A key the description does not name is text, called by its key.
 */
export function logKeyOf(device: string, key: string, description: DeviceDescription): RunLogKey {
  const attribute = description.attributes.find((candidate) => candidate.key === key);
  if (!attribute) return { device, key, part: MAIN_PART, label: key, kind: 'text', unit: null, quantity: null, words: null, options: null };
  const part = attribute.part ?? MAIN_PART;
  const partLabel = part === MAIN_PART ? null : (description.parts ?? []).find((each) => each.id === part)?.label;
  // Its part named once: "AC outlets draw" says its part already, "Power" does not.
  const label = partLabel && !attribute.label.toLowerCase().startsWith(partLabel.toLowerCase()) ? `${partLabel}: ${attribute.label}` : attribute.label;
  const type = attribute.value;
  if (type.type === 'number') return { device, key, part, label, kind: 'number', unit: unitOf(attribute) || null, quantity: quantityOf(attribute), words: null, options: null };
  if (type.type === 'boolean') return { device, key, part, label, kind: 'boolean', unit: null, quantity: null, words: type.words ?? null, options: null };
  if (type.type === 'enum') return { device, key, part, label, kind: 'enum', unit: null, quantity: null, words: null, options: [...type.options] };
  return { device, key, part, label, kind: 'text', unit: null, quantity: null, words: null, options: null };
}

/** The device a run is about on the timeline: the one its first command acts on. */
const actsOn = (automation: AutomationRecord, rule: Rule): string | undefined => {
  const first = ruleCommands(rule)[0];
  return first ? automation.roles[first.role]?.device : undefined;
};

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
/** The steps that do something to the world — what a run's summary says it did. */
const ACTS: ReadonlySet<string> = new Set(['command', 'write', 'start']);
/** An automation as a step names it: “Charge the scooter” — or one that is gone. */
export const quoted = (name: string | null): string => (name === null ? 'an automation you no longer have' : `“${name}”`);
/** A step as done: "Turned Heater plug off", "Set Scooter plug’s Live readings to on", "Started “Charge the scooter”"; anything else, "Sent …". */
const pastOf = (what: string) =>
  /^turn /i.test(what) ? `Turned ${what.slice(5)}` : /^set /i.test(what) ? `Set ${what.slice(4)}` : /^start /i.test(what) ? `Started ${what.slice(6).replace(/ and wait until it ends.*$/, '')}` : `Sent ${lowerFirst(what)}`;
