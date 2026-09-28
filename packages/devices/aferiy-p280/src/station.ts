import {
  validateConfig,
  type AdvancedAction,
  type CapabilityImpl,
  type CapabilityName,
  type CommandResult,
  type ConfigValues,
  type ConnectionHealth,
  type DeviceContext,
  type DeviceSession,
  type Reading,
} from '@kraftverk/device-sdk';
import { commandRefusal, describeCommand, fromHex, parseCommand, toHex, type SydpowerLink } from '@kraftverk/protocol-sydpower';

import { CAPABILITIES, readings, SETTINGS_SCHEMA, settingsToValues, valuesToSettings } from './index.ts';
import type { StationClient } from './model/client.ts';
import { describeRegisters, type RegisterDump } from './model/diagnostics.ts';
import type { PortId, StationSettings, StationSettingsPatch, StationStatus } from './model/types.ts';

/**
 * A P280, as a device session: what its station client reports, in the shared
 * vocabulary of readings, capabilities and settings.
 *
 * The same adapter serves a real station and the simulator, and the same code
 * runs wherever the connection is held. What differs is only the driver: a
 * `StationClient` over the link the protocol builds on the connection it was
 * handed, or the simulator.
 */

/** What this session needs from a driver: `StationClient` and the simulator both fit. */
export interface StationDriverLike {
  status(): StationStatus;
  /** Null until the station's settings have been read from it. */
  settings(): StationSettings | null;
  applySettings(patch: StationSettingsPatch): Promise<StationSettings | null>;
  setPort(id: PortId, enabled: boolean): Promise<StationStatus>;
}

/** The outlets a P280 has. The light is a setting, not an outlet: see `CONTROLS`. */
const OUTLETS: readonly PortId[] = ['ac', 'dc', 'usb'];

const failed = (error: unknown): CommandResult => ({
  accepted: false,
  error: error instanceof Error ? error.message : String(error),
});

export type StationSessionOptions = {
  /** The station's permanent identity, when it is known. */
  identity: string | null;
  /** How it is reached: `mqtt`, `ble`, `sim`. */
  transport: string;
  /** Whether the connection underneath is up; the simulator's always is. */
  connected: () => boolean;
  advanced?: Record<string, AdvancedAction>;
  close?: () => void | Promise<void>;
};

export function stationSession(driver: StationDriverLike, options: StationSessionOptions): DeviceSession {
  /** The latest status, but only once the station has actually reported. */
  const reported = (): StationStatus | null => {
    const status = driver.status();
    return status.lastUpdated !== null ? status : null;
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
      if (!OUTLETS.includes(outletId as PortId)) return { accepted: false, error: `A P280 has no outlet "${outletId}"` };
      try {
        await driver.setPort(outletId as PortId, on);
        return { accepted: true };
      } catch (error) {
        return failed(error);
      }
    },
  };

  const offered: Partial<CapabilityImpl> = { battery, acInput, outlets };

  return {
    health(): ConnectionHealth {
      const status = driver.status();
      const simulated = status.link.mode === 'simulator';
      const connected = simulated || (options.connected() && status.link.state === 'connected');
      return {
        status: connected ? 'connected' : options.connected() ? 'connecting' : 'offline',
        detail: connected
          ? simulated
            ? 'Simulated'
            : 'Connected'
          : options.connected()
            ? 'Reached, waiting for the station’s first reading'
            : 'The station has not connected',
        owner: 'server',
        transport: options.transport,
        lastReadingAt: connected ? status.lastUpdated : status.link.lastSeen,
      };
    },

    readings(): Reading[] {
      return readings(driver.status());
    },

    capability<N extends CapabilityName>(name: N): CapabilityImpl[N] | null {
      if (!(CAPABILITIES as readonly string[]).includes(name)) return null;
      return (offered[name] as CapabilityImpl[N] | undefined) ?? null;
    },

    readSettings(): ConfigValues | null {
      const settings = driver.settings();
      return settings ? settingsToValues(settings) : null;
    },

    async writeSettings(patch: ConfigValues): Promise<ConfigValues | null> {
      const current = driver.settings();
      if (!current) throw new Error('The station’s settings have not been read yet');
      /*
        Checked against the schema the app draws from, whoever calls: the
        bounds, the enum steps, and above all "Whole machine unused time", whose
        schema has no zero because zero destroys the station. The client's
        register whitelist checks again below this, and the protocol's guard
        below that.
      */
      const merged = validateConfig(SETTINGS_SCHEMA, { ...settingsToValues(current), ...patch });
      if (!merged.ok) throw new Error(merged.issues.map((issue) => issue.message).join('; '));
      const changed = Object.fromEntries(Object.keys(patch).map((key) => [key, merged.value[key]]));
      const applied = await driver.applySettings(valuesToSettings(changed) as StationSettingsPatch);
      return applied ? settingsToValues(applied) : null;
    },

    identity() {
      return { id: options.identity, name: driver.status().name ?? null };
    },

    advanced: options.advanced,

    async close() {
      await options.close?.();
    },
  };
}

// --- the station's own view --------------------------------------------------------

