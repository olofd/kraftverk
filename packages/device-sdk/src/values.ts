/**
 * One value system (docs/ARCHITECTURE.md §8 step 23).
 *
 * What a device reports, what a setting holds, what a command takes as its
 * arguments, what an event carries, what a query or a tool answers and what a
 * config field asks for are all values of one of these types. One definition
 * means one validator, one way to draw a value, and one mapping to what Home
 * Assistant and Matter call the same thing (`standards.ts`).
 *
 * Deliberately few: four scalars, a time, and two ways of putting values
 * together — a list and an object — so an answer with structure (a forecast,
 * hour by hour) has a schema the contract suite can check and the app can
 * draw, rather than being `unknown`.
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

/** An instant, carried as an ISO 8601 string: when the pack was last full, when the next run is. */
export type TimestampValue = { type: 'timestamp' };

/** Several values of one type, in order. */
export type ListValue = { type: 'list'; of: ValueType };

/**
 * Named values, each of its own type. A field may be null — not known — like
 * any value, unless it is `required`: the hour a forecast is about is never
 * unknown, its cloud cover may be.
 */
export type ObjectValue = { type: 'object'; fields: Readonly<Record<string, ValueType>>; required?: readonly string[] };

export type ValueType = NumberValue | BooleanValue | EnumValue | StringValue | TimestampValue | ListValue | ObjectValue;

/** The types a single reading, setting or argument can have: no structure. */
export type ScalarValueType = NumberValue | BooleanValue | EnumValue | StringValue | TimestampValue;

export const isScalarType = (type: ValueType): type is ScalarValueType => type.type !== 'list' && type.type !== 'object';

/**
 * A value as it travels. `null` is "not known" — never zero, never off, never
 * the empty string — because a device that has not said is not a device that
 * said nothing.
 */
export type Value = number | boolean | string | null | readonly Value[] | { readonly [field: string]: Value };

/** A value with no structure: what a reading of a scalar type, a comparison or a chart deals in. */
export type ScalarValue = number | boolean | string | null;

export const isScalar = (value: Value | undefined): value is ScalarValue =>
  value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';

/**
 * The TypeScript type a value of this type has, for declarations kept `as const`:
 * a query declared to answer a list of objects is answered, and read, as one,
 * with no cast.
 */
export type ValueOf<T extends ValueType> = T extends NumberValue
  ? number
  : T extends BooleanValue
    ? boolean
    : T extends { type: 'enum'; options: readonly (infer Option)[] }
      ? Option extends { value: infer V } ? V : string
      : T extends StringValue | TimestampValue
        ? string
        : T extends { type: 'list'; of: infer Of extends ValueType }
          ? readonly ValueOf<Of>[]
          : T extends { type: 'object'; fields: infer Fields extends Readonly<Record<string, ValueType>>; required: readonly (infer Required)[] }
            ? { readonly [Field in keyof Fields]: Field extends Required ? ValueOf<Fields[Field]> : ValueOf<Fields[Field]> | null }
            : T extends { type: 'object'; fields: infer Fields extends Readonly<Record<string, ValueType>> }
              ? { readonly [Field in keyof Fields]: ValueOf<Fields[Field]> | null }
              : Value;

/** What checking a value came to: the value as it should be kept, or what is wrong with it. */
export type ValueCheck = { ok: true; value: Exclude<Value, null> } | { ok: false; problem: string };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Checks one given value against its type, and returns it as it should be kept.
 *
 * Lenient only where people are: a number typed into a text field arrives as a
 * string, and is taken. The problem is a phrase to follow a name — "must be a
 * number" — so the caller can say whose value it was; inside a list or an
 * object it says where: "[3].cloudCover must be a number".
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

    case 'timestamp': {
      if (typeof given !== 'string' || !ISO.test(given) || !Number.isFinite(Date.parse(given))) return { ok: false, problem: 'must be a time, like 2026-09-29T07:00:00Z' };
      return { ok: true, value: new Date(given).toISOString() };
    }

    case 'list': {
      if (!Array.isArray(given)) return { ok: false, problem: 'must be a list' };
      const items: Value[] = [];
      for (const [index, item] of given.entries()) {
        if (item === null) {
          items.push(null);
          continue;
        }
        const checked = checkValue(type.of, item);
        if (!checked.ok) return { ok: false, problem: `[${index}]${checked.problem.startsWith('[') || checked.problem.startsWith('.') ? '' : ' '}${checked.problem}` };
        items.push(checked.value);
      }
      return { ok: true, value: items };
    }

    case 'object': {
      if (given === null || typeof given !== 'object' || Array.isArray(given)) return { ok: false, problem: 'must be an object' };
      const record = given as Record<string, unknown>;
      const fields: Record<string, Value> = {};
      for (const [name, fieldType] of Object.entries(type.fields)) {
        const field = record[name];
        if (field === null || field === undefined) {
          if (type.required?.includes(name)) return { ok: false, problem: `.${name} must be given` };
          fields[name] = null;
          continue;
        }
        const checked = checkValue(fieldType, field);
        if (!checked.ok) return { ok: false, problem: `.${name}${checked.problem.startsWith('[') || checked.problem.startsWith('.') ? '' : ' '}${checked.problem}` };
        fields[name] = checked.value;
      }
      const extra = Object.keys(record).filter((name) => !(name in type.fields));
      if (extra.length) return { ok: false, problem: `has no field ${extra.map((name) => `"${name}"`).join(', ')}` };
      return { ok: true, value: fields };
    }
  }
}

/** Every problem with a value type as declared: an enum with no options, a range upside down. */
export function valueTypeProblems(what: string, type: ValueType | undefined): string[] {
  switch (type?.type) {
    case 'enum': {
      const values = type.options.map((option) => option.value);
      if (!values.length) return [`${what} is an enum with no options`];
      return new Set(values).size === values.length ? [] : [`${what} is an enum with an option twice`];
    }
    case 'number':
      return type.min !== undefined && type.max !== undefined && type.min > type.max ? [`${what} has a minimum above its maximum`] : [];
    case 'boolean':
    case 'string':
    case 'timestamp':
      return [];
    case 'list':
      return valueTypeProblems(`${what}[]`, type.of);
    case 'object': {
      const fields = Object.entries(type.fields ?? {});
      if (!fields.length) return [`${what} is an object with no fields`];
      const unknown = (type.required ?? []).filter((name) => !(name in type.fields));
      return [
        ...unknown.map((name) => `${what} requires "${name}", which it does not have`),
        ...fields.flatMap(([name, field]) => valueTypeProblems(`${what}.${name}`, field)),
      ];
    }
    default:
      return [`${what} has an unknown value type "${(type as { type?: string } | undefined)?.type}"`];
  }
}

/** The label an enum value is shown by, or the value itself when it is not one of the options. */
export const enumLabel = (type: EnumValue, value: string): string =>
  type.options.find((option) => option.value === value)?.label ?? value;
