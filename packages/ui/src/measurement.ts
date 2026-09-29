import { enumLabel, quantityOf, unitOf, type AttributeSpec, type Quantity, type Reading, type Value } from '@kraftverk/device-sdk';

import { formatDuration, formatWatts, formatWh } from './format';

/**
 * How to draw a number nobody wrote a screen for.
 *
 * Every device describes its attributes: what type of value each is, and for a
 * number what quantity. That description is the whole interface: this file
 * turns it into formatting, an axis and a sense of what zero means, so a plug
 * added next year gets a card and a chart without a line of code for it.
 *
 * The rule the quantities encode: a *unit* says what the number is, a
 * *quantity* says how it behaves. Two quantities in watts read the same; a percentage and a
 * temperature both fit 0–100 but only one of them should start its axis at zero.
 */

export const readingFor = (readings: readonly Reading[], key: string): Reading | undefined =>
  readings.find((reading) => reading.key === key);

/**
 * When the device last actually said something.
 *
 * The most recent `at` across every reading — which is the device's own clock,
 * not ours. A device that is answering happily while reporting a timestamp from
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
 * Generous on purpose: the sampler runs every minute and a slow device can miss
 * one. Two of them is a device that has stopped talking.
 */
export const STALE_AFTER_MS = 150_000;

export const isStale = (at: string | null): boolean =>
  at === null || Date.now() - Date.parse(at) > STALE_AFTER_MS;

/** How many decimals a kind is worth, when the device does not say. */
const DEFAULT_PRECISION: Record<Quantity, number> = {
  power: 0,
  energy: 0,
  percent: 0,
  voltage: 1,
  current: 2,
  temperature: 1,
  frequency: 2,
  duration: 0,
  humidity: 0,
  illuminance: 0,
  signal: 0,
  state: 0,
};

type Formatted = Pick<AttributeSpec, 'value' | 'quantity' | 'means'>;

/**
 * One value, as a person would read it.
 *
 * `null` is rendered as an em dash rather than a zero. A device that has not
 * reported is not a device reporting nothing, and the difference matters most
 * exactly when something has gone wrong. An enum shows its label; on/off shows
 * as words.
 */
export function formatValue(attribute: Formatted, value: Value | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return attribute.value.type === 'enum' ? enumLabel(attribute.value, value) : value;
  if (!Number.isFinite(value)) return '—';

  const quantity = quantityOf(attribute);
  const unit = unitOf(attribute);
  const precision = attribute.value.type === 'number' ? attribute.value.precision : undefined;
  switch (quantity) {
    case 'state':
      return value ? 'On' : 'Off';
    case 'power':
      // The shared formatter knows when to switch to kW; it only applies when
      // the device is actually counting watts.
      return unit === 'W' ? formatWatts(value) : withUnit(unit, precision ?? 0, value);
    case 'energy':
      return unit === 'Wh' ? formatWh(value) : withUnit(unit, precision ?? 0, value);
    case 'percent':
      return `${value.toFixed(precision ?? 0)}%`;
    case 'duration': {
      // By the unit it declares, and nothing else: no unit, no guess.
      const minutes = DURATION_MINUTES[unit];
      return minutes === undefined ? withUnit(unit, precision ?? 0, value) : formatDuration(value * minutes);
    }
    default:
      return withUnit(unit, precision ?? (quantity ? DEFAULT_PRECISION[quantity] : 0), value);
  }
}

/** How many minutes one of each duration unit is. */
const DURATION_MINUTES: Record<string, number> = { ms: 1 / 60_000, s: 1 / 60, min: 1, h: 60, d: 1440 };

const withUnit = (unit: string, digits: number, value: number): string => {
  const number = value.toFixed(digits);
  // Degrees hug their number; every other unit takes a space.
  return unit.startsWith('°') ? `${number}${unit}` : `${number} ${unit}`.trim();
};

/**
 * Where a kind's axis should start.
 *
 * Zero for anything where zero means "nothing is happening" — no power, no
 * charge. Not for mains voltage or room temperature, where a zero-based axis
 * compresses the whole interesting range into a band a few pixels tall.
 */
export const startsAtZero = (quantity: Quantity | null): boolean =>
  quantity === 'power' || quantity === 'energy' || quantity === 'percent' || quantity === 'current' ||
  quantity === 'duration' || quantity === 'state' || quantity === 'illuminance';

/** A percentage is 0–100 whatever the data did; nothing else has fixed bounds. */
export const fixedRange = (quantity: Quantity | null): [number, number] | null =>
  quantity === 'percent' || quantity === 'humidity' ? [0, 100] : quantity === 'state' ? [0, 1] : null;

/**
 * What a card shows, in order: the attribute marked primary, then the others a
 * person reads — never settings, never diagnostics.
 */
export const shownAttributes = (attributes: readonly AttributeSpec[]): AttributeSpec[] => {
  const readable = attributes.filter((attribute) => attribute.category !== 'config' && attribute.category !== 'diagnostic');
  return [...readable.filter((attribute) => attribute.category === 'primary'), ...readable.filter((attribute) => attribute.category !== 'primary')];
};
