/**
 * One value system (docs/ARCHITECTURE.md §8 step 23).
 *
 * What a device reports, what a setting holds, what a command takes as its
 * arguments, what an event carries and what a config field asks for are all
 * values of one of these types. One definition means one validator, one way
 * to draw a value, and one mapping to what Home Assistant and Matter call the
 * same thing (`standards.ts`).
 *
 * Deliberately few. A type that needs something richer — a schedule, a list —
 * composes it from these, or keeps it to its own screens.
 */

export type EnumOption = { value: string; label: string };

export type NumberValue = {
  type: 'number';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Decimals shown. Stored values keep what the device gave. */
  precision?: number;
  integer?: boolean;
};

export type BooleanValue = { type: 'boolean' };

export type EnumValue = { type: 'enum'; options: readonly EnumOption[] };

export type StringValue = { type: 'string' };

export type ValueType = NumberValue | BooleanValue | EnumValue | StringValue;

/**
 * A value as it travels. `null` is "not known" — never zero, never off, never
 * the empty string — because a device that has not said is not a device that
 * said nothing.
 */
export type Value = number | boolean | string | null;

/** What checking a value came to: the value as it should be kept, or what is wrong with it. */
export type ValueCheck = { ok: true; value: number | boolean | string } | { ok: false; problem: string };

/**
 * Checks one given value against its type, and returns it as it should be kept.
 *
 * Lenient only where people are: a number typed into a text field arrives as a
 * string, and is taken. The problem is a phrase to follow a name — "must be a
 * number" — so the caller can say whose value it was.
 */
export function checkValue(type: ValueType, given: unknown): ValueCheck {
  switch (type.type) {
    case 'string':
      return typeof given === 'string' ? { ok: true, value: given } : { ok: false, problem: 'must be text' };

    case 'boolean':
      return typeof given === 'boolean' ? { ok: true, value: given } : { ok: false, problem: 'must be true or false' };

    case 'number': {
      const numeric = typeof given === 'number' ? given : typeof given === 'string' && given.trim() !== '' ? Number(given) : Number.NaN;
      if (!Number.isFinite(numeric)) return { ok: false, problem: 'must be a number' };
      if (type.integer && !Number.isInteger(numeric)) return { ok: false, problem: 'must be a whole number' };
      if (type.min !== undefined && numeric < type.min) return { ok: false, problem: `must be at least ${type.min}` };
      if (type.max !== undefined && numeric > type.max) return { ok: false, problem: `must be at most ${type.max}` };
      return { ok: true, value: numeric };
    }

    case 'enum': {
      const allowed = type.options.map((option) => option.value);
      return typeof given === 'string' && allowed.includes(given)
        ? { ok: true, value: given }
        : { ok: false, problem: `must be one of: ${allowed.join(', ')}` };
    }
  }
}

/** The label an enum value is shown by, or the value itself when it is not one of the options. */
export const enumLabel = (type: EnumValue, value: string): string =>
  type.options.find((option) => option.value === value)?.label ?? value;
