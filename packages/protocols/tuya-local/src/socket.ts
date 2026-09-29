/**
 * Tuya's energy sockets, as data: which datapoint is the relay, and what scale
 * each measurement is sent in.
 *
 * Tuya defines standard datapoints per product category, and its sockets (`cz`)
 * mostly follow them — but models differ in scale, and one of them disagrees
 * about the relay (docs/ATORCH-S1W.md §2). So a socket is described by a
 * *profile*: ~15 lines of data per model, and supporting the next plug is a
 * profile rather than code. It is the same structural choice make-all/tuya-local
 * made, and the reason that project covers hundreds of devices.
 *
 * The conventions live in the protocol because they are Tuya's; which profile a
 * product uses is its device type's.
 */

export type Dps = Record<string, string | number | boolean>;

export type Metric = { dp: number; scale: number };

export type SocketProfile = {
  id: string;
  label: string;
  /** Reported in the discovery broadcast; used to suggest a profile. */
  productKeys?: readonly string[];
  relay: { dp: number };
  metrics: {
    volts?: Metric;
    amps?: Metric;
    watts?: Metric;
    kwh?: Metric;
    hz?: Metric;
    powerFactor?: Metric;
  };
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

/** Turns a raw datapoint set into engineering units, per the profile. */
export function decodeSocket(profile: SocketProfile, dps: Dps, relayDp = profile.relay.dp): SocketReading {
  const relay = dps[String(relayDp)];
  return {
    relayOn: typeof relay === 'boolean' ? relay : typeof relay === 'number' ? relay !== 0 : undefined,
    volts: read(dps, profile.metrics.volts),
    amps: read(dps, profile.metrics.amps),
    watts: read(dps, profile.metrics.watts),
    kwh: read(dps, profile.metrics.kwh),
    hz: read(dps, profile.metrics.hz),
    powerFactor: read(dps, profile.metrics.powerFactor),
  };
}

/**
 * The reverse: a reading as a socket with this profile would send it — for a
 * simulator, which then answers exactly as a plug of that layout does, and
 * for tests.
 */
export function encodeSocket(profile: SocketProfile, reading: SocketReading, relayDp = profile.relay.dp): Dps {
  const dps: Dps = {};
  if (reading.relayOn !== undefined) dps[String(relayDp)] = reading.relayOn;
  for (const [name, metric] of Object.entries(profile.metrics) as [keyof SocketProfile['metrics'], Metric | undefined][]) {
    const value = reading[name];
    if (metric && value !== undefined) dps[String(metric.dp)] = Math.round(value * 10 ** metric.scale);
  }
  return dps;
}

/**
 * Which datapoints could plausibly be the relay.
 *
 * Booleans only, the documented ones first. This is what turns "the sources
 * disagree" into a five-second experiment: flip the plug at the wall, read
 * again, and see which boolean moved.
 */
export function relayCandidates(dps: Dps): number[] {
  const preferred = [1, 131];
  return Object.entries(dps)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([dp]) => Number(dp))
    .filter((dp) => Number.isFinite(dp))
    .sort((a, b) => {
      const rank = (dp: number) => (preferred.indexOf(dp) < 0 ? preferred.length : preferred.indexOf(dp));
      return rank(a) - rank(b) || a - b;
    });
}
