import { CLOCK_TIME, counted, stillHolds, toRemember, variableStart, type VariableSpec } from '@kraftverk/automation';
import { REAL_CLOCK, type Actor, type Clock, type Value } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';
import type { VariableRecord, VariableStore } from '@kraftverk/store';

/*
  A home's variables, kept and said (docs/PLAN-VARIABLES-AND-TRIGGERS.md
  §2.4): what each holds now — as set, or what it starts as — set by an
  automation, a person or a script, held to its field (its kind, its unit,
  its range; a time is a time of day), and each change said on the bus with
  who made it and the automations whose runs led to it, so what reads it
  looks again and none sets it back and forth for ever. Modes are the
  pattern (modes/modes.ts).
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

/** A variable as the language sees it: its key, kind and field. */
const specOf = (record: VariableRecord): VariableSpec => ({ key: record.key, kind: record.kind, field: record.field });

type Set = { previous: Value | null; value: Value; changed: boolean };

export class Variables {
  readonly #deps: VariablesDeps;
  readonly #clock: Clock;

  constructor(deps: VariablesDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? REAL_CLOCK;
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

  /**
   * One set, by someone — and, by an automation, the runs that led to it.
   * Already so, nothing is said; but a value chosen where none was is kept,
   * so a change to what it starts as does not change it. Refused, in words,
   * when the home has no such variable or the value does not fit it.
   */
  set(homeId: string, key: string, value: Value, by: Actor, cause: readonly string[] = []): Set {
    const record = this.#record(homeId, key);
    const fitted = this.fit(record, value);
    if ('problem' in fitted) throw new VariableRefusal(fitted.problem, 'invalid');
    const previous = this.#held(record);
    const at = new Date(this.#clock.now()).toISOString();
    if (previous === fitted.value) {
      if (!this.#deps.store.value(record.id)) this.#deps.store.set(record.id, fitted.value, by, at);
      return { previous, value: fitted.value, changed: false };
    }
    this.#deps.store.set(record.id, fitted.value, by, at);
    this.#deps.bus.publish({ kind: 'variable', homeId, key, value: fitted.value, previous, by, cause, at });
    return { previous, value: fitted.value, changed: true };
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
   * One declared anew — its kind, its field, perhaps its key — by someone:
   * what it holds, no longer meaning the same (another kind or unit, out of
   * its range now), goes back to what it starts as. When what it holds
   * changes so, it is said as a set is, so what waits for it looks again.
   */
  redeclare(record: VariableRecord, changes: Pick<VariableSpec, 'key' | 'kind' | 'field'>, by: Actor): VariableRecord {
    const before = this.#held(record);
    const kept = this.#deps.store.value(record.id);
    const changed = this.#deps.store.update(record.id, changes)!;
    if (kept && !stillHolds(record, changed, kept.value)) this.#deps.store.clear(record.id);
    const after = this.#held(changed);
    const at = new Date(this.#clock.now()).toISOString();
    if (after !== before) this.#deps.bus.publish({ kind: 'variable', homeId: changed.homeId, key: changed.key, value: after, previous: before, by, cause: [], at });
    this.changed(changed.homeId);
    return changed;
  }

  /** The home's variables changed — one added, changed or let go: said, so what reads them looks again. */
  changed(homeId: string): void {
    this.#deps.bus.publish({ kind: 'variables', homeId, at: new Date(this.#clock.now()).toISOString() });
  }
}
