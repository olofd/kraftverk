import type { Unit } from './units.ts';
import type { ObjectValue, ValueType } from './values.ts';

/**
 * Quantities: what a value is a quantity of, as records (docs/PLAN-INTEGRATIONS.md
 * §4.5) — which decides how it is checked, formatted, charted and projected
 * into the standards. Each is one row: what a value of it is, how many
 * decimals it is shown with, where its chart's axis starts, and its Home
 * Assistant device class. Adding one is a row here, reviewed, because the
 * app draws every device's by it.
 *
 * Most are a number in one of their units. A few are a value with
 * structure, of one shape every device shares: a position is a latitude, a
 * longitude and how sure it is, never three numbers a reader must pair up.
 * An on/off is not a quantity: it is a boolean, drawn as a band.
 */

/** What a value of a quantity is: a number in one of its units, or a value of a shape of its own. */
export type QuantityValue = { type: 'number'; units: readonly Unit[] } | { type: 'object'; shape: ObjectValue };

/** Where a chart of a number's axis starts: at zero (no power is nothing happening), where the data does (mains voltage), or fixed bounds. */
export type QuantityAxis = 'zero' | 'data' | readonly [number, number];

export type QuantitySpec = {
  label: string;
  value: QuantityValue;
  /** Decimals a number is shown with, unless its attribute says. */
  precision: number;
  /** A number's chart axis; none for a value with structure, which is not charted as a line. */
  axis: QuantityAxis | null;
  /** Home Assistant's device class for it, or null where it has none and shows the unit as given. */
  homeAssistant: string | null;
};

/**
 * Where something is on the Earth (WGS 84): degrees north and east, and how
 * far it may be from there, in metres, when the device says.
 */
export const POSITION_SHAPE = {
  type: 'object',
  fields: {
    latitude: { type: 'number', unit: '°', min: -90, max: 90 },
    longitude: { type: 'number', unit: '°', min: -180, max: 180 },
    accuracy: { type: 'number', unit: 'm', min: 0 },
  },
  required: ['latitude', 'longitude'],
} as const satisfies ObjectValue;

/** A position as it travels. */
export type Position = { readonly latitude: number; readonly longitude: number; readonly accuracy?: number | null };

/**
 * Where something is on a device's own map of a home — a robot cleaner's, a
 * radar's, a room's beacons' — in metres along its x and y axes, and how far
 * it may be from there. Its map is anchored by where the device is placed:
 * its origin at the placement's x and y, its y axis turned by its facing.
 */
export const SPOT_SHAPE = {
  type: 'object',
  fields: {
    x: { type: 'number', unit: 'm' },
    y: { type: 'number', unit: 'm' },
    accuracy: { type: 'number', unit: 'm', min: 0 },
  },
  required: ['x', 'y'],
} as const satisfies ObjectValue;

/** A spot as it travels. */
export type Spot = { readonly x: number; readonly y: number; readonly accuracy?: number | null };

const number = (units: readonly Unit[]): QuantityValue => ({ type: 'number', units });

/** Every quantity, by its name. */
export const QUANTITY_SPECS = {
  power: { label: 'Power', value: number(['W', 'kW', 'MW']), precision: 0, axis: 'zero', homeAssistant: 'power' },
  energy: { label: 'Energy', value: number(['Wh', 'kWh', 'MWh']), precision: 0, axis: 'zero', homeAssistant: 'energy' },
  percent: { label: 'Percentage', value: number(['%']), precision: 0, axis: [0, 100], homeAssistant: null },
  voltage: { label: 'Voltage', value: number(['V', 'mV', 'kV']), precision: 1, axis: 'data', homeAssistant: 'voltage' },
  current: { label: 'Current', value: number(['A', 'mA']), precision: 2, axis: 'zero', homeAssistant: 'current' },
  temperature: { label: 'Temperature', value: number(['°C', '°F', 'K']), precision: 1, axis: 'data', homeAssistant: 'temperature' },
  frequency: { label: 'Frequency', value: number(['Hz', 'kHz']), precision: 2, axis: 'data', homeAssistant: 'frequency' },
  duration: { label: 'Duration', value: number(['s', 'min', 'h', 'd']), precision: 0, axis: 'zero', homeAssistant: 'duration' },
  humidity: { label: 'Humidity', value: number(['%']), precision: 0, axis: [0, 100], homeAssistant: 'humidity' },
  illuminance: { label: 'Illuminance', value: number(['lx']), precision: 0, axis: 'zero', homeAssistant: 'illuminance' },
  /** Radio signal strength, in dBm. Diagnostic by nature. */
  signal: { label: 'Signal strength', value: number(['dBm']), precision: 0, axis: 'data', homeAssistant: 'signal_strength' },
  /** How far: a vehicle's range, its odometer, how far a phone is from home. */
  distance: { label: 'Distance', value: number(['mm', 'cm', 'm', 'km', 'mi']), precision: 0, axis: 'zero', homeAssistant: 'distance' },
  /** How fast something moves. */
  speed: { label: 'Speed', value: number(['m/s', 'km/h', 'mph']), precision: 0, axis: 'zero', homeAssistant: 'speed' },
  /** What energy costs, in a currency per unit: "SEK/kWh". */
  price: { label: 'Price', value: number(['EUR/kWh', 'SEK/kWh', 'NOK/kWh', 'DKK/kWh']), precision: 2, axis: 'data', homeAssistant: 'monetary' },
  /** A place in an order, 1 first: the cheapest hour of the day. No unit. */
  rank: { label: 'Rank', value: number([]), precision: 0, axis: 'data', homeAssistant: null },
  /** How many of something there are: the people a sensor counts in a room. No unit. */
  count: { label: 'Count', value: number([]), precision: 0, axis: 'zero', homeAssistant: null },
  /** Where something is: a phone, a scooter, a tag (`POSITION_SHAPE`). Home Assistant tracks one as a device tracker, not a sensor. */
  position: { label: 'Position', value: { type: 'object', shape: POSITION_SHAPE }, precision: 5, axis: null, homeAssistant: null },
  /** Where something is on a device's own map of a home, in metres (`SPOT_SHAPE`). */
  spot: { label: 'Where in the home', value: { type: 'object', shape: SPOT_SHAPE }, precision: 2, axis: null, homeAssistant: null },
} as const satisfies Record<string, QuantitySpec>;

