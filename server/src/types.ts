import { z } from 'zod';

/**
 * The API surface, described once as zod schemas with TypeScript types
 * inferred from them, so validation and types cannot drift apart.
 *
 * Modelled on the AFERIY P280 (2048Wh, 2800W, expandable to 10.24kWh) and the
 * SYDPOWER register map its firmware exposes.
 */

export const PortIdSchema = z.enum(['ac', 'dc', 'usb', 'led']);
export type PortId = z.infer<typeof PortIdSchema>;

/** Matches the device's LED_MODE holding register. */
export const LedModeSchema = z.enum(['off', 'on', 'sos', 'flash']);
export type LedMode = z.infer<typeof LedModeSchema>;
export const LED_MODES: LedMode[] = ['off', 'on', 'sos', 'flash'];

export const StationSettingsSchema = z.object({
  /** Stop charging at this SOC. Device accepts 60-100%. */
  chargeLimit: z.number().int().min(60).max(100),
  /** Cut output below this SOC. Device accepts 0-50%. */
  dischargeFloor: z.number().int().min(0).max(50),
  /** Solar/DC charging current ceiling, 1-20 A. */
  maxChargingCurrent: z.number().int().min(1).max(20),
  /** Quieter, slower AC charging. */
  acSilentCharging: z.boolean(),
  /** Delay charging by N minutes (0 = charge now). Device accepts 0-1440. */
  stopChargeAfterMinutes: z.number().int().min(0).max(1440),
  ledMode: LedModeSchema,
  keySound: z.boolean(),
  /** Auto-off timers, in minutes. 0 disables. */
  usbStandbyMinutes: z.union([z.literal(0), z.literal(3), z.literal(5), z.literal(10), z.literal(30)]),
  acStandbyMinutes: z.union([z.literal(0), z.literal(480), z.literal(960), z.literal(1440)]),
  dcStandbyMinutes: z.union([z.literal(0), z.literal(480), z.literal(960), z.literal(1440)]),
  /** Screen blank delay, in seconds. */
  screenRestSeconds: z.union([
    z.literal(0),
    z.literal(180),
    z.literal(300),
    z.literal(600),
    z.literal(1800),
  ]),
  /**
   * Whole-machine idle shutdown, in minutes.
   *
   * DANGER: the device is permanently bricked by a value of 0. The schema and
   * the register whitelist both exclude it.
   */
  sleepMinutes: z.union([z.literal(5), z.literal(10), z.literal(30), z.literal(480)]),
  temperatureUnit: z.enum(['C', 'F']),
});
export type StationSettings = z.infer<typeof StationSettingsSchema>;

export const StationSettingsPatchSchema = StationSettingsSchema.partial();
export type StationSettingsPatch = z.infer<typeof StationSettingsPatchSchema>;

export const PortPatchSchema = z.object({ enabled: z.boolean() });

export type PortState = {
  id: PortId;
  label: string;
  enabled: boolean;
  watts: number;
};

export type StationState = 'charging' | 'discharging' | 'idle' | 'standby';

/** How the server is currently talking to the station. */
export type LinkMode = 'device' | 'simulator';
export type LinkState = 'connected' | 'waiting' | 'offline';
export type TransportKind = 'mqtt' | 'ble';

export type DiscoveredDevice = {
  id: string;
  kind: TransportKind;
  name: string;
  mac: string | null;
  rssi?: number;
  firstSeen: string;
  lastSeen: string;
  bound: boolean;
};

export type StationStatus = {
  name: string;
  model: string;
  state: StationState;
  link: {
    mode: LinkMode;
    state: LinkState;
    transport?: TransportKind;
    mac: string | null;
    lastSeen: string | null;
  };

  /** Main pack state of charge, 0-100. */
  level: number;
  /** SOC of each attached expansion battery. */
  expansionSoc: number[];
  capacityWh: number;

  gridConnected: boolean;
  solarConnected: boolean;

  acInputWatts: number;
  solarInputWatts: number;
  totalInputWatts: number;
  totalOutputWatts: number;

  acInputVolts: number;
  acInputHz: number;
  acOutputVolts: number;
  acOutputHz: number;

  minutesToFull: number | null;
  minutesRemaining: number | null;
  /** Minutes until a scheduled charge begins; 0 when charging is not deferred. */
  chargeBookingMinutes: number;

  ports: PortState[];
  lastUpdated: string;
};

export type VersionInfo = {
  name: string;
  version: string;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
  link: LinkMode;
};
