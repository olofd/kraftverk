import type { HistoryFn } from '../rule.ts';
import type { KindDocs } from './spec.ts';

/*
  A reading over the time just gone, as data: each way of looking back once
  — its name, how a sentence says it, its page — and what it makes of what
  the home kept: the reading's values, each holding from its time until the
  next, the one holding as the time began first, the reading now last.
*/

/** How far back a rule may look: from a minute to the two weeks the home keeps minute by minute. */
export const HISTORY_SECONDS = { min: 60, max: 14 * 86_400 } as const;

/** One value a reading held from `at` (ms) until the next: what history is made of. */
export type HistoryPoint = { at: number; value: number };

export type HistorySpec = {
  name: HistoryFn;
  label: string;
  /** In a sentence: "the average of Garage station’s charge over the last 1 h". `of`: the reading's words; `over`: the time's. */
  words: (of: string, over: string) => string;
  /** What it makes of the points, from `from` to `to` (ms): null when they tell nothing. */
  of: (points: readonly HistoryPoint[], from: number, to: number) => number | null;
  docs: KindDocs;
};

/** The value holding at `at`: the last that began at or before it. */
const holding = (points: readonly HistoryPoint[], at: number): number | null => {
  let found: number | null = null;
  for (const point of points) if (point.at <= at) found = point.value;
  return found;
};

const values = (points: readonly HistoryPoint[]) => points.map((point) => point.value);

/** Every way of looking back, by its name. */
export const HISTORY_FNS: { readonly [F in HistoryFn]: HistorySpec } = {
  average: {
    name: 'average',
    label: 'The average',
    words: (of, over) => `the average of ${of} over the last ${over}`,
    // By the time each value held: a minute at 10 W and an hour at 20 W is nearly 20 W, not 15.
    of: (points, from, to) => {
      const start = Math.max(from, points[0]?.at ?? to);
      if (!points.length || to <= start) return points.at(-1)?.value ?? null;
      let total = 0;
      points.forEach((point, index) => {
        const begins = Math.max(point.at, start);
        const ends = Math.min(points[index + 1]?.at ?? to, to);
        if (ends > begins) total += point.value * (ends - begins);
      });
      return total / (to - start);
    },
    docs: { summary: 'The average of a reading over the time just gone, each value weighed by how long it held — in the reading’s unit.', examples: ['average(station.charge, 1 h)', 'average(charger.power, setting.window) > 50 W'] },
  },
  lowest: {
    name: 'lowest',
    label: 'The lowest',
    words: (of, over) => `the lowest ${of} over the last ${over}`,
    of: (points) => (points.length ? Math.min(...values(points)) : null),
    docs: { summary: 'The lowest a reading was over the time just gone, in its unit.', examples: ['lowest(station.charge, 1 d) < 10 %'] },
  },
  highest: {
    name: 'highest',
    label: 'The highest',
    words: (of, over) => `the highest ${of} over the last ${over}`,
    of: (points) => (points.length ? Math.max(...values(points)) : null),
    docs: { summary: 'The highest a reading was over the time just gone, in its unit.', examples: ['highest(charger.power, 10 min) < 5 W'] },
  },
  change: {
    name: 'change',
    label: 'How much it changed',
    words: (of, over) => `how much ${of} changed over the last ${over}`,
    of: (points, from, to) => {
      const then = holding(points, from);
      const now = holding(points, to);
      return then !== null && now !== null ? now - then : null;
    },
    docs: { summary: 'How much a reading changed over the time just gone: now, less what it was then — in its unit; unknown when either is.', examples: ['change(station.charge, 30 min) > 5 %'] },
  },
  ago: {
    name: 'ago',
    label: 'What it was then',
    words: (of, over) => `${of} ${over} ago`,
    of: (points, from) => holding(points, from),
    docs: { summary: 'What a reading was, so long ago — in its unit; unknown when nothing was kept of it then.', examples: ['ago(station.charge, 10 min)'] },
  },
};

/** The order the reference lists them in. */
export const HISTORY_ORDER: readonly HistoryFn[] = ['average', 'lowest', 'highest', 'change', 'ago'];

export const isHistoryFn = (name: string): name is HistoryFn => Object.hasOwn(HISTORY_FNS, name);
