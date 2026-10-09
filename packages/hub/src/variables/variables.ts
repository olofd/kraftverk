import { CLOCK_TIME, counted, stillHolds, TIMER_SECONDS, toRemember, variableStart, type TimerState, type VariableSpec } from '@kraftverk/automation';
import { REAL_CLOCK, SYSTEM, type Actor, type Clock, type ClockTimer, type Value } from '@kraftverk/device-sdk';
import type { TimerAction } from '@kraftverk/api-contract';
import type { LiveBus } from '@kraftverk/holder';
import type { TimerKept, VariableRecord, VariableStore } from '@kraftverk/store';

/*
  A home's variables, kept and said (docs/PLAN-VARIABLES-AND-TRIGGERS.md
  §2.4): what each holds now — as set, or what it starts as — set by an
  automation, a person or a script, held to its field (its kind, its unit,
  its range; a time is a time of day), and each change said on the bus with
  who made it and the automations whose runs led to it, so what reads it
  looks again and none sets it back and forth for ever. A timer runs to its
  deadline, kept in the store, and ends on its own — to the second, across a
  restart. Modes are the pattern (modes/modes.ts).
*/

export type VariablesDeps = { store: VariableStore; bus: LiveBus; clock?: Clock };

/** A set refused, on purpose and in words: no such variable, or a value that does not fit it. Anything else thrown is a fault. */
export class VariableRefusal extends Error {
  constructor(
    message: string,
    readonly kind: 'not-found' | 'invalid'
  ) {
    super(message);
  }
}

/** A variable as the language sees it: its key, kind and field — a timer's length. */
const specOf = (record: VariableRecord): VariableSpec => ({ key: record.key, kind: record.kind, field: record.field, ...(record.length !== undefined ? { length: record.length } : {}) });

type Set = { previous: Value | null; value: Value; changed: boolean };

/** How far past its deadline a timer is looked at: never before it — a clock's timer may come a little early. */
const ARM_LATE_MS = 5;

export class Variables {
  readonly #deps: VariablesDeps;
  readonly #clock: Clock;
  /** Each running timer's end, by its variable's id. */
  readonly #ends = new Map<string, ClockTimer>();

  constructor(deps: VariablesDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? REAL_CLOCK;
  }

  /** Takes up the timers that were running: each ends at its deadline — at once, one that passed meanwhile. */
  start(): void {
    for (const running of this.#deps.store.running()) this.#arm(running.id, Date.parse(running.deadline));
  }

  stop(): void {
    for (const timer of this.#ends.values()) this.#clock.clear(timer);
    this.#ends.clear();
  }

  /** A home's variables, as the language sees them. */
  specs(homeId: string): VariableSpec[] {
    return this.#deps.store.list(homeId).map(specOf);
  }

  /** What one holds now: as set — or, none set, what it starts as; null when the home has no such variable. */
  now(homeId: string, key: string): Value | null {
    const record = this.#deps.store.byKey(homeId, key);
    return record ? this.#held(record) : null;
  }

  #held(record: VariableRecord): Value | null {
    return this.#deps.store.value(record.id)?.value ?? variableStart(specOf(record));
  }

  #at(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  /**
   * What a value is as one of a home's variables holds it — in its unit, in
   * its range, a time of day where it is one — or what is wrong with it.
   */
  fit(record: VariableRecord, value: Value): { value: Value } | { problem: string } {
    const kept = toRemember({ fields: { [record.key]: record.field } }, record.key, { value, unit: null });
    if ('problem' in kept) return kept;
    if (record.kind === 'time' && (typeof kept.value !== 'string' || !CLOCK_TIME.test(kept.value))) return { problem: `${record.field.title} is a time of day: 07:00` };
    if (record.kind === 'counter' && (typeof kept.value !== 'number' || !Number.isInteger(kept.value))) return { problem: `${record.field.title} counts in whole numbers` };
    return kept;
  }

  #record(homeId: string, key: string): VariableRecord {
    const record = this.#deps.store.byKey(homeId, key);
    if (!record) throw new VariableRefusal(`The home has no variable "${key}"`, 'not-found');
    return record;
  }

  /** A value kept, and — changed — said on the bus, with who and the runs that led to it. */
  #put(record: VariableRecord, value: Value, by: Actor, cause: readonly string[], timer?: TimerKept): Set {
    const previous = this.#held(record);
    const at = this.#at();
    if (previous === value && !timer) {
      // A value chosen where none was is kept: a change to what it starts as does not change it.
      if (!this.#deps.store.value(record.id)) this.#deps.store.set(record.id, value, by, at);
      return { previous, value, changed: false };
    }
    this.#deps.store.set(record.id, value, by, at, timer);
    if (previous !== value) this.#deps.bus.publish({ kind: 'variable', homeId: record.homeId, key: record.key, value, previous, by, cause, at });
    // The same state with another end — started again while it ran — is no change, but what a screen counts down is.
    else this.changed(record.homeId);
    return { previous, value, changed: previous !== value };
  }

  /**
   * One set, by someone — and, by an automation, the runs that led to it.
   * Already so, nothing is said. Refused, in words, when the home has no
   * such variable, the value does not fit it — or it is a timer, which is
   * started and stopped.
   */
  set(homeId: string, key: string, value: Value, by: Actor, cause: readonly string[] = []): Set {
    const record = this.#record(homeId, key);
    if (record.kind === 'timer') throw new VariableRefusal(`${record.field.title} is a timer: start it, or stop it`, 'invalid');
    const fitted = this.fit(record, value);
    if ('problem' in fitted) throw new VariableRefusal(fitted.problem, 'invalid');
    return this.#put(record, fitted.value, by, cause);
  }