export type Quantity = keyof typeof QUANTITY_SPECS;

/** Every quantity, in the table's order. */
export const QUANTITIES: readonly Quantity[] = Object.keys(QUANTITY_SPECS) as Quantity[];

export const isQuantity = (name: unknown): name is Quantity => typeof name === 'string' && Object.hasOwn(QUANTITY_SPECS, name);

/** A quantity's record, typed wide enough to read. */
export const quantitySpec = (quantity: Quantity): QuantitySpec => QUANTITY_SPECS[quantity];

/** The units a number of this quantity may be in: none for one of no unit (a rank), or one with structure. */
export const unitsOfQuantity = (quantity: Quantity): readonly Unit[] => {
  const value = quantitySpec(quantity).value;
  return value.type === 'number' ? value.units : [];
};

/** Whether a quantity is a number, rather than a value with structure. */
export const isNumberQuantity = (quantity: Quantity): boolean => quantitySpec(quantity).value.type === 'number';

/**
 * Whether a value type is of a shape: the same type, and for an object the
 * same fields — each of the shape's own, a number in the shape's unit — and
 * the same of them required. Its bounds may be narrower: a device may know
 * its accuracy is never above 50 m.
 */
export function fitsShape(type: ValueType, shape: ValueType): boolean {
  if (type.type !== shape.type) return false;
  if (type.type === 'number' && shape.type === 'number') return type.unit === shape.unit;
  if (type.type === 'list' && shape.type === 'list') return fitsShape(type.of, shape.of);
  if (type.type === 'object' && shape.type === 'object') {
    const [fields, wanted] = [Object.keys(type.fields).sort(), Object.keys(shape.fields).sort()];
    const required = (object: ObjectValue) => [...(object.required ?? [])].sort().join();
    return fields.join() === wanted.join() && required(type) === required(shape) && wanted.every((field) => fitsShape(type.fields[field]!, shape.fields[field]!));
  }
  return true;
}

/** What a quantity a value type is of fits, said; null when it fits. */
export function quantityProblem(quantity: Quantity, type: ValueType): string | null {
  const value = quantitySpec(quantity).value;
  if (value.type === 'object') return fitsShape(type, value.shape) ? null : `a ${quantity} is a value of its own shape: ${Object.keys(value.shape.fields).join(', ')}`;
  if (type.type !== 'number') return `a ${quantity} is a number`;
  if (type.unit === undefined ? value.units.length > 0 : !value.units.includes(type.unit)) return `a ${quantity} is ${value.units.length ? `in ${value.units.map((unit) => `"${unit}"`).join(', ')}` : 'in no unit'}`;
  return null;
}

/** Whether a value is a position: a latitude and a longitude on the globe, and an accuracy if any. */
export function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { latitude, longitude, accuracy } = value as Record<string, unknown>;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    (accuracy === undefined || accuracy === null || (typeof accuracy === 'number' && accuracy >= 0))
  );
}

/** Whether a value is a spot: metres along a device's own map's axes, and an accuracy if any. */
export function isSpot(value: unknown): value is Spot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { x, y, accuracy } = value as Record<string, unknown>;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) && (accuracy === undefined || accuracy === null || (typeof accuracy === 'number' && accuracy >= 0));
}

/** The Earth's mean radius, in metres: what a distance over its surface is measured on. */
const EARTH_RADIUS_M = 6_371_008.8;

/** How far apart two places are over the Earth's surface, in metres — the great circle, by the haversine. */
export function distanceBetween(a: Pick<Position, 'latitude' | 'longitude'>, b: Pick<Position, 'latitude' | 'longitude'>): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
