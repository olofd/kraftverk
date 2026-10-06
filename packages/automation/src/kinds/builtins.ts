import type { KindDocs } from './spec.ts';

/*
  The language's own functions, as data: each once — how many arguments it
  takes, how their units go, what it makes of them, how a sentence says it
  and its page in the reference. The parser, the checker, the evaluator and
  the words read them from here; a package's functions, which read a part,
  are `call` and its contribution's.

  Every one takes numbers, each with its unit (units.ts), and answers a
  number in the first one's unit: `clamp(charger.power, 0 W, 2 kW)` is in W,
  2 kW converted. Unknown when any argument is.
*/

export type BuiltinName = 'round' | 'floor' | 'ceil' | 'abs' | 'clamp' | 'min' | 'max';

export type BuiltinSpec = {
  name: BuiltinName;
  /** What the reference calls it. */
  label: string;
  /** Its arguments by name, in order, and how many it takes: at least, at most — null, any number more. */
  params: readonly string[];
  arity: { min: number; max: number | null };
  /**
   * How its arguments' units go: `one` — every one in the first's, converted;
   * `first` — the first in its unit, the rest plain numbers (round's digits).
   */
  units: 'one' | 'first';
  /** What it makes of its numbers, each in the first one's unit; null when they make nothing. */
  apply(values: readonly number[]): number | null;
  /** In a sentence, its arguments said: "Garage station's charge, rounded". */
  words(args: readonly string[]): string;
  docs: KindDocs;
};

const list = (items: readonly string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? ''));

const DIGITS_MAX = 9;

/** Every built-in, by its name: the table everything that handles them reads. */
export const BUILTINS: { readonly [N in BuiltinName]: BuiltinSpec & { name: N } } = {
  round: {
    name: 'round',
    label: 'Round',
    params: ['x', 'digits'],
    arity: { min: 1, max: 2 },
    units: 'first',
    apply: ([x, digits = 0]) => {
      if (!Number.isInteger(digits) || digits < 0 || digits > DIGITS_MAX) return null;
      const scale = 10 ** digits;
      return Math.round(x! * scale) / scale;
    },
    words: ([x, digits]) => (digits && digits !== '0' ? `${x}, rounded to ${digits} decimals` : `${x}, rounded`),
    docs: { summary: 'A number rounded to a whole one — or, given `digits`, to that many decimals. In its own unit.', examples: ['round(station.charge)', 'round(charger.power, 1)'] },
  },
  floor: {
    name: 'floor',
    label: 'Round down',
    params: ['x'],
    arity: { min: 1, max: 1 },
    units: 'one',
    apply: ([x]) => Math.floor(x!),
    words: ([x]) => `${x}, rounded down`,
    docs: { summary: 'A number rounded down to a whole one, in its own unit.', examples: ['floor(station.charge)'] },
  },
  ceil: {
    name: 'ceil',
    label: 'Round up',
    params: ['x'],
    arity: { min: 1, max: 1 },
    units: 'one',
    apply: ([x]) => Math.ceil(x!),
    words: ([x]) => `${x}, rounded up`,
    docs: { summary: 'A number rounded up to a whole one, in its own unit.', examples: ['ceil(station.charge)'] },
  },
  abs: {
    name: 'abs',
    label: 'Size',
    params: ['x'],
    arity: { min: 1, max: 1 },
    units: 'one',
    apply: ([x]) => Math.abs(x!),
    words: ([x]) => `the size of ${x}`,
    docs: { summary: 'How large a number is, whichever way: −5 W is 5 W.', examples: ['abs(meter.power)'] },
  },
  clamp: {
    name: 'clamp',
    label: 'Keep between',
    params: ['x', 'low', 'high'],
    arity: { min: 3, max: 3 },
    units: 'one',
    apply: ([x, low, high]) => (low! > high! ? null : Math.min(Math.max(x!, low!), high!)),
    words: ([x, low, high]) => `${x}, kept between ${low} and ${high}`,
    docs: { summary: 'A number kept between two others: below the low one, the low one; above the high one, the high one. All in the first one’s unit.', examples: ['clamp(charger.power, 0 W, 2 kW)'] },
  },
  min: {
    name: 'min',
    label: 'The lowest',
    params: ['a', 'b', '…'],
    arity: { min: 2, max: null },
    units: 'one',
    apply: (values) => Math.min(...values),
    words: (args) => `the lowest of ${list(args)}`,
    docs: { summary: 'The lowest of two or more numbers, in the first one’s unit.', examples: ['min(station.charge, 80 %)', 'min(a.power, b.power, 2 kW)'] },
  },
  max: {
    name: 'max',
    label: 'The highest',
    params: ['a', 'b', '…'],
    arity: { min: 2, max: null },
    units: 'one',
    apply: (values) => Math.max(...values),
    words: (args) => `the highest of ${list(args)}`,
    docs: { summary: 'The highest of two or more numbers, in the first one’s unit.', examples: ['max(station.charge, 20 %)'] },
  },
};

/** The order the reference lists them in. */
export const BUILTIN_ORDER: readonly BuiltinName[] = ['min', 'max', 'clamp', 'round', 'floor', 'ceil', 'abs'];

/** Whether a name is one of the language's own functions. */
export const isBuiltin = (name: string): name is BuiltinName => Object.hasOwn(BUILTINS, name);
