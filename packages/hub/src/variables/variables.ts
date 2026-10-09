import { CLOCK_TIME, counted, toRemember, variableStart, type VariableSpec } from '@kraftverk/automation';
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

/** A variable as the language sees it: its key, kind and field. */
const specOf = (record: VariableRecord): VariableSpec => ({ key: record.key, kind: record.kind, field: record.field });

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
    if (!record) return null;
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

  /**
   * One set, by someone — and, by an automation, the runs that led to it.
   * Already so: nothing changes, nothing is said. Thrown, in words, when the
   * home has no such variable or the value does not fit it.
   */
  set(homeId: string, key: string, value: Value, by: Actor, cause: readonly string[] = []): { previous: Value | null; value: Value; changed: boolean } {
    const record = this.#deps.store.byKey(homeId, key);
    if (!record) throw new Error(`The home has no variable "${key}"`);
    const fitted = this.fit(record, value);
    if ('problem' in fitted) throw new Error(fitted.problem);
    const previous = this.now(homeId, key);
    if (previous === fitted.value) return { previous, value: fitted.value, changed: false };
    const at = new Date(this.#clock.now()).toISOString();
    this.#deps.store.set(record.id, fitted.value, by, at);
    this.#deps.bus.publish({ kind: 'variable', homeId, key, value: fitted.value, previous, by, cause, at });
    return { previous, value: fitted.value, changed: true };
  }

  /** A counter counted, by someone: by one, by so many, or back to its start — held to its range. */
  count(homeId: string, key: string, count: { by?: number; reset?: boolean }, by: Actor, cause: readonly string[] = []): { previous: Value | null; value: Value; changed: boolean } {
    const record = this.#deps.store.byKey(homeId, key);
    if (!record) throw new Error(`The home has no variable "${key}"`);
    if (record.kind !== 'counter') throw new Error(`${record.field.title} is not a counter: set it`);
    const next = counted(specOf(record), this.now(homeId, key), count);
    if (next === null) throw new Error('A counter counts by a whole number');
    return this.set(homeId, key, next, by, cause);
  }

  /** The home's variables changed — one added, changed or let go: said, so what reads them looks again. */
  changed(homeId: string): void {
    this.#deps.bus.publish({ kind: 'variables', homeId, at: new Date(this.#clock.now()).toISOString() });
  }
}
