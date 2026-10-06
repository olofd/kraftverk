import type { AcrossFn } from '../rule.ts';
import type { KindDocs } from './spec.ts';

/*
  Something of each part of a group, taken together, as data: each way once —
  what it takes of each part (a condition, or a number), what it makes of
  them, how a sentence says it, and its page. Unknown for one part is
  unknown for all, but where one part settles it: one false for `all`, one
  true for `any`. Where a part may not say, `??` gives it a value of its own.
*/

export type AcrossSpec = {
  name: AcrossFn;
  label: string;
  /** What it asks of each part: whether something holds, or a number. */
  takes: 'condition' | 'number';
  /** In a sentence: the parts, by name — "Garage plug and Scooter plug" — and what is said of each. */
  words: (group: string, each: string) => string;
  /** What it makes of each part's answer, in order: null for one not known. */
  of: (values: readonly (number | boolean | null)[]) => number | boolean | null;
  docs: KindDocs;
};

const numbers = (values: readonly (number | boolean | null)[]): number[] | null => (values.every((value) => typeof value === 'number') ? (values as number[]) : null);

/** Every way of taking a group's parts together, by its name. */
export const ACROSS_FNS: { readonly [F in AcrossFn]: AcrossSpec } = {
  all: {
    name: 'all',
    label: 'All of them',
    takes: 'condition',
    words: (group, each) => `for all of ${group}, ${each}`,
    of: (values) => (values.includes(false) ? false : values.includes(null) ? null : true),
    docs: { summary: 'Whether something holds for every part of a group: one that does not is enough to say no; with none that does not, one that cannot tell leaves it unknown.', examples: ['all(c in chargers: c.power < 5 W)'] },
  },
  any: {
    name: 'any',
    label: 'Any of them',
    takes: 'condition',
    words: (group, each) => `for any of ${group}, ${each}`,
    of: (values) => (values.includes(true) ? true : values.includes(null) ? null : false),
    docs: { summary: 'Whether something holds for at least one part of a group: one that does is enough; with none that does, one that cannot tell leaves it unknown.', examples: ['any(c in chargers: c.power > 10 W)', 'any(c in chargers: not c reachable)'] },
  },
  count: {
    name: 'count',
    label: 'How many',
    takes: 'condition',
    words: (group, each) => `how many of ${group} have it that ${each}`,
    of: (values) => (values.includes(null) ? null : values.filter((value) => value === true).length),
    docs: { summary: 'How many parts of a group something holds for: a plain number — unknown while it cannot be told for one.', examples: ['count(c in chargers: c.power > 10 W) >= 2'] },
  },
  sum: {
    name: 'sum',
    label: 'The sum',
    takes: 'number',
    words: (group, each) => `the sum of ${each}, across ${group}`,
    of: (values) => numbers(values)?.reduce((total, value) => total + value, 0) ?? null,
    docs: { summary: 'A number of each part of a group, added up, in the first one’s unit — each converted to it. Unknown while one is not known: `?? 0 W` counts one that is not as nothing.', examples: ['sum(c in chargers: c.power) > 2 kW', 'sum(c in chargers: c.power ?? 0 W)'] },
  },
  average: {
    name: 'average',
    label: 'The average',
    takes: 'number',
    words: (group, each) => `the average of ${each}, across ${group}`,
    of: (values) => {
      const known = numbers(values);
      return known?.length ? known.reduce((total, value) => total + value, 0) / known.length : null;
    },
    docs: { summary: 'The average of a number of each part of a group, in the first one’s unit. Unknown while one is not known.', examples: ['average(b in batteries: b.charge) < 30 %'] },
  },
  lowest: {
    name: 'lowest',
    label: 'The lowest',
    takes: 'number',
    words: (group, each) => `the lowest of ${each}, across ${group}`,
    of: (values) => {
      const known = numbers(values);
      return known?.length ? Math.min(...known) : null;
    },
    docs: { summary: 'The lowest of a number of each part of a group, in the first one’s unit. Unknown while one is not known.', examples: ['lowest(b in batteries: b.charge) < 10 %'] },
  },
  highest: {
    name: 'highest',
    label: 'The highest',
    takes: 'number',
    words: (group, each) => `the highest of ${each}, across ${group}`,
    of: (values) => {
      const known = numbers(values);
      return known?.length ? Math.max(...known) : null;
    },
    docs: { summary: 'The highest of a number of each part of a group, in the first one’s unit. Unknown while one is not known.', examples: ['highest(c in chargers: c.power) > 1 kW'] },
  },
};

/** The order the reference lists them in. */
export const ACROSS_ORDER: readonly AcrossFn[] = ['all', 'any', 'count', 'sum', 'average', 'lowest', 'highest'];

export const isAcrossFn = (name: string): name is AcrossFn => Object.hasOwn(ACROSS_FNS, name);
