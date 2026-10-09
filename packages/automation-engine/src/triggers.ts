import {
  ANYONE,
  bindingsOf,
  capitalise,
  describeTriggers,
  edgeOf,
  changeSeen,
  evaluateNow,
  secondsNow,
  EVERY_SECONDS,
  HOLD_SECONDS,
  OWN_HOME,
  readsRole,
  ruleUses,
  runsOn,
  secondsText,
  SEQUENCE_LIMITS,
  slotOf,
  START_SECONDS,
  stepsOf,
  takesSteps,
  triggerKey,
  triggerKind,
  triggerSpec,
  type Expr,
  type RuleTrigger,
  type Rule,
  type Trigger,
} from '@kraftverk/automation';
import { dayAfter, localTime, MAIN_PART, SYSTEM, zonedInstant, type ClockTimer, type Unit, type Value } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';

import type { RuleContext } from './context.ts';
import { type AutomationEngineDeps, type AutomationRecord, type EnginePlace } from './model.ts';
import type { Runs } from './runs.ts';
import type { Seen, TriggerState } from './storage.ts';

/*
  When an automation starts on its own (docs/AUTOMATIONS.md): by the clock
  (`at`, `every`), when its device says an event happened, and when a
  condition becomes true — or has stayed true as long as it must — with each
  condition's state kept, so a restart neither loses a hold nor fires one
  twice. And keeping things so: a condition that still holds runs it again,
  unless what it would do is already so.
*/

/** Late, but not too late: a server that was down at 07:00 still acts at 07:20, not at 15:00. */
const GRACE_MS = 60 * 60_000;
/** A time a home's variable says is late by a look at most: one moved to a minute just past has not come. */
const VARIABLE_GRACE_MS = 60_000;

/** The triggers of people and places that are a change seen, not a state found: none fires for how things already are. */
const seenNotFound = (trigger: RuleTrigger): boolean => {
  const spec = triggerSpec(trigger);
  return spec.starts === 'edge' && spec.world;
};

export class Triggers {
  #ticking = false;
  /** Each `becomes` trigger's state, read once from the store, and its hold when one is waiting it out. */
  #becoming = new Map<string, { state: TriggerState; hold: ClockTimer | null }>();
  /** What each `changes` trigger last saw, read once from the store: a reading every few seconds is no query each. */
  #seen = new Map<string, Seen | null>();
  /** What waits to run as kraftverk started (`on start`): let go when it stops. */
  #starting = new Set<ClockTimer>();
  /** Which automations each device's messages concern, by store revision: not every automation for every reading. */
  #index: { revision: number; byDevice: Map<string, AutomationRecord[]> } | null = null;
  /** The automations the family's world moving concerns — someone arriving, a room emptying, a mode — by store revision. */
  #worldly: { revision: number; automations: AutomationRecord[] } | null = null;
  readonly #context: RuleContext;
  readonly #runs: Runs;

  constructor(
    private deps: AutomationEngineDeps,
    context: RuleContext,
    runs: Runs
  ) {
    this.#context = context;
    this.#runs = runs;
  }

