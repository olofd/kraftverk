/**
 * What a value means, in words every device shares (docs/ARCHITECTURE.md §4.2).
 *
 * An attribute has two names on purpose. Its **key** is what history is kept
 * under, local to its type — a station's `soc`, a plug's `watts`. Its
 * **meaning** is what it is, in words every device uses — `battery.soc`,
 * `power.draw` — and is what the generic screens, charts that compare devices,
 * automations and the bridges to Home Assistant and Matter work from. Keeping
 * them apart lets meaning be added to a type without touching what it stored.
 *
 * A meaning is named by what is measured — `temperature.air`, not the weather
 * service's temperature — and the part it is on says where: an outdoor
 * thermometer, a BTHome sensor and a forecast all report the air's temperature.
 */

/**
 * What a number is a quantity of, which decides how it is formatted, charted
 * and projected into the standards. Adding one is a decision about every
 * device at once — the app has to know how to draw it — which keeps it short.
 * An on/off is not a quantity: it is a boolean, drawn as a band.
 */
export type Quantity =
  | 'power'
  | 'energy'
  | 'percent'
  | 'voltage'
  | 'current'
  | 'temperature'
  | 'frequency'
  | 'duration'
  | 'humidity'
  | 'illuminance'
  /** Radio signal strength, in dBm. Diagnostic by nature. */
  | 'signal'
  /** How far: a vehicle's range, its odometer. */
  | 'distance'
  /** How fast something moves. */
  | 'speed';

export const QUANTITIES: readonly Quantity[] = [
  'power',
  'energy',
  'percent',
  'voltage',
  'current',
  'temperature',
  'frequency',
  'duration',
  'humidity',
  'illuminance',
  'signal',
  'distance',
  'speed',
];

/**
 * How a value moves over time, which decides how history treats it — the same
 * three Home Assistant uses:
 *
 * - `measurement` — a value now: power, a temperature.
 * - `total` — a running amount that may go down or restart: today's energy.
 * - `total_increasing` — a counter that only rises, whose fall means the
 *   device restarted it: a meter's lifetime energy.
 */
export type StateClass = 'measurement' | 'total' | 'total_increasing';

export const STATE_CLASSES: readonly StateClass[] = ['measurement', 'total', 'total_increasing'];

/**
 * A standard meaning: a number, with the unit, quantity and state class every
 * attribute claiming it keeps — or an on/off.
 */
export type StandardMeaning =
  | { label: string; type: 'number'; unit: string; quantity: Quantity; stateClass?: StateClass }
  | { label: string; type: 'boolean' };

/**
 * Meanings every device that has them shares.
 *
 * Deliberately few, and added to only when something — a chart, an automation,
 * a capability, a bridge — needs to find a quantity on devices it knows nothing
 * about, and with the first device that has one, not before. An attribute that
 * claims one keeps its unit, quantity and state class, so two devices' values
 * share an axis without conversion.
 */
export const STANDARD_MEANINGS = {
  'battery.soc': { label: 'Charge', type: 'number', unit: '%', quantity: 'percent' },
  'battery.capacity': { label: 'Capacity', type: 'number', unit: 'Wh', quantity: 'energy' },
  /** A setting a station keeps: the charge it stops charging from mains at. */
  'battery.chargeLimit': { label: 'Charge limit', type: 'number', unit: '%', quantity: 'percent' },
  /** A setting a station keeps: the charge below which it stops supplying its outputs. */
  'battery.dischargeFloor': { label: 'Discharge floor', type: 'number', unit: '%', quantity: 'percent' },
  /** Everything coming in, from any source. */
  'power.in': { label: 'Input', type: 'number', unit: 'W', quantity: 'power' },
  'power.in.ac': { label: 'From mains', type: 'number', unit: 'W', quantity: 'power' },
  'power.in.solar': { label: 'Solar', type: 'number', unit: 'W', quantity: 'power' },
  /** A setting a station keeps: how hard it charges from mains, at most. */
  'power.in.ac.max': { label: 'Mains charging power', type: 'number', unit: 'W', quantity: 'power' },
  /** Everything a device supplies to what is plugged into it. */
  'power.out': { label: 'Output', type: 'number', unit: 'W', quantity: 'power' },
  /** What a device, or what is plugged through it, consumes: a plug's meter, an outlet's draw. */
  'power.draw': { label: 'Power', type: 'number', unit: 'W', quantity: 'power' },
  /** A meter's own lifetime counter. */
  'energy.total': { label: 'Energy', type: 'number', unit: 'kWh', quantity: 'energy', stateClass: 'total_increasing' },
  'voltage.ac': { label: 'Voltage', type: 'number', unit: 'V', quantity: 'voltage' },
  'current.ac': { label: 'Current', type: 'number', unit: 'A', quantity: 'current' },
  'frequency.ac': { label: 'Frequency', type: 'number', unit: 'Hz', quantity: 'frequency' },
  'grid.present': { label: 'Mains present', type: 'boolean' },
  'switch.on': { label: 'On', type: 'boolean' },
  /** The air's temperature, where the part is: outdoors, a room, the hour a forecast is for. */
  'temperature.air': { label: 'Temperature', type: 'number', unit: '°C', quantity: 'temperature' },
  /** How much of the sky is cloud, measured or forecast. */
  'sky.cloudCover': { label: 'Cloud cover', type: 'number', unit: '%', quantity: 'percent' },
} as const satisfies Record<string, StandardMeaning>;

export type StandardMeaningId = keyof typeof STANDARD_MEANINGS;

/** The standard a meaning is, or null when it is a type's own. */
export const standardMeaning = (id: string): StandardMeaning | null =>
  Object.hasOwn(STANDARD_MEANINGS, id) ? STANDARD_MEANINGS[id as StandardMeaningId] : null;

/** The namespaces the standard meanings live in, which a type's own meanings may not use. */
export const STANDARD_NAMESPACES: readonly string[] = [...new Set(Object.keys(STANDARD_MEANINGS).map((id) => id.split('.')[0]!))];
