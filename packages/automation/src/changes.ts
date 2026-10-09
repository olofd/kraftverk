import { convert, isUnit, type Unit, type Value } from '@kraftverk/device-sdk';

import { measureNow, type Measured, type RuleScope } from './evaluate.ts';
import type { Expr, Trigger } from './rule.ts';

/*
  What a `changes` trigger makes of what it watches now, against what it
  last saw (docs/PLAN-VARIABLES-AND-TRIGGERS.md §3.1): the engine's rule
  and rehearsal's alike, so what history says it would have done is what it
  does.
*/

/** What it last saw, in its unit. */
export type SeenValue = { value: Value; unit: string | null };

/**
 * - `unknown`: nothing to see — a device gone quiet; what it saw stays.
 * - `first`: nothing seen before: seen, not a start.
 * - `same`: no change — the same, or a number moved by less than `by at least`; what it saw stays.
 * - `change`: what it saw is now `to`; a start when it is from and to what it asks.
 */
export type ChangeSeen = { kind: 'unknown' } | { kind: 'first'; seen: SeenValue } | { kind: 'same' } | { kind: 'change'; from: SeenValue; to: SeenValue; starts: boolean };

const unitOf = (unit: string | null): Unit | null => (unit && isUnit(unit) ? unit : null);

/** A number in another unit, when it is one of that quantity; as it is otherwise. */
const inUnit = (value: number, from: string | null, to: string | null): number => {
  const [a, b] = [unitOf(from), unitOf(to)];
  return a && b && a !== b ? (convert(value, a, b) ?? value) : value;
};

export function changeSeen(trigger: Extract<Trigger, { changes: unknown }>, before: SeenValue | null, scope: RuleScope): ChangeSeen {
  const now: Measured = measureNow(trigger.changes, scope);
  if (now.value === null || typeof now.value === 'object') return { kind: 'unknown' };
  const seen: SeenValue = { value: now.value, unit: now.unit };
  if (!before) return { kind: 'first', seen };
  // In one unit: what it was, in what it is now in.
  const was = typeof before.value === 'number' ? inUnit(before.value, before.unit, now.unit) : before.value;
  if (was === now.value) return { kind: 'same' };
  if (typeof was === 'number' && typeof now.value === 'number' && trigger.byAtLeast) {
    const by = measureNow(trigger.byAtLeast, scope);
    // A step is a difference: 1 °F is five ninths of a degree, not -17 °C.
    const step = typeof by.value === 'number' ? inUnit(by.value, by.unit, now.unit) - inUnit(0, by.unit, now.unit) : null;
    if (step !== null && Math.abs(now.value - was) < step) return { kind: 'same' };
  }
  /** Whether an end it asks for is so: none asked, or the value it names — a number in the unit it is written in. */
  const matches = (end: Expr | undefined, value: Value): boolean => {
    if (!end) return true;
    const asked = measureNow(end, scope);
    if (typeof asked.value === 'number' && typeof value === 'number') return Math.abs(inUnit(asked.value, asked.unit, now.unit) - value) < 1e-9;
    return asked.value === value;
  };
  return { kind: 'change', from: { value: was, unit: now.unit }, to: seen, starts: matches(trigger.from, was) && matches(trigger.to, now.value) };
}
