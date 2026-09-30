import type { AttributeSpec, EventLevel, Value } from '@kraftverk/device-sdk';

/**
 * Tuya's energy sockets, as data: which datapoint is the relay and how it is
 * written, what scale each measurement is sent in, and — for a model that has
 * them — the settings and sensors beyond the relay and the meter.
 *
 * Tuya defines standard datapoints per product category, and its sockets (`cz`)
 * mostly follow them — but models differ in scale, and some switch the relay
 * somewhere else entirely (a text datapoint, well away from DP 1). So a socket is
 * described by a *profile*, and supporting the next plug is a profile rather
 * than code. It is the same structural choice make-all/tuya-local made, and the
 * reason that project covers hundreds of devices.
 *
 * The conventions live in the protocol because they are Tuya's; which profile a
 * product uses is its device type's.
 */

export type Dps = Record<string, string | number | boolean>;

export type Metric = { dp: number; scale: number };

export type RelaySpec = {
  /** The datapoint that switches the relay. */
  dp: number;
  /** What is written for on and off; `true` and `false` when absent. */
  on?: string;
  off?: string;
  /**
   * A datapoint that only reports the relay, consulted when the switching one
   * says neither on nor off (an `auto`, where the plug's own mode drives it).
   */
  status?: number;
  /**
   * While the switching datapoint says neither, this datapoint holding anything
   * but `clear` means the plug's own logic has cut the relay — a plug that names
   * the mode that cut it there, and does not always say so on its status.
   */
  cutWhile?: { dp: number; clear: string };
};

/**
 * One more datapoint, as the attribute it becomes. Numbers arrive as integers
 * multiplied by 10^scale; text arrives as the plug's own words, which `wire`
 * translates to the attribute's options (`wire: { off: 'colse' }` — sic). Where
 * several of the plug's words mean one thing, the first is the one written.
 */
export type ProfileDatapoint = AttributeSpec & {
  dp: number;
  scale?: number;
  wire?: Readonly<Record<string, string | readonly string[]>>;
  /** What a simulated plug of this profile reports. */
  example: Value;
  /** A value other than `clear` is an event: a protection trip, a mode that cut the relay. */
  raises?: { event: string; label: string; level: EventLevel; clear: string };
};

export type SocketProfile = {
  id: string;
  label: string;
  /** Reported in the discovery broadcast; used to suggest a profile. */
  productKeys?: readonly string[];
  relay: RelaySpec;
  metrics: {
    volts?: Metric;
    amps?: Metric;
    watts?: Metric;
    kwh?: Metric;
    hz?: Metric;
    powerFactor?: Metric;
  };
  datapoints?: readonly ProfileDatapoint[];
  notes?: string;
};

/** The layout most generic Tuya energy sockets use. */
export const GENERIC_SOCKET: SocketProfile = {
  id: 'generic-tuya-plug',
  label: 'Generic Tuya energy socket',
  relay: { dp: 1 },
  metrics: {
    amps: { dp: 18, scale: 3 },
    watts: { dp: 19, scale: 1 },
    volts: { dp: 20, scale: 1 },
    kwh: { dp: 17, scale: 2 },
  },
};

const read = (dps: Dps, metric: Metric | undefined): number | undefined => {
  if (!metric) return undefined;
  const raw = dps[String(metric.dp)];
  if (typeof raw !== 'number') return undefined;
  return raw / 10 ** metric.scale;
};

export type SocketReading = {
  relayOn: boolean | undefined;
  volts?: number;
  amps?: number;
  watts?: number;
  kwh?: number;
  hz?: number;
  powerFactor?: number;
};

/** Whether the relay is on, as the profile says to read it. */
export function relayOf(relay: RelaySpec, dps: Dps): boolean | undefined {
  const raw = dps[String(relay.dp)];
  if (relay.on !== undefined && raw === relay.on) return true;
  if (relay.off !== undefined && raw === relay.off) return false;
  if (relay.on === undefined && typeof raw === 'boolean') return raw;
  if (relay.on === undefined && typeof raw === 'number') return raw !== 0;
  if (raw === undefined && relay.status === undefined) return undefined;
  // Neither on nor off: the plug's own logic has it.
  if (relay.cutWhile) {
    const cut = dps[String(relay.cutWhile.dp)];
    if (cut !== undefined && cut !== relay.cutWhile.clear) return false;
  }
  const status = relay.status === undefined ? undefined : dps[String(relay.status)];
  return typeof status === 'boolean' ? status : undefined;
}

/** The datapoints that switch the relay on or off. */
export const relayDps = (relay: RelaySpec, on: boolean): Dps => ({ [String(relay.dp)]: on ? (relay.on ?? true) : (relay.off ?? false) });

/** Turns a raw datapoint set into engineering units, per the profile. */
export function decodeSocket(profile: SocketProfile, dps: Dps): SocketReading {
  return {
    relayOn: relayOf(profile.relay, dps),
    volts: read(dps, profile.metrics.volts),
    amps: read(dps, profile.metrics.amps),
    watts: read(dps, profile.metrics.watts),
    kwh: read(dps, profile.metrics.kwh),
    hz: read(dps, profile.metrics.hz),
    powerFactor: read(dps, profile.metrics.powerFactor),
  };
}

/** A profile datapoint's value, from what the plug sent: `null` when it has not said, or said something unknown. */
export function datapointValue(point: ProfileDatapoint, dps: Dps): Value {
  const raw = dps[String(point.dp)];
  if (raw === undefined) return null;
  switch (point.value.type) {
    case 'number':
      return typeof raw === 'number' ? raw / 10 ** (point.scale ?? 0) : null;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null;
    case 'enum': {
      const text = String(raw);
      const option = point.wire ? (Object.entries(point.wire).find(([, wire]) => (typeof wire === 'string' ? wire === text : wire.includes(text)))?.[0] ?? text) : text;
      return point.value.options.some((known) => known.value === option) ? option : null;
    }
    default:
      return String(raw);
  }
}

/** The raw datapoint a value is written as. */
export function datapointRaw(point: ProfileDatapoint, value: Value): string | number | boolean {
  if (point.value.type === 'number') return Math.round(Number(value) * 10 ** (point.scale ?? 0));
  if (point.value.type === 'boolean') return Boolean(value);
  const text = String(value);
  const wire = point.wire?.[text];
  return wire === undefined ? text : typeof wire === 'string' ? wire : (wire[0] ?? text);
}

/**
 * The reverse: a reading as a socket with this profile would send it — for a
 * simulator, which then answers exactly as a plug of that layout does, and
 * for tests.
 */
export function encodeSocket(profile: SocketProfile, reading: SocketReading, values: Readonly<Record<string, Value>> = {}): Dps {
  const dps: Dps = {};
  if (reading.relayOn !== undefined) {
    Object.assign(dps, relayDps(profile.relay, reading.relayOn));
    if (profile.relay.status !== undefined) dps[String(profile.relay.status)] = reading.relayOn;
  }
  for (const [name, metric] of Object.entries(profile.metrics) as [keyof SocketProfile['metrics'], Metric | undefined][]) {
    const value = reading[name];
    if (metric && value !== undefined) dps[String(metric.dp)] = Math.round(value * 10 ** metric.scale);
  }
  for (const point of profile.datapoints ?? []) {
    const value = values[point.key] ?? point.example;
    if (value !== null) dps[String(point.dp)] = datapointRaw(point, value);
  }
  return dps;
}
