/**
 * What a value means, in words every device shares (docs/ARCHITECTURE.md §4.2).
 *
 * An attribute has two names on purpose. Its **key** is what history is kept
 * under, local to its type — a station's `soc`, a plug's `watts`. Its
 * **meaning** is what it is, in words every device uses — `battery.soc`,
 * `power.draw` — and is what the generic screens, charts that compare devices,
 * automations and the bridges to Home Assistant and Matter work from. Keeping
 * them apart lets meaning be added to a type without touching what it stored.
 */

/**
 * What a number is a quantity of, which decides how it is formatted, charted
 * and projected into the standards. Adding one is a decision about every
 * device at once — the app has to know how to draw it — which keeps it short.
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
  /** On/off, present/absent. Charted as a band, not a line. */
  | 'state';

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
  'state',
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

export type StandardMeaning = { label: string; unit: string; quantity: Quantity; stateClass?: StateClass };

/**
 * Meanings every device that has them shares.
 *
 * Deliberately few, and added to only when something — a chart, an automation,
 * a capability, a bridge — needs to find a quantity on devices it knows nothing
 * about. An attribute that claims one keeps its unit, quantity and state class,
 * so two devices' values share an axis without conversion.
 */
export const STANDARD_MEANINGS = {
  'battery.soc': { label: 'Charge', unit: '%', quantity: 'percent' },
  'battery.capacity': { label: 'Capacity', unit: 'Wh', quantity: 'energy' },
  /** Everything coming in, from any source. */
  'power.in': { label: 'Input', unit: 'W', quantity: 'power' },
  'power.in.ac': { label: 'From mains', unit: 'W', quantity: 'power' },
  'power.in.solar': { label: 'Solar', unit: 'W', quantity: 'power' },
  /** Everything a device supplies to what is plugged into it. */
  'power.out': { label: 'Output', unit: 'W', quantity: 'power' },
  /** What a device, or what is plugged through it, consumes: a plug's meter, an outlet's draw. */
  'power.draw': { label: 'Power', unit: 'W', quantity: 'power' },
  /** A meter's own lifetime counter. */
  'energy.total': { label: 'Energy', unit: 'kWh', quantity: 'energy', stateClass: 'total_increasing' },
  'voltage.ac': { label: 'Voltage', unit: 'V', quantity: 'voltage' },
  'current.ac': { label: 'Current', unit: 'A', quantity: 'current' },
  'frequency.ac': { label: 'Frequency', unit: 'Hz', quantity: 'frequency' },
  'grid.present': { label: 'Mains present', unit: '', quantity: 'state' },
  'switch.on': { label: 'On', unit: '', quantity: 'state' },
  'weather.temp': { label: 'Temperature', unit: '°C', quantity: 'temperature' },
  'weather.cloud': { label: 'Cloud cover', unit: '%', quantity: 'percent' },
} as const satisfies Record<string, StandardMeaning>;

export type StandardMeaningId = keyof typeof STANDARD_MEANINGS;

/** The standard a meaning is, or null when it is a type's own. */
export const standardMeaning = (id: string): StandardMeaning | null =>
  Object.hasOwn(STANDARD_MEANINGS, id) ? STANDARD_MEANINGS[id as StandardMeaningId] : null;

/** The namespaces the standard meanings live in, which a type's own meanings may not use. */
export const STANDARD_NAMESPACES: readonly string[] = [...new Set(Object.keys(STANDARD_MEANINGS).map((id) => id.split('.')[0]!))];