  /** A counter counted, by someone: by one, by so many, or back to its start — held to its range. */
  count(homeId: string, key: string, count: { by?: number; reset?: boolean }, by: Actor, cause: readonly string[] = []): Set {
    const record = this.#record(homeId, key);
    if (record.kind !== 'counter') throw new VariableRefusal(`${record.field.title} is not a counter: set it`, 'invalid');
    const next = counted(specOf(record), this.#held(record), count);
    if (next === null) throw new VariableRefusal('A counter counts by a whole number', 'invalid');
    return this.set(homeId, key, next, by, cause);
  }

  /**
   * A timer started — for its length, or so many seconds — stopped,
   * paused or resumed, by someone. Started while it runs, it starts again.
   * Pausing one not running, or resuming one not paused, changes nothing.
   */
  timer(homeId: string, key: string, action: TimerAction, by: Actor, cause: readonly string[] = []): Set {
    const record = this.#record(homeId, key);
    if (record.kind !== 'timer') throw new VariableRefusal(`${record.field.title} is not a timer`, 'invalid');
    const state = this.#held(record) as TimerState;
    const now = this.#clock.now();
    switch (action.action) {
      case 'start': {
        const seconds = action.seconds ?? record.length ?? 0;
        if (!Number.isFinite(seconds) || seconds < TIMER_SECONDS.min || seconds > TIMER_SECONDS.max) throw new VariableRefusal('A timer runs from a second to a week', 'invalid');
        const deadline = now + Math.round(seconds * 1000);
        const set = this.#put(record, 'running', by, cause, { deadline: new Date(deadline).toISOString(), leftMs: null });
        this.#arm(record.id, deadline);
        return set;
      }
      case 'stop':
        this.#disarm(record.id);
        return this.#put(record, 'idle', by, cause, { deadline: null, leftMs: null });
      case 'pause': {
        const kept = this.#deps.store.value(record.id);
        if (state !== 'running' || !kept?.deadline) return { previous: state, value: state, changed: false };
        this.#disarm(record.id);
        return this.#put(record, 'paused', by, cause, { deadline: null, leftMs: Math.max(0, Date.parse(kept.deadline) - now) });
      }
      case 'resume': {
        const kept = this.#deps.store.value(record.id);
        if (state !== 'paused' || kept?.leftMs === null || kept?.leftMs === undefined) return { previous: state, value: state, changed: false };
        const deadline = now + kept.leftMs;
        const set = this.#put(record, 'running', by, cause, { deadline: new Date(deadline).toISOString(), leftMs: null });
        this.#arm(record.id, deadline);
        return set;
      }
    }
  }

  /** A timer's end, kept by one timeout: at its deadline it has ended — if it still runs to that one. */
  #arm(id: string, deadline: number): void {
    this.#disarm(id);
    this.#ends.set(
      id,
      this.#clock.setTimeout(() => {
        this.#ends.delete(id);
        // By its id: renamed while it runs, it is the same timer.
        const record = this.#deps.store.get(id);
        const kept = record && !record.removedAt && record.kind === 'timer' ? this.#deps.store.value(id) : null;
        if (!record || kept?.value !== 'running' || !kept.deadline) return;
        // Woken early — a fast clock's timers are — it waits out the rest.
        if (Date.parse(kept.deadline) > this.#clock.now()) return this.#arm(id, Date.parse(kept.deadline));
        this.#put(record, 'ended', SYSTEM, [], { deadline: null, leftMs: null });
      }, Math.max(0, deadline - this.#clock.now()) + ARM_LATE_MS)
    );
  }

  #disarm(id: string): void {
    this.#clock.clear(this.#ends.get(id));
    this.#ends.delete(id);
  }

  /** A timer's: when it ends, running; what is left, paused — none, not a timer or neither. */
  timerOf(record: VariableRecord): TimerKept | null {
    if (record.kind !== 'timer') return null;
    const kept = this.#deps.store.value(record.id);
    return { deadline: kept?.deadline ?? null, leftMs: kept?.leftMs ?? null };
  }

  /**
   * One declared anew — its kind, its field, perhaps its key — by someone:
   * what it holds, no longer meaning the same (another kind or unit, out of
   * its range now), goes back to what it starts as. When what it holds
   * changes so, it is said as a set is, so what waits for it looks again.
   */
  redeclare(record: VariableRecord, changes: Pick<VariableSpec, 'key' | 'kind' | 'field' | 'length'>, by: Actor): VariableRecord {
    const before = this.#held(record);
    const kept = this.#deps.store.value(record.id);
    const changed = this.#deps.store.update(record.id, changes)!;
    if (kept && !stillHolds(record, changed, kept.value)) {
      this.#disarm(record.id);
      this.#deps.store.clear(record.id);
    }
    const after = this.#held(changed);
    if (after !== before) this.#deps.bus.publish({ kind: 'variable', homeId: changed.homeId, key: changed.key, value: after, previous: before, by, cause: [], at: this.#at() });
    this.changed(changed.homeId);
    return changed;
  }

  /** One let go: a timer of it ends with it, saying nothing more. */
  forget(id: string): void {
    this.#disarm(id);
  }

  /** The home's variables changed — one added, changed or let go: said, so what reads them looks again. */
  changed(homeId: string): void {
    this.#deps.bus.publish({ kind: 'variables', homeId, at: this.#at() });
  }
}