/**
 * Everything the station's own screens draw: ports, firmware, link, settings,
 * in the station's own units. The shared readings are a projection of this;
 * the energy-flow view needs the whole of it. Offered by a real station and
 * the simulator alike, and served by whoever holds the connection.
 */
export function stationTools(driver: StationDriverLike): Record<string, AdvancedAction> {
  return {
    state: { writes: false, run: async () => ({ status: driver.status(), settings: driver.settings() }) },
  };
}

// --- the register tools ----------------------------------------------------------

/**
 * A baseline for the register diff.
 *
 * Snapshot, change one thing on the station (or in BrightEMS), then read again:
 * whatever moved is the register behind that control. This is how the map gets
 * confirmed on hardware it was not derived from. Kept in the device's own store,
 * so each station has its own and it survives a restart mid-experiment.
 */
type Baseline = { at: string; input: number[]; holding: number[] };
const BASELINE_KEY = 'registers.baseline';

const integer = (value: unknown, fallback: number, min: number, max: number, name: string): number => {
  const numeric = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return numeric;
};

/**
 * Tools for confirming the register map against real hardware. The published
 * map came from FOSSiBOT F2400/F3600 units; the P280 is the same stack but a
 * different machine, so a value is verified before it is trusted.
 */
export function registerTools(
  client: StationClient,
  link: SydpowerLink,
  ctx: Pick<DeviceContext, 'store' | 'readOnly' | 'allowRawFrames'>
): Record<string, AdvancedAction> {
  return {
    /** Every register, raw and decoded, diffed against this station's own baseline. */
    registers: {
      writes: false,
      async run(): Promise<RegisterDump> {
        const [input, holding] = await Promise.all([
          client.readAllInput().catch(() => [] as number[]),
          client.readAllHolding().catch(() => [] as number[]),
        ]);
        const baseline = ctx.store.get<Baseline>(BASELINE_KEY);
        return {
          mac: client.mac,
          readOnly: client.readOnly,
          baselineAt: baseline?.at ?? null,
          input: describeRegisters(input, 'input', baseline?.input),
          holding: describeRegisters(holding, 'holding', baseline?.holding),
        };
      },
    },

    /** Takes the baseline the next dump is compared with. Changes nothing on the station. */
    snapshot: {
      writes: false,
      async run() {
        const [input, holding] = await Promise.all([client.readAllInput(), client.readAllHolding()]);
        const baseline: Baseline = { at: new Date().toISOString(), input, holding };
        ctx.store.set(BASELINE_KEY, baseline);
        return { at: baseline.at, input: input.length, holding: holding.length };
      },
    },

    /**
     * Reads an arbitrary register range, and shows it as ASCII too.
     *
     * Strings the station stores — a Wi-Fi SSID, say — would be packed two
     * characters per register and are invisible in a numeric dump. Reads only,
     * so probing outside the documented window cannot change anything.
     */
    scan: {
      writes: false,
      async run(input) {
        const fn = integer(input.fn, 3, 3, 4, 'fn') as 3 | 4;
        const start = integer(input.start, 0, 0, 65535, 'start');
        const count = integer(input.count, 40, 1, 125, 'count');
        const values = await client.readRange(fn, start, count).catch(() => [] as number[]);
        const ch = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
        return {
          fn,
          start,
          count,
          ok: values.length > 0,
          values: values.map((raw, i) => ({ register: start + i, raw, hex: raw.toString(16).padStart(4, '0') })),
          ascii: values.map((v) => ch((v >> 8) & 0xff) + ch(v & 0xff)).join(''),
        };
      },
    },

    /** Writes this station refused while read-only. Its own, not somebody else's. */
    blocked: { writes: false, run: async () => client.blockedWrites },

    /** How the link is doing: what it rides, and what the transport reports about it. */
    link: {
      writes: false,
      run: async () => ({ transport: link.transport, address: link.address, connected: link.connected, status: client.status().link }),
    },

    /**
     * Sends an arbitrary frame: the escape hatch for protocol work.
     *
     * Only when the holder was started with raw access, because writing an
     * undocumented register can damage the station. Raw frames skip the
     * whitelist by design — reaching undocumented registers is what they are
     * for — but never the protocol's guard, and never read-only mode: only a
     * frame that is plainly a read can change nothing.
     */
    raw: {
      writes: true,
      honoursReadOnly: true,
      async run(input) {
        if (!ctx.allowRawFrames) {
          throw new Error('Raw frames are off. Start the server with ALLOW_RAW_MODBUS=1 to send them; bad writes can brick the station.');
        }
        const hex = typeof input.hex === 'string' ? input.hex : '';
        if (!/^[0-9a-fA-F]{2,512}$/.test(hex) || hex.length % 2) throw new Error('hex must be whole bytes of hexadecimal');
        const frame = fromHex(hex);
        const refusal = commandRefusal(frame);
        if (refusal) throw new Error(refusal);
        if (ctx.readOnly && parseCommand(frame)?.kind !== 'read') {
          throw new Error(`Refused to send ${describeCommand(frame)}: this holder is read-only, and only reads are sent.`);
        }
        await link.send(frame);
        return { sent: toHex(frame), to: link.address, described: describeCommand(frame) };
      },
    },
  };
}