  /**
   * Kraftverk started: each automation that waits for it, run once — so
   * long after as it says, devices back by then. Not again for one made or
   * changed later: a start is the process's, not an automation's.
   */
  started(): void {
    for (const automation of this.deps.store.list()) {
      if (automation.mode === 'off') continue;
      automation.rule.when.forEach((trigger, index) => {
        if (!('onStart' in trigger)) return;
        const seconds = secondsNow(trigger.onStart, this.#context.scope(automation, automation.rule));
        if (typeof seconds !== 'number' || seconds < START_SECONDS.min || seconds > START_SECONDS.max) return;
        const key = triggerKey(trigger, index);
        const timer = this.#context.clock.setTimeout(() => {
          this.#starting.delete(timer);
          const current = this.deps.store.get(automation.id);
          // Turned off since, or gone — or changed so this is no longer a trigger on start: nothing.
          if (!current || current.mode === 'off') return;
          const still = current.rule.when.findIndex((each, at) => triggerKey(each, at) === key);
          if (still < 0 || !('onStart' in current.rule.when[still]!)) return;
          void this.#runs.runAndKeep(current, seconds ? `Kraftverk started ${secondsText(seconds)} ago` : 'Kraftverk started', key).catch((error) => console.error(`[automations] ${automation.id} could not run as kraftverk started:`, error));
        }, seconds * 1000);
        this.#starting.add(timer);
      });
    }
  }

  /** Lets go of an automation's conditions, and the holds waiting them out: it is gone. */
  forget(automationId: string): void {
    this.#forgetSeen(automationId);
    for (const [key, entry] of this.#becoming) {
      if (!key.startsWith(`${automationId}:`)) continue;
      this.#context.clock.clear(entry.hold);
      this.#becoming.delete(key);
    }
  }

  /** Lets go of every condition and hold, and reads again what concerns each device: the automations were emptied beneath it. */
  /** What its `changes` triggers saw, let go of: read again from the store — or, started afresh, none. */
  #forgetSeen(automationId: string): void {
    for (const key of this.#seen.keys()) if (key.startsWith(`${automationId}:`)) this.#seen.delete(key);
  }

  clear(): void {
    this.#seen.clear();
    for (const timer of this.#starting) this.#context.clock.clear(timer);
    this.#starting.clear();
    for (const entry of this.#becoming.values()) this.#context.clock.clear(entry.hold);
    this.#becoming.clear();
    this.#index = null;
    this.#worldly = null;
  }

  /**
   * Forgets what an automation's conditions were: after it changed — its
   * settings, its parts, its mode — what it now watches starts afresh, and a
   * condition already true is its edge. Keeping things so starts afresh too:
   * its first look a whole interval from now.
   */
  reset(automationId: string): void {
    this.#forgetSeen(automationId);
    for (const [key, entry] of this.#becoming) {
      if (!key.startsWith(`${automationId}:`)) continue;
      this.#context.clock.clear(entry.hold);
      this.#becoming.delete(key);
    }
    this.deps.store.startAfresh(automationId, this.#context.now().toISOString());
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
      if (edgeOf(trigger)) this.#becomes(automation, automation.rule, trigger, index);
    });
  }

  /** The automations the family's world moving concerns: those that read who is where, a room, a mode — or wait for one. */
  #concerningWorld(): AutomationRecord[] {
    const revision = this.deps.store.revision;
    if (this.#worldly?.revision !== revision) this.#worldly = { revision, automations: this.deps.store.list().filter((automation) => ruleUses(automation.rule).world) };
    return this.#worldly.automations;
  }

  /** The automations a device's events and readings can start: bound to it, and with a trigger that listens. */
  #concerning(deviceId: string): AutomationRecord[] {
    const revision = this.deps.store.revision;
    if (this.#index?.revision !== revision) {
      const byDevice = new Map<string, AutomationRecord[]>();
      for (const automation of this.deps.store.list()) {
        if (!automation.rule.when.some((trigger) => 'event' in trigger || 'becomes' in trigger || 'changes' in trigger)) continue;
        // Every part it uses — each of a group's too: what it reads across a group moves it.
        for (const device of new Set(Object.keys(automation.rule.roles).flatMap((role) => bindingsOf(automation, role).map((binding) => binding.device)))) {
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
      const now = this.#context.now();
      for (const automation of this.deps.store.list()) {
        if (automation.mode === 'off') continue;
        const rule = automation.rule;
        const dueAt = rule.when.findIndex((trigger) => this.#due(automation, rule, trigger, now));
        const due = rule.when[dueAt];
        if (due) {
          // A run that takes steps goes on by itself: the clock does not wait for it.
          // Why, as the trigger reads: "Every day at 07:00", "At 07:00 on weekdays".
          const why = describeTriggers({ ...rule, when: [due] }, this.#context.settled(automation, rule), (role) => this.#context.scope(automation, rule, now).name(role), this.#context.vocabulary(automation))[0]!;
          const going = this.#runs.runAndKeep(automation, why, triggerKey(due, dueAt));
          if (!takesSteps(rule)) await going;
        }
        // A condition is looked at on the clock too, not only when a reading moves: a battery that sits
        // at 8 % sends nothing, and an automation just let act must still see it is below its level.
        rule.when.forEach((trigger, index) => {
          if (edgeOf(trigger)) this.#becomes(automation, rule, trigger, index);
        });
        // And what a change watches: what moved without a word on the bus is a change all the same.
        for (const [index, trigger] of rule.when.entries()) if ('changes' in trigger) await this.#changed(automation, rule, trigger, index);
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

    const scope = this.#context.scope(automation, rule, now);
    for (const [index, trigger] of rule.when.entries()) {
      const edge = edgeOf(trigger);
      if (!edge) continue;
      // Fired and still true: a hold still waiting it out, or a condition that has ended, is not one.
      const state = this.#becoming.get(`${automation.id}:${triggerKey(trigger, index)}`)?.state;
      if (!state?.last || !state.fired) continue;
      if (evaluateNow(edge.condition, scope) !== true) continue;
      // What this trigger does — its own steps, or the rule's — is what is kept so.
      const key = triggerKey(trigger, index);
      const planned = await this.#context.plan(automation, stepsOf(rule, key), this.#context.scope(automation, rule, now, key));
      if ('unknown' in planned) continue;
      const differing = planned.filter((change) => !('command' in change ? this.#context.alreadySo(change.command) : this.#context.settingSo(change.write)));
      if (!differing.length) return;
      // The last edge wins: what another automation set since stays, until a condition of this one turns to
      // yes again. What a person or an assistant changed is switched back: that is what keeping things so is for.
      const others = differing.some((change) => {
        const by = ('command' in change ? this.deps.gateway.lastSwitch(change.command.binding.device, change.command.binding.part) : this.deps.gateway.lastWrite(change.write.binding.device, change.write.key))?.by;
        return by !== undefined && by.kind === 'automation' && by.id !== automation.id;
      });
      if (others) return;
      await this.#runs.runAndKeep(automation, `Looked again after ${automation.recheckMinutes} min, and it still holds: ${this.#context.edgeSaid(automation, rule, trigger)}`, key);
      return;
    }
  }

  /** What a device said: an event some automation waits for, or a reading some condition reads. And the family's world moving. */
  async hear(message: LiveMessage): Promise<void> {
    if (message.kind === 'presence' || message.kind === 'occupancy' || message.kind === 'mode' || message.kind === 'variable') return this.#heardWorld(message);
    // A home's variables declared anew: what reads them looks again — a cleared one may have changed what a condition says.
    if (message.kind === 'variables') return this.#heardWorld({ kind: 'variable', homeId: message.homeId, key: '', value: null, previous: null, by: SYSTEM, cause: [], at: message.at });
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
          const going = this.#runs.runAndKeep(automation, `${device?.name ?? 'A device'} said: ${label}`, triggerKey(trigger, index), { id: message.event.id, data: message.event.data });
          if (!takesSteps(rule)) await going;
        }
        if (message.kind === 'readings' && 'changes' in trigger) await this.#changed(automation, rule, trigger, index);
        if (message.kind === 'readings' && edgeOf(trigger)) {
          const watched = Object.keys(rule.roles).some((role) => readsRole(rule, role) && bindingsOf(automation, role).some((binding) => binding.device === message.deviceId));
          if (watched) this.#becomes(automation, rule, trigger, index);
        }
      }
    }
  }

  /**
   * The family's world moved: someone came or went, a room filled or
   * emptied, a home's mode changed. What waits for that starts — as far as
   * each person shares, which is what presence keeps — and every condition
   * of people and places is looked at again.
   */
  async #heardWorld(message: Extract<LiveMessage, { kind: 'presence' | 'occupancy' | 'mode' | 'variable' }>): Promise<void> {
    const world = this.deps.world;
    for (const indexed of this.#concerningWorld()) {
      const automation = this.deps.store.get(indexed.id) ?? indexed;
      if (automation.mode === 'off') continue;
      const rule = automation.rule;
      const home = world?.home(automation.homeId) ?? null;
      /** The place a trigger names: the automation's own home, or what fills its role. */
      const placeOf = (name: string | undefined): EnginePlace | null => {
        if (!name || name === OWN_HOME) return home ? { id: home, kind: 'home' } : null;
        const fill = automation.world[name];
        return fill && 'place' in fill ? { id: fill.place, kind: fill.kind } : null;
      };
      /** The home a trigger's place is at: its own, a space's home. */
      const homeAt = (name: string | undefined): string | null => {
        const place = placeOf(name);
        return place && world ? world.homeOf(place) : null;
      };
      /** Whether a person is who a trigger names: anyone of the family, a person, one of several. */
      const isWho = (who: string, person: string): boolean => {
        if (who === ANYONE) return true;
        const fill = automation.world[who];
        if (!fill) return false;
        if ('person' in fill) return fill.person === person;
        if ('people' in fill) return fill.people.includes(person);
        return 'everyone' in fill;
      };
      // A variable set by a run it led to itself — or a chain too long — is not looked at again by it: two would set it back and forth for ever.
      // Its edge is still kept — set back by its own run, a person setting it again is a change it sees — but it does not start.
      const quiet = message.kind === 'variable' && (message.cause.includes(automation.id) || message.cause.length >= SEQUENCE_LIMITS.chain);
      for (const [index, trigger] of rule.when.entries()) {
        let why: string | null = null;
        if (message.kind === 'presence') {
          // Sharing less is not leaving: only arriving and leaving start a run.
          const step = 'arrives' in trigger ? { ...trigger.arrives, change: 'arrived' } : 'leaves' in trigger ? { ...trigger.leaves, change: 'left' } : null;
          const target = step ? placeOf(step.at) : null;
          if (step && target && world && step.change === message.change && world.within({ id: message.place.id, kind: message.place.kind }, target) && isWho(step.who, message.personId)) {
            const person = world?.personName(message.personId) ?? 'Someone';
            const place = step.at === OWN_HOME ? 'home' : (world?.placeName({ id: message.place.id, kind: message.place.kind }) ?? 'a place');
            why = message.change === 'arrived' ? `${person} arrived ${step.at === OWN_HOME ? 'home' : `at ${place}`}` : `${person} left ${place}`;
          }
        }
        if (message.kind === 'mode') {
          // Set by a run it led to itself — or a chain of them too long: not again, or two would set it back and forth for ever.
          if (message.cause.includes(automation.id) || message.cause.length >= SEQUENCE_LIMITS.chain) continue;
          const name = world?.placeName({ id: message.homeId, kind: 'home' }) ?? 'The home';
          if ('modeBecomes' in trigger && message.homeId === homeAt(trigger.modeBecomes.at) && message.mode === trigger.modeBecomes.mode) why = `${name} became ${message.mode}`;
          if ('modeChanges' in trigger && message.homeId === homeAt(trigger.modeChanges.at) && message.axis === trigger.modeChanges.axis) why = `${name}’s ${message.axis === 'day' ? 'time of day' : 'mode'} became ${message.mode}`;
        }
        if (why) {
          const event = message.kind === 'presence' ? { id: '', data: null, who: message.personId } : message.kind === 'mode' ? { id: '', data: null, cause: message.cause } : null;
          // Each arriving and leaving happens once: one heard while a run goes on waits for it, never let go.
          const going = this.#runs.runAndKeep(automation, why, triggerKey(trigger, index), event, { happening: message.kind === 'presence' });
          if (!takesSteps(rule)) await going;
          continue;
        }
        // What a change watches, looked at again: a variable, a fact of a place.
        if ('changes' in trigger) await this.#changed(automation, rule, trigger, index, message.kind === 'variable' ? message.cause : undefined, quiet);
        // A condition of people and places — or a `becomes` that reads them — looked at again: one a variable's change starts carries the runs that led to it.
        if (edgeOf(trigger)) this.#becomes(automation, rule, trigger, index, message.kind === 'variable' ? message.cause : undefined, quiet);
      }
    }
  }

  /**
   * A `becomes` trigger, looked at again: fires on the change to true — or
   * once it has held that long — and, with no state kept yet, on a condition
   * already true. Its state is kept after every change, so a restart resumes
   * a hold with the time it had left and never fires one twice.
   */
  #becomes(automation: AutomationRecord, rule: Rule, trigger: RuleTrigger, index: number, cause?: readonly string[], quiet = false): void {
    const edge = edgeOf(trigger);
    if (!edge) return;
    const key = `${automation.id}:${triggerKey(trigger, index)}`;
    const scope = this.#context.scope(automation, rule);
    const now = evaluateNow(edge.condition, scope);
    // Unknown — a device gone quiet — changes nothing: neither a start nor an end.
    if (typeof now !== 'boolean') return;

    let entry = this.#becoming.get(key);
    if (!entry) {
      // Nothing kept: as if it had been false, so a condition already true is its edge — but people and places:
      // "when the last one leaves" is a change seen, not a state found. Made while nobody is home, it waits for the next.
      const kept = this.deps.store.trigger(automation.id, triggerKey(trigger, index));
      const found = kept ?? (seenNotFound(trigger) ? { last: now, heldSince: null, fired: now } : { last: false, heldSince: null, fired: false });
      entry = { state: found, hold: null };
      this.#becoming.set(key, entry);
      if (!kept && found.last) this.deps.store.keepTrigger(automation.id, triggerKey(trigger, index), found);
    }
    const { state } = entry;
    const keep = () => this.deps.store.keepTrigger(automation.id, triggerKey(trigger, index), state);

    if (!now) {
      this.#context.clock.clear(entry.hold);
      entry.hold = null;
      if (state.last || state.heldSince || state.fired) {
        Object.assign(state, { last: false, heldSince: null, fired: false });
        keep();
      }
      return;
    }

    const turned = !state.last;
    if (turned) {
      // Turned true by its own run — or a chain too long — it is seen, and dealt with: not a start.
      Object.assign(state, { last: true, heldSince: this.#context.now().toISOString(), fired: quiet });
      keep();
    }
    if (quiet) return;
    // True, and already dealt with.
    if (state.fired) return;

    const said = capitalise(this.#context.edgeSaid(automation, rule, trigger));
    // A setting filled in later is held to a hold's bounds here too: a timer past them would not wait at all.
    const asked = edge.heldFor ? (secondsNow(edge.heldFor, scope) ?? 0) : 0;
    const seconds = Number.isFinite(asked) ? Math.min(HOLD_SECONDS.max, Math.max(0, asked)) : 0;
    const fire = (why: string) => {
      const current = this.deps.store.get(automation.id);
      // Turned off since — or gone — it does nothing.
      if (!current || current.mode === 'off') return;
      // Still taking its steps, and a start is let go: not dealt with, so looked at again — and started once that run ends, if it still holds.
      // One that starts afresh, or after it, is dealt with now.
      if (this.#runs.busy(automation.id) && (current.rule.whileRunning ?? 'skip') === 'skip') return;
      state.fired = true;
      keep();
      void this.#runs.runAndKeep(current, why, triggerKey(trigger, index), cause?.length ? { id: '', data: null, cause } : null);
    };
    const since = Date.parse(state.heldSince ?? this.#context.now().toISOString());
    const remaining = seconds > 0 ? since + seconds * 1000 - this.#context.now().getTime() : 0;
    // Its time is up by the engine's own clock — the timer's may not have come yet, or a test's clock ran ahead.
    if (remaining <= 0) {
      this.#context.clock.clear(entry.hold);
      entry.hold = null;
      fire(seconds > 0 ? `${said}, for ${secondsText(seconds)}` : said);
      return;
    }
    // Already waiting it out.
    if (entry.hold) return;
    entry.hold = this.#context.clock.setTimeout(() => {
      entry.hold = null;
      try {
        // Still true, all this time? Only then.
        if (evaluateNow(edge.condition, this.#context.scope(automation, rule)) !== true) return;
        fire(`${said}, for ${secondsText(seconds)}`);
      } catch (error) {
        // A timer has nobody to throw to: what went wrong is said, never left to bring the server down.
        console.error(`[automations] ${automation.id} could not fire after its hold:`, error);
      }
    }, remaining);
  }

  /**
   * A `changes` trigger, looked at: what it watches now, against what it
   * last saw. Unknown — a device gone quiet — is no change, nor a value sent
   * again; a number moved by less than `by at least` is none either, and
   * what it saw stays. Nothing seen yet — just made, or changed — it sees,
   * and does not start. A change from and to what it asks starts it, the run
   * knowing both; one its own run made — or a chain too long — is seen, and
   * not a start.
   */
  async #changed(automation: AutomationRecord, rule: Rule, trigger: Extract<RuleTrigger, { changes: unknown }>, index: number, cause?: readonly string[], quiet = false): Promise<void> {
    const key = triggerKey(trigger, index);
    const cacheKey = `${automation.id}:${key}`;
    if (!this.#seen.has(cacheKey)) this.#seen.set(cacheKey, this.deps.store.seen(automation.id, key));
    const before = this.#seen.get(cacheKey)!;
    const seen = changeSeen(trigger, before, this.#context.scope(automation, rule));
    if (seen.kind === 'unknown' || seen.kind === 'same') return;
    const now = seen.kind === 'first' ? seen.seen : seen.to;
    this.#seen.set(cacheKey, now);
    this.deps.store.keepSeen(automation.id, key, now);
    if (seen.kind === 'first' || !seen.starts || quiet) return;
    const current = this.deps.store.get(automation.id);
    if (!current || current.mode === 'off') return;
    // Said as the trigger says it, from and to what it saw: "“Laundry” changed from “Washing” to “Drying”".
    const literal = (end: { value: Value; unit: string | null }): Expr => (typeof end.value === 'number' && end.unit ? { value: end.value, unit: end.unit as Unit } : { value: end.value });
    const said: RuleTrigger = { changes: trigger.changes, from: literal(seen.from), to: literal(seen.to) };
    const why = capitalise(this.#context.edgeSaid(automation, rule, said).replace(/ changes from /, ' changed from '));
    const event = { id: '', data: null, from: seen.from, to: seen.to, ...(cause?.length ? { cause } : {}) };
    const going = this.#runs.runAndKeep(current, why, key, event);
    if (!takesSteps(rule)) await going;
  }

  /** Whether a trigger of the clock's is due now; one the clock does not start is never. */
  #due(automation: AutomationRecord, rule: Rule, trigger: RuleTrigger, now: Date): boolean {
    const kind = triggerKind(trigger);
    switch (kind) {
      case 'at':
        return this.#dueAt(automation, rule, trigger as Extract<Trigger, { at: unknown }>, now, this.#lastStarted(automation, rule, trigger));
      case 'every':
        return this.#dueEvery(automation, rule, trigger as Extract<Trigger, { every: unknown }>, now, this.#lastStarted(automation, rule, trigger));
      case 'event':
      case 'becomes':
      case 'arrives':
      case 'leaves':
      case 'firstArrives':
      case 'lastLeaves':
      case 'empties':
      case 'occupied':
      case 'modeBecomes':
      case 'modeChanges':
      // Once as kraftverk starts (`started`), never by the clock.
      case 'onStart':
      // As what it watches moves (`#changed`).
      case 'changes':
        return false;
    }
  }

  /**
   * When this trigger last started a run: what its next slot is counted
   * from. Not when the automation last ran — a run another trigger started,
   * or a person, must not take this one's slot. Until it has started one —
   * an automation just made, or changed, which starts afresh — its last run
   * of any kind: a slot it already ran in is not run again for a change.
   */
  #lastStarted(automation: AutomationRecord, rule: Rule, trigger: RuleTrigger): number {
    const own = this.deps.store.triggerStarted(automation.id, triggerKey(trigger, rule.when.indexOf(trigger)));
    if (own) return Date.parse(own);
    return Math.max(...[automation.lastRun?.at, automation.running?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
  }

  #dueAt(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { at: unknown }>, now: Date, lastStarted: number): boolean {
    const at = evaluateNow(trigger.at, this.#context.scope(automation, rule));
    const [hour, minute] = typeof at === 'string' ? at.split(':').map(Number) : [];
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return false;
    // Today's, or yesterday's still within its grace: 23:30's, with the server back at 00:05.
    return [localTime(now, automation.timeZone), dayAfter(now, automation.timeZone, -1)].some((day) => {
      // Only on its days, on the owner's calendar.
      if (!runsOn(trigger, day)) return false;
      const time = zonedInstant({ ...day, hour, minute }, automation.timeZone);
      const since = now.getTime() - time.getTime();
      // One taken from a variable is late by a look at most: moved to a time just past, it has not come.
      if (since < 0 || since > ('variable' in trigger.at ? VARIABLE_GRACE_MS : GRACE_MS)) return false;
      return !Number.isFinite(lastStarted) || lastStarted < time.getTime();
    });
  }

  /** Whether an interval's latest slot, on the owner's clock, has come and it has not run since: once a slot, never catching up. */
  #dueEvery(automation: AutomationRecord, rule: Rule, trigger: Extract<Trigger, { every: unknown }>, now: Date, lastStarted: number): boolean {
    const seconds = secondsNow(trigger.every, this.#context.scope(automation, rule));
    if (typeof seconds !== 'number' || seconds < EVERY_SECONDS.min || seconds > EVERY_SECONDS.max || seconds % EVERY_SECONDS.step !== 0) return false;
    const every = seconds / 60;
    const today = localTime(now, automation.timeZone);
    const minuteOfDay = today.hour * 60 + today.minute;
    const slot = slotOf(minuteOfDay, every);
    // Its start, counted back from now on the clock now shown: in the hour repeated as clocks go back, each of the two has its own slots.
    const time = new Date(now.getTime() - (now.getTime() % 60_000) - (minuteOfDay - slot) * 60_000);
    return time.getTime() <= now.getTime() && (!Number.isFinite(lastStarted) || lastStarted < time.getTime());
  }
}
