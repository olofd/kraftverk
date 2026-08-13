import type { MeasurementSpec } from '@kraftverk/plugin-sdk';

import { fixedRange, startsAtZero } from './measurement';

/**
 * The arithmetic behind a chart, with no chart in sight.
 *
 * Kept apart from the component that draws it for two reasons. It is the part
 * that can be wrong in ways nobody sees — an axis that silently starts at the
 * wrong place, a gap quietly joined into a line that invents data — so it is
 * the part worth testing. And a device package that wants to draw its own
 * chart should be able to reuse the decisions without reusing the pixels.
 */

export type SeriesPoint = { at: string; value: number };

export type ChartScale = {
  /** Bottom of the axis. */
  min: number;
  /** Top of the axis. */
  max: number;
  /** The largest value actually recorded, which is not the same as `max`. */
  peak: number;
  /** The smallest value actually recorded. */
  trough: number;
};

/**
 * Where the vertical axis starts and ends.
 *
 * Every decision here comes from the measurement's *kind*, which is why no
 * device has to describe its own chart: a percentage is 0–100 whatever today's
 * data did, power starts at zero because zero means "nothing is happening", and
 * mains voltage does not — a zero-based axis would squash 230 V ± 5 into a
 * couple of pixels and hide exactly the variation worth seeing.
 */
export function chartScale(
  points: readonly SeriesPoint[],
  measurement: Pick<MeasurementSpec, 'kind'>
): ChartScale {
  const values = points.map((point) => point.value).filter((value) => Number.isFinite(value));
  const peak = values.length ? Math.max(...values) : 0;
  const trough = values.length ? Math.min(...values) : 0;

  const fixed = fixedRange(measurement.kind);
  if (fixed) return { min: fixed[0], max: fixed[1], peak, trough };

  const zeroed = startsAtZero(measurement.kind);
  let min = zeroed ? Math.min(0, trough) : trough;
  let max = peak;

  // A flat line still deserves an axis. Without this the range is zero, every
  // point lands on the same pixel row, and the division below is a divide by
  // nothing.
  if (max - min < 1e-6) return { min: min - 1, max: max + 1, peak, trough };

  const headroom = (max - min) * 0.1;
  max += headroom;
  if (!zeroed) min -= headroom;

  return { min, max, peak, trough };
}

/** The sampler's cadence. Anything at or under this is a normal interval. */
const SAMPLE_MS = 60_000;
/** How many intervals of silence it takes before a line is broken. */
const GAP_FACTOR = 3;

/**
 * Runs of points close enough in time to be worth joining.
 *
 * The sampler skips a reading it never got rather than writing a zero, so a
 * device that was unreachable for an hour leaves a hole. Joining across it
 * would draw a confident straight line through data nobody recorded, which is
 * the one thing a chart must not do.
 *
 * Returned as index ranges into the original array, not as slices: the x
 * positions stay keyed to the whole series, so a gap leaves a gap rather than
 * closing up.
 */
export function chartSegments(points: readonly SeriesPoint[]): [number, number][] {
  if (points.length < 2) return [];

  // Thinned series carry a wider natural stride than the sampler's minute, so
  // the threshold follows the data's own spacing rather than a fixed constant.
  const span = Date.parse(points.at(-1)!.at) - Date.parse(points[0]!.at);
  const stride = Math.max(SAMPLE_MS, span / points.length);
  const limit = stride * GAP_FACTOR;

  const runs: [number, number][] = [];
  let start = 0;

  for (let index = 1; index < points.length; index++) {
    const gap = Date.parse(points[index]!.at) - Date.parse(points[index - 1]!.at);
    if (gap > limit) {
      if (index - start > 1) runs.push([start, index - 1]);
      start = index;
    }
  }

  if (points.length - start > 1) runs.push([start, points.length - 1]);
  return runs;
}

export type ChartBox = { width: number; height: number };

/** An SVG path for one run of points, positioned against the whole series. */
export function chartPath(
  points: readonly SeriesPoint[],
  [from, to]: [number, number],
  box: ChartBox,
  scale: ChartScale
): string {
  const first = Date.parse(points[0]!.at);
  const span = Math.max(1, Date.parse(points.at(-1)!.at) - first);

  let path = '';
  for (let index = from; index <= to; index++) {
    const point = points[index]!;
    const x = ((Date.parse(point.at) - first) / span) * box.width;
    path += `${index === from ? 'M' : 'L'}${x.toFixed(1)},${chartY(point.value, scale, box.height).toFixed(1)}`;
  }
  return path;
}

/** A value's vertical position, with the origin at the top as SVG has it. */
export const chartY = (value: number, scale: ChartScale, height: number): number =>
  height - ((value - scale.min) / (scale.max - scale.min)) * height;
