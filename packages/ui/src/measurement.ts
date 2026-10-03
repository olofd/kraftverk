import { enumLabel, isCurrent, quantityOf, unitOf, type AttributeSpec, type Quantity, type Reading, type Value } from '@kraftverk/device-sdk';

import { formatDuration, formatWatts, formatWh } from './format.ts';

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

/**
 * A value that is known but no longer current: observed longer ago than its
 * attribute says a value stays current (`AttributeSpec.currentFor`) — two
 * minutes for power, an hour for a forecast. Shown, because it is what the
 * device last said, but as old, with when it was observed: the same rule
 * history and the gateway keep.
 */
export const isOld = (attribute: Pick<AttributeSpec, 'currentFor' | 'stateClass' | 'value'>, reading: Reading | null | undefined, now = Date.now()): boolean =>
  Boolean(reading && reading.value !== null && !isCurrent(attribute, reading, now));

/** When an old value was observed, as a person reads it: "14:02" today, "3 Oct 14:02" before. */
export function observedAt(at: string, now = new Date()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return when.toDateString() === now.toDateString() ? time : `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** How many decimals a kind is worth, when the device does not say. */
const DEFAULT_PRECISION: Record<Quantity, number> = {
  price: 2,
  rank: 0,
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
  distance: 0,
  speed: 0,
};

type Formatted = Pick<AttributeSpec, 'value' | 'quantity' | 'means'>;

/** An on/off in its own words, where it has them: "Yes", "Armed". */
const onOff = (attribute: Formatted, on: boolean): string => {
  const words = attribute.value.type === 'boolean' ? attribute.value.words : undefined;
  return words ? words[on ? 'true' : 'false'] : on ? 'On' : 'Off';
};

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
  if (typeof value === 'boolean') return onOff(attribute, value);
  if (typeof value === 'string') {
    if (attribute.value.type === 'enum') return enumLabel(attribute.value, value);
    return attribute.value.type === 'timestamp' ? observedAt(value) : value;
  }
  // A list or an object is drawn by what knows its shape, not as one value.
  if (typeof value !== 'number') return Array.isArray(value) ? `${value.length} values` : '…';
  if (!Number.isFinite(value)) return '—';
  // An on/off kept as 1 or 0 — as history keeps one — still reads as on or off.
  if (attribute.value.type === 'boolean') return onOff(attribute, value !== 0);

  const quantity = quantityOf(attribute);
  const unit = unitOf(attribute);
  const precision = attribute.value.type === 'number' ? attribute.value.precision : undefined;
  switch (quantity) {
    case 'power':
      // The shared formatter knows when to switch to kW; it only applies when
      // the device is actually counting watts.
      return unit === 'W' ? formatWatts(value) : withUnit(unit, precision ?? 0, value);
    case 'energy':
      return unit === 'Wh' ? formatWh(value) : withUnit(unit, precision ?? 0, value);
    case 'percent':
      return `${fixed(value, precision ?? 0)}%`;
    case 'duration': {
      // By the unit it declares, and nothing else: no unit, no guess.
      const minutes = DURATION_MINUTES[unit];
      // None at all is a length too: "0 s", not the mark for nothing said.
      return minutes === undefined || value === 0 ? withUnit(unit, precision ?? 0, value) : formatDuration(value * minutes);
    }
    default:
      return withUnit(unit, precision ?? (quantity ? DEFAULT_PRECISION[quantity] : 0), value);
  }
}

/** How many minutes one of each duration unit is. */
const DURATION_MINUTES: Record<string, number> = { ms: 1 / 60_000, s: 1 / 60, min: 1, h: 60, d: 1440 };

/** A number to so many digits — and what rounds to nothing is "0.00", never "-0.00". */
const fixed = (value: number, digits: number): string => {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? text.replace(/^-/, '') : text;
};

const withUnit = (unit: string, digits: number, value: number): string => {
  const number = fixed(value, digits);
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
  quantity === 'duration' || quantity === 'illuminance' || quantity === 'distance' || quantity === 'speed';

/** A percentage is 0–100 whatever the data did; nothing else has fixed bounds. */
export const fixedRange = (quantity: Quantity | null): [number, number] | null =>
  quantity === 'percent' || quantity === 'humidity' ? [0, 100] : null;

/**
 * What a card shows, in order: the attribute marked primary, then the others a
 * person reads — never settings, never diagnostics.
 */
export const shownAttributes = (attributes: readonly AttributeSpec[]): AttributeSpec[] => {
  const readable = attributes.filter((attribute) => attribute.category !== 'config' && attribute.category !== 'diagnostic');
  return [...readable.filter((attribute) => attribute.category === 'primary'), ...readable.filter((attribute) => attribute.category !== 'primary')];
};
