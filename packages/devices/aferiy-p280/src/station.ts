import {
  validateConfig,
  type CapabilityImpl,
  type CapabilityName,
  type CommandResult,
  type ConfigValues,
  type ConnectionHealth,
  type DeviceSession,
  type Reading,
} from '@kraftverk/device-sdk';
import type { PortId, StationSettings, StationSettingsPatch, StationStatus } from '@kraftverk/protocol';

import { CAPABILITIES, readings, SETTINGS_SCHEMA, settingsToValues, valuesToSettings } from './index.ts';

/**
 * A P280, as a device session: what the station driver reports, in the shared
 * vocabulary of readings, capabilities and settings.
 *
 * The same adapter serves the real station and the simulator. What differs is
 * only where the driver comes from — the simulator is built here; a real
 * station's driver is still opened and bound by the server's connection
 * manager, and lent to this session through `STATION_LINKS` until the P280
 * package holds its own links (docs/ARCHITECTURE.md, step 10).
 */

/** What this session needs from a driver: `StationClient` and the simulator both fit. */
export interface StationDriverLike {
  status(): StationStatus;
  /** Null until the station's settings have been read from it. */
  settings(): StationSettings | null;
  applySettings(patch: StationSettingsPatch): Promise<StationSettings | null>;
  setPort(id: PortId, enabled: boolean): Promise<StationStatus>;
}

/**
 * The server's station links, by name in `ctx.transports`.
 *
 * Transitional: the connection manager in the server still decides which
 * station a saved device is bound to, and holds the link. This is how a P280
 * session asks it for the driver — and why there is none, when there isn't.
 */
export const STATION_LINKS = 'sydpower.station-links';

export type StationLookup =
  | { driver: StationDriverLike; transport: string }
  | { driver: null; reason: string | null };

export type StationLinks = { lookup(deviceId: string): StationLookup };

/** A session that can also hand over its driver, for the core's remaining P280 routes. */
export type StationSession = DeviceSession & {
  /** The driver behind this session, while one is open. Transitional: see `STATION_LINKS`. */
  station(): StationDriverLike | null;
};

/** The outlets a P280 has. The light is a setting, not an outlet: see `CONTROLS`. */
const OUTLETS: readonly PortId[] = ['ac', 'dc', 'usb'];

const failed = (error: unknown): CommandResult => ({
  accepted: false,
  error: error instanceof Error ? error.message : String(error),
});

export function stationSession(
  lookup: () => StationLookup,
  options: {
    /** The station the device is bound to, for identity while no link is open. */
    boundId?: string | null;
    close?: () => void | Promise<void>;
  } = {}
): StationSession {
  const open = () => {
    const found = lookup();
    return found.driver ? found : null;
  };
  /** The latest status, but only once the station has actually reported. */
  const reported = (): StationStatus | null => {
    const status = open()?.driver.status() ?? null;
    return status && status.lastUpdated !== null ? status : null;
  };

  const battery: CapabilityImpl['battery'] = {
    read: () => {
      const status = reported();
      return status ? { socPercent: status.level, capacityWh: status.capacityWh || null, at: status.lastUpdated! } : null;
    },
  };

  const acInput: CapabilityImpl['acInput'] = {
    read: () => {
      const status = reported();
      return status ? { present: status.gridConnected, watts: status.acInputWatts, at: status.lastUpdated! } : null;
    },
  };

  const outlets: CapabilityImpl['outlets'] = {
    read: () => {
      const status = reported();
      if (!status) return null;
      return {
        at: status.lastUpdated!,
        outlets: OUTLETS.map((id) => {
          const port = status.ports.find((candidate) => candidate.id === id);
          return { id, label: port?.label ?? id, on: port?.enabled ?? null, watts: port?.watts ?? null };
        }),
      };
    },
    set: async (outletId, on) => {
      const link = open();
      if (!link) return { accepted: false, error: 'The station is not connected' };
      if (!OUTLETS.includes(outletId as PortId)) return { accepted: false, error: `A P280 has no outlet "${outletId}"` };
      try {
        await link.driver.setPort(outletId as PortId, on);
        return { accepted: true };
      } catch (error) {
        return failed(error);
      }
    },
  };

  const offered: Partial<CapabilityImpl> = { battery, acInput, outlets };

  return {
    health(): ConnectionHealth {
      const found = lookup();
      if (!found.driver) {
        return {
          // A reason is something the user has to resolve — the station is held
          // by another saved device — while no link at all is just quiet.
          status: found.reason ? 'error' : 'offline',
          detail: found.reason ?? 'The server is not holding a link to it',
          owner: 'server',
          transport: null,
          lastReadingAt: null,
        };
      }
      const status = found.driver.status();
      const simulated = status.link.mode === 'simulator';
      const connected = simulated || status.link.state === 'connected';
      return {
        status: connected ? 'connected' : status.link.state === 'waiting' ? 'connecting' : 'offline',
        detail: connected
          ? simulated
            ? 'Simulated'
            : 'Connected'
          : status.link.state === 'waiting'
            ? 'Looking for the station'
            : 'The station has not connected',
        owner: 'server',
        transport: simulated ? 'sim' : (status.link.transport ?? found.transport),
        lastReadingAt: connected ? status.lastUpdated : status.link.lastSeen,
      };
    },

    readings(): Reading[] {
      const status = open()?.driver.status();
      return status ? readings(status) : [];
    },

    capability<N extends CapabilityName>(name: N): CapabilityImpl[N] | null {
      if (!(CAPABILITIES as readonly string[]).includes(name)) return null;
      return (offered[name] as CapabilityImpl[N] | undefined) ?? null;
    },

    readSettings(): ConfigValues | null {
      const settings = open()?.driver.settings() ?? null;
      return settings ? settingsToValues(settings) : null;
    },

    async writeSettings(patch: ConfigValues): Promise<ConfigValues | null> {
      const link = open();
      if (!link) throw new Error('The station is not connected');
      const current = link.driver.settings();
      if (!current) throw new Error('The station’s settings have not been read yet');
      /*
        Checked against the schema the app draws from, whoever calls: the
        bounds, the enum steps, and above all "Whole machine unused time", whose
        schema has no zero because zero destroys the station. The driver's
        register whitelist checks again below this.
      */
      const merged = validateConfig(SETTINGS_SCHEMA, { ...settingsToValues(current), ...patch });
      if (!merged.ok) throw new Error(merged.issues.map((issue) => issue.message).join('; '));
      const changed = Object.fromEntries(Object.keys(patch).map((key) => [key, merged.value[key]]));
      const applied = await link.driver.applySettings(valuesToSettings(changed) as StationSettingsPatch);
      return applied ? settingsToValues(applied) : null;
    },

    identity() {
      const status = open()?.driver.status();
      return {
        id: status?.link.mac ?? options.boundId ?? null,
        name: status?.name ?? null,
      };
    },

    station: () => open()?.driver ?? null,

    async close() {
      await options.close?.();
    },
  };
}
