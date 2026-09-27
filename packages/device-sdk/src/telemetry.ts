/**
 * Telemetry: what a device measures, and what each measurement means.
 *
 * Two names for every metric, on purpose (docs/ARCHITECTURE.md §4.2):
 *
 * - `key` is what is **stored**. History is keyed by `(device, key)`, so a key
 *   never changes once a device type has shipped. Keys are local to a type —
 *   a station's `soc`, a plug's `watts` — and nothing outside the type reads
 *   them for their meaning.
 * - `metric` is what it **means**: a standard id such as `battery.soc`. The
 *   generic dashboard, charts that compare devices, and automations ("when any
 *   battery is below 20 %") work from this, and never from a key.
 *
 * Keeping them apart is what lets meaning be added to a type without rewriting
 * a single stored sample.
 */

/**
 * How a value behaves, which decides how it is formatted and charted.
 *
 * Adding a kind is a decision about every device at once — the app has to know
 * how to draw it — which is the friction that keeps this list short.
 */
export type MetricKind =
  | 'power'
  | 'energy'
  | 'percent'
  | 'voltage'
  | 'current'
  | 'temperature'
  | 'frequency'
  | 'duration'
  /** On/off, present/absent. Charted as a band, not a line. */
  | 'state';

export type MetricSpec = {
  /** What history is stored under. Stable forever once shipped. */
  key: string;
  label: string;
  unit: string;
  kind: MetricKind;
  /**
   * The standard id this measurement is, when one applies (`STANDARD_METRICS`),
   * or one namespaced by the device type (`s1w.powerFactor`). Absent when it
   * means nothing beyond its label.
   */
  metric?: string;
  precision?: number;
  /** A counter that only rises. Charted as change per interval. */
  cumulative?: boolean;
  /** The one shown on the device's card. At most one per device type. */
  primary?: boolean;
};

export type Reading = {
  key: string;
  /** Null is "not known", never zero and never false. */
  value: number | boolean | null;
  /** When the device actually produced it — not when we asked. */
  at: string;
};

/** The reading for one key, or null when the device has not reported it. */
export const readingOf = (readings: readonly Reading[], key: string): Reading | null =>
  readings.find((reading) => reading.key === key) ?? null;

/** The measurement a card should lead with. */
export const primaryOf = <T extends Pick<MetricSpec, 'primary'>>(telemetry: readonly T[]): T | null =>
  telemetry.find((spec) => spec.primary) ?? telemetry[0] ?? null;

// --- the standard ids -------------------------------------------------------

type StandardMetric = { label: string; unit: string; kind: MetricKind; cumulative?: boolean };

/**
 * Metrics that mean the same thing on every device that has them.
 *
 * Deliberately few, and added to only when something — a chart, an automation,
 * a capability — needs to find a quantity on devices it knows nothing about. A
 * device that measures one of these declares it with the same unit and kind,
 * so two devices' values can be put on one axis without conversion.
 */
export const STANDARD_METRICS = {
  'battery.soc': { label: 'Charge', unit: '%', kind: 'percent' },
  'battery.capacity': { label: 'Capacity', unit: 'Wh', kind: 'energy' },
  /** Everything coming in, from any source. */
  'power.in': { label: 'Input', unit: 'W', kind: 'power' },
  'power.in.ac': { label: 'From mains', unit: 'W', kind: 'power' },
  'power.in.solar': { label: 'Solar', unit: 'W', kind: 'power' },
  /** Everything a device supplies to what is plugged into it. */
  'power.out': { label: 'Output', unit: 'W', kind: 'power' },
  /** What a device, or what is plugged through it, consumes: a plug's meter. */
  'power.draw': { label: 'Power', unit: 'W', kind: 'power' },
  'energy.total': { label: 'Energy', unit: 'kWh', kind: 'energy', cumulative: true },
  'voltage.ac': { label: 'Voltage', unit: 'V', kind: 'voltage' },
  'grid.present': { label: 'Mains present', unit: '', kind: 'state' },
  'switch.on': { label: 'On', unit: '', kind: 'state' },
  'weather.temp': { label: 'Temperature', unit: '°C', kind: 'temperature' },
  'weather.cloud': { label: 'Cloud cover', unit: '%', kind: 'percent' },
} as const satisfies Record<string, StandardMetric>;

export type StandardMetricId = keyof typeof STANDARD_METRICS;

/**
 * Per-outlet metrics, one pair for each outlet a device has: `outlet.ac.on`,
 * `outlet.usb.power`. Templated because the outlets are the device's own.
 */
const OUTLET_METRIC = /^outlet\.([a-z0-9-]+)\.(on|power)$/;

/** The standard a metric id claims to be, or null when it is a type's own. */
export function standardMetric(id: string): StandardMetric | null {
  if (id in STANDARD_METRICS) return STANDARD_METRICS[id as StandardMetricId];
  const outlet = OUTLET_METRIC.exec(id);
  if (!outlet) return null;
  return outlet[2] === 'on'
    ? { label: 'On', unit: '', kind: 'state' }
    : { label: 'Power', unit: 'W', kind: 'power' };
}

/** The namespaces the standard ids live in, which a type's own metrics may not use. */
export const STANDARD_NAMESPACES: readonly string[] = [
  ...new Set([...Object.keys(STANDARD_METRICS).map((id) => id.split('.')[0]!), 'outlet']),
];

/** The measurement of a device's telemetry that means `metric`, if it has one. */
export const metricOf = <T extends Pick<MetricSpec, 'metric'>>(telemetry: readonly T[], metric: string): T | null =>
  telemetry.find((spec) => spec.metric === metric) ?? null;
