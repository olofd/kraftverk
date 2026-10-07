/**
 * Every unit kraftverk knows (docs/ARCHITECTURE.md §4.2): what a device
 * reports a number in, what a setting is set in, what a rule writes beside a
 * number — `2 kW`, `90 %`, `2 min`. One enumeration, so a unit is never free
 * text: a description naming one not here does not compile, and one arriving
 * as data (a description from another node, a rule from a file) is refused;
 * the app offers them from a list, never a text field.
 *
 * Each unit says what it measures (its dimension) and how it converts to
 * the first unit of that dimension: a number meets another of its dimension
 * converted — `2 kW` beside a reading in W is 2000 — and never one of
 * another. A price is in its provider's currency: no rate between
 * currencies is kraftverk's to know, so each is a dimension of its own.
 */

/** What a unit measures physically: what it converts within. */
export type Dimension =
  | 'power'
  | 'energy'
  | 'current'
  | 'voltage'
  | 'frequency'
  | 'time'
  | 'ratio'
  | 'temperature'
  | 'length'
  | 'speed'
  | 'irradiance'
  | 'signal'
  | 'illuminance'
  | 'angle'
  | 'price.EUR'
  | 'price.SEK'
  | 'price.NOK'
  | 'price.DKK';

/** A unit: what it is called in words, what it measures, and how it converts — `value · factor + offset` in its dimension's first unit. */
export type UnitSpec = { label: string; dimension: Dimension; factor: number; offset?: number };

export const UNITS = {
  W: { label: 'watts', dimension: 'power', factor: 1 },
  kW: { label: 'kilowatts', dimension: 'power', factor: 1_000 },
  MW: { label: 'megawatts', dimension: 'power', factor: 1_000_000 },
  Wh: { label: 'watt-hours', dimension: 'energy', factor: 1 },
  kWh: { label: 'kilowatt-hours', dimension: 'energy', factor: 1_000 },
  MWh: { label: 'megawatt-hours', dimension: 'energy', factor: 1_000_000 },
  A: { label: 'amperes', dimension: 'current', factor: 1 },
  mA: { label: 'milliamperes', dimension: 'current', factor: 0.001 },
  V: { label: 'volts', dimension: 'voltage', factor: 1 },
  mV: { label: 'millivolts', dimension: 'voltage', factor: 0.001 },
  kV: { label: 'kilovolts', dimension: 'voltage', factor: 1_000 },
  Hz: { label: 'hertz', dimension: 'frequency', factor: 1 },
  kHz: { label: 'kilohertz', dimension: 'frequency', factor: 1_000 },
  s: { label: 'seconds', dimension: 'time', factor: 1 },
  min: { label: 'minutes', dimension: 'time', factor: 60 },
  h: { label: 'hours', dimension: 'time', factor: 3_600 },
  d: { label: 'days', dimension: 'time', factor: 86_400 },
  '%': { label: 'percent', dimension: 'ratio', factor: 1 },
  '°C': { label: 'degrees Celsius', dimension: 'temperature', factor: 1 },
  '°F': { label: 'degrees Fahrenheit', dimension: 'temperature', factor: 5 / 9, offset: -32 * (5 / 9) },
  K: { label: 'kelvin', dimension: 'temperature', factor: 1, offset: -273.15 },
  mm: { label: 'millimetres', dimension: 'length', factor: 0.001 },
  cm: { label: 'centimetres', dimension: 'length', factor: 0.01 },
  m: { label: 'metres', dimension: 'length', factor: 1 },
  km: { label: 'kilometres', dimension: 'length', factor: 1_000 },
  mi: { label: 'miles', dimension: 'length', factor: 1_609.344 },
  'm/s': { label: 'metres a second', dimension: 'speed', factor: 1 },
  'km/h': { label: 'kilometres an hour', dimension: 'speed', factor: 1 / 3.6 },
  mph: { label: 'miles an hour', dimension: 'speed', factor: 0.44704 },
  'W/m²': { label: 'watts a square metre', dimension: 'irradiance', factor: 1 },
  dBm: { label: 'decibel-milliwatts', dimension: 'signal', factor: 1 },
  lx: { label: 'lux', dimension: 'illuminance', factor: 1 },
  // A latitude or a longitude: a position's.
  '°': { label: 'degrees', dimension: 'angle', factor: 1 },
  'EUR/kWh': { label: 'euros a kilowatt-hour', dimension: 'price.EUR', factor: 1 },
  'SEK/kWh': { label: 'kronor a kilowatt-hour', dimension: 'price.SEK', factor: 1 },
  'NOK/kWh': { label: 'Norwegian kroner a kilowatt-hour', dimension: 'price.NOK', factor: 1 },
  'DKK/kWh': { label: 'Danish kroner a kilowatt-hour', dimension: 'price.DKK', factor: 1 },
} as const satisfies Record<string, UnitSpec>;

