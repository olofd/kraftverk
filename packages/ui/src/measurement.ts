import type { MeasurementSpec, Reading } from '@kraftverk/plugin-sdk';

import { formatDuration, formatWatts, formatWh } from './format';

/**
 * How to draw a number nobody wrote a screen for.
 *
 * Every device declares what it measures and what kind each quantity is. That
 * declaration is the whole interface: this file turns a kind into formatting,
 * an axis and a sense of what zero means, so a plug added next year gets a card
 * and a chart without a line of code being written for it.
 *
 * The rule the kinds encode: a *unit* says what the number is, a *kind* says how
 * it behaves. Two quantities in watts read the same; a percentage and a
 * temperature both fit 0–100 but only one of them should start its axis at zero.
 */

export const readingFor = (readings: readonly Reading[], key: string): Reading | undefined =>
  readings.find((reading) => reading.key === key);

/**
 * When the device last actually said something.
 *
 * The most recent `at` across every reading — which is the device's own clock,
 * not ours. A driver that is answering happily while reporting a timestamp from
 * ten minutes ago is exactly the failure this exists to catch.
 */
export function freshestAt(readings: readonly Reading[]): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;

  for (const reading of readings) {
    const ms = Date.parse(reading.at);
    if (Number.isFinite(ms) && ms > newestMs) {
      newestMs = ms;
      newest = reading.at;
    }
  }
  return newest;
}

/**
 * How long a reading may go unrefreshed before it stops counting as live.
 *
 * Generous on purpose: the sampler runs every minute and a slow driver can miss
 * one. Two of them is a device that has stopped talking.
 */
export const STALE_AFTER_MS = 150_000;

export const isStale = (at: string | null): boolean =>
  at === null || Date.now() - Date.parse(at) > STALE_AFTER_MS;

/** How many decimals a kind is worth, when the device does not say. */
const DEFAULT_PRECISION: Record<MeasurementSpec['kind'], number> = {
  power: 0,
  energy: 0,
  percent: 0,
  voltage: 1,
  current: 2,
  temperature: 1,
  frequency: 2,
  duration: 0,
  state: 0,
};

/**
 * One reading, as a person would read it.
 *
 * `null` is rendered as an em dash rather than a zero. A device that has not
 * reported is not a device reporting nothing, and the difference matters most
 * exactly when something has gone wrong.
 */
export function formatMeasurement(spec: MeasurementSpec, value: number | boolean | null): string {
  if (value === null || value === undefined) return '—';

  if (spec.kind === 'state' || typeof value === 'boolean') {
    return value === true || value === 1 ? 'On' : 'Off';
  }
  if (!Number.isFinite(value)) return '—';

  switch (spec.kind) {
    case 'power':
      // The shared formatter knows when to switch to kW; it only applies when
      // the device is actually counting watts.
      return spec.unit === 'W' ? formatWatts(value) : withUnit(spec, value);
    case 'energy':
      return spec.unit === 'Wh' ? formatWh(value) : withUnit(spec, value);
    case 'percent':
      return `${value.toFixed(spec.precision ?? 0)}%`;
    case 'duration':
      // Declared in minutes by convention, which is what the station reports.
      return formatDuration(spec.unit === 'min' ? value : value / 60);
    default:
      return withUnit(spec, value);
  }
}

const withUnit = (spec: MeasurementSpec, value: number): string => {
  const digits = spec.precision ?? DEFAULT_PRECISION[spec.kind];
  const number = value.toFixed(digits);
  // Degrees hug their number; every other unit takes a space.
  return spec.unit.startsWith('°') ? `${number}${spec.unit}` : `${number} ${spec.unit}`.trim();
};

/**
 * Where a kind's axis should start.
 *
 * Zero for anything where zero means "nothing is happening" — no power, no
 * charge. Not for mains voltage or room temperature, where a zero-based axis
 * compresses the whole interesting range into a band a few pixels tall.
 */
export const startsAtZero = (kind: MeasurementSpec['kind']): boolean =>
  kind === 'power' || kind === 'energy' || kind === 'percent' || kind === 'current' ||
  kind === 'duration' || kind === 'state';

/** A percentage is 0–100 whatever the data did; nothing else has fixed bounds. */
export const fixedRange = (kind: MeasurementSpec['kind']): [number, number] | null =>
  kind === 'percent' ? [0, 100] : kind === 'state' ? [0, 1] : null;

/** The measurement a card should lead with, and a chart should open on. */
export const primaryMeasurement = (
  measurements: readonly MeasurementSpec[]
): MeasurementSpec | null =>
  measurements.find((measurement) => measurement.primary) ?? measurements[0] ?? null;
