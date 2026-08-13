import type { Dps } from './session.ts';

/**
 * Per-model knowledge, as data.
 *
 * A new Tuya plug should be a profile, not a plugin: this file is where "which
 * datapoint is the relay, and what scale is the voltage" lives, so supporting
 * another socket is ~15 lines and a test fixture. It is the same structural
 * choice make-all/tuya-local made, and the reason that project covers hundreds
 * of devices without hundreds of integrations.
 */

export type Metric = { dp: number; scale: number };

export type DeviceProfile = {
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

/**
 * ATORCH S1W / S1WP / S1BW.
 *
 * Datapoints taken from the published Home Assistant work on this exact family
 * (make-all/tuya-local issues #3253 and #1103) — see docs/PLUGIN-ARCHITECTURE.md
 * §11.2 for the citations.
 *
 * ⚠️ The relay datapoint is the one thing the sources disagree about: the Tuya
 * product specification says DP 1, while the OpenBeken community reports that
 * on this ATORCH the real relay control is DP 131. `relayDp` is therefore
 * overridable in configuration, and `test()` dumps every datapoint so the
 * question is settled by the hardware rather than by a guess.
 */
export const ATORCH_S1: DeviceProfile = {
  id: 'atorch-s1',
  label: 'ATORCH S1W / S1WP / S1BW',
  relay: { dp: 1 },
  metrics: {
    amps: { dp: 18, scale: 3 },
    watts: { dp: 19, scale: 2 },
    volts: { dp: 20, scale: 2 },
    kwh: { dp: 123, scale: 2 },
    hz: { dp: 133, scale: 2 },
    powerFactor: { dp: 134, scale: 2 },
  },
  notes: 'Relay may be DP 1 or DP 131 depending on firmware — confirm with Test.',
};

/** The layout most generic Tuya energy sockets use. */
export const GENERIC_TUYA_PLUG: DeviceProfile = {
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

export const PROFILES: readonly DeviceProfile[] = [ATORCH_S1, GENERIC_TUYA_PLUG];

export const profileById = (id: string): DeviceProfile =>
  PROFILES.find((profile) => profile.id === id) ?? ATORCH_S1;

const read = (dps: Dps, metric: Metric | undefined): number | undefined => {
  if (!metric) return undefined;
  const raw = dps[String(metric.dp)];
  if (typeof raw !== 'number') return undefined;
  return raw / 10 ** metric.scale;
};

export type DecodedReading = {
  relayOn: boolean | undefined;
  volts?: number;
  amps?: number;
  watts?: number;
  kwh?: number;
  hz?: number;
  powerFactor?: number;
};

/** Turns a raw datapoint set into engineering units, per the profile. */
export function decode(profile: DeviceProfile, dps: Dps, relayDp = profile.relay.dp): DecodedReading {
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
 * Which datapoints could plausibly be the relay, for the Test report.
 *
 * Booleans only, most likely candidates first. This is what turns "the sources
 * disagree" into a five-second experiment: flip the plug at the wall, dump
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