/** A unit kraftverk knows: never free text. */
export type Unit = keyof typeof UNITS;

/** Every unit, in the table's order: what a list of them offers. */
export const UNIT_LIST: readonly Unit[] = Object.keys(UNITS) as Unit[];

/** Whether a text is a unit kraftverk knows: what data arriving from outside is held to. */
export const isUnit = (text: unknown): text is Unit => typeof text === 'string' && Object.hasOwn(UNITS, text);

/** A unit's description. */
export const unitSpec = (unit: Unit): UnitSpec => UNITS[unit];

/** Whether a number in one unit can be put in the other: they measure the same. */
export const convertible = (from: Unit, to: Unit): boolean => UNITS[from].dimension === UNITS[to].dimension;

/** The units a number in this one may be put in, itself first: what a list beside it offers. */
export const unitsLike = (unit: Unit): Unit[] => [unit, ...UNIT_LIST.filter((other) => other !== unit && convertible(unit, other))];

/** A converted number without the float's dust: 2.2 kW is 2200 W, not 2200.0000000000005. */
const clean = (value: number): number => Math.round(value * 1e9) / 1e9;

/** A number in one unit, in another; null when they do not measure the same. */
export function convert(value: number, from: Unit, to: Unit): number | null {
  if (from === to) return value;
  if (!convertible(from, to)) return null;
  const a: UnitSpec = UNITS[from];
  const b: UnitSpec = UNITS[to];
  return clean((value * a.factor + (a.offset ?? 0) - (b.offset ?? 0)) / b.factor);
}

/**
 * What two numbers make, multiplied or divided: the unit the result is in —
 * null, a plain number — and what the plain product or quotient of the two
 * numbers, each in its own unit, is multiplied by to be in it.
 */
export type Combined = { unit: Unit | null; factor: number };


/** Units whose zero is not nothing — degrees Celsius, Fahrenheit — are added and compared, never multiplied. */
const scales = (unit: Unit): boolean => unitSpec(unit).offset === undefined;

/**
 * Two numbers multiplied: a plain number keeps the other's unit; a
 * percentage is a share of what it multiplies (50 % of 2 kWh is 1 kWh); a
 * power for a time is an energy (2 kW for 2 h is 4000 Wh). Anything else
 * makes no unit kraftverk knows: null.
 */
export function product(a: Unit | null, b: Unit | null): Combined | null {
  if (a === null || b === null) {
    const unit = a ?? b;
    return unit === null || scales(unit) ? { unit, factor: 1 } : null;
  }
  if (a === '%' || b === '%') {
    const other = a === '%' ? b : a;
    return scales(other) ? { unit: other, factor: 0.01 } : null;
  }
  const [power, time] = unitSpec(a).dimension === 'power' ? [a, b] : [b, a];
  if (unitSpec(power).dimension === 'power' && unitSpec(time).dimension === 'time') return { unit: 'Wh', factor: (unitSpec(power).factor * unitSpec(time).factor) / 3_600 };
  return null;
}

/**
 * One number divided by another: by a plain number, the same unit; two of
 * one dimension, a plain number (2 kW / 500 W is 4); by a percentage, the
 * whole of which it is that share; an energy by a time, a power; an energy
 * by a power, a time. Anything else makes no unit kraftverk knows: null.
 */
export function quotient(a: Unit | null, b: Unit | null): Combined | null {
  if (b === null) return a === null || scales(a) ? { unit: a, factor: 1 } : null;
  if (a === null) return null;
  if (!scales(a) || !scales(b)) return null;
  if (b === '%') return { unit: a, factor: 100 };
  const [top, bottom] = [unitSpec(a), unitSpec(b)];
  if (top.dimension === bottom.dimension) return { unit: null, factor: top.factor / bottom.factor };
  if (top.dimension === 'energy' && bottom.dimension === 'time') return { unit: 'W', factor: (top.factor * 3_600) / bottom.factor };
  if (top.dimension === 'energy' && bottom.dimension === 'power') return { unit: 's', factor: (top.factor * 3_600) / bottom.factor };
  return null;
}

/**
 * A length of time in the largest unit that says it whole — 120 s is 2 min,
 * 90 s stays 90 s — as a setting kept in seconds is written into a rule.
 */
export function wholeTime(seconds: number): { value: number; unit: Unit } {
  if (seconds !== 0 && seconds % 86_400 === 0) return { value: seconds / 86_400, unit: 'd' };
  if (seconds !== 0 && seconds % 3_600 === 0) return { value: seconds / 3_600, unit: 'h' };
  if (seconds !== 0 && seconds % 60 === 0) return { value: seconds / 60, unit: 'min' };
  return { value: seconds, unit: 's' };
}
