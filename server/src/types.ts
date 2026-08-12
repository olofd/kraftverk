import { z } from 'zod';

import type { StationSettings } from '@kraftverk/protocol';

/**
 * Request validation for the HTTP API.
 *
 * The *shapes* — `StationStatus`, `StationSettings`, `VersionInfo` — belong to
 * `@kraftverk/protocol` and are re-exported here, because the app shares them
 * whether it talks to this server or to a station directly over Bluetooth.
 * What lives here is the zod layer: the server validates untrusted JSON, which
 * the package deliberately does not do (it stays dependency-free so it bundles
 * into the app).
 *
 * The two are pinned together by `_SettingsMatch` below, so a value the schema
 * would accept can never drift from the type the rest of the code relies on.
 */

export type {
  FirmwareVersions,
  LedMode,
  LinkMode,
  LinkState,
  PortId,
  PortState,
  StationSettings,
  StationSettingsPatch,
  StationState,
  StationStatus,
  TransportKind,
  VersionInfo,
} from '@kraftverk/protocol';

export const PortIdSchema = z.enum(['ac', 'dc', 'usb', 'led']);

/** Matches the device's LED_MODE holding register. */
export const LedModeSchema = z.enum(['off', 'on', 'sos', 'flash']);

export const StationSettingsSchema = z.object({
  /** Stop charging at this SOC. Device accepts 60-100%. */
  chargeLimit: z.number().int().min(60).max(100),
  /** Cut output below this SOC. Device accepts 0-50%. */
  dischargeFloor: z.number().int().min(0).max(50),
  /**
   * AC charging power. The station stores this as a step 1-5; on a P280 those
   * are 600/900/1200/1500/1800 W. The mapping is model-specific — the same
   * register spans 300-1100 W on a FOSSiBOT F2400.
   */
  acChargingWatts: z.union([
    z.literal(600),
    z.literal(900),
    z.literal(1200),
    z.literal(1500),
    z.literal(1800),
  ]),
  /**
   * What is plugged into the DC input: a solar array (PV) or a DC adapter.
   *
   * Changing this also changes `maxChargingCurrent` on the device — switching
   * PV to DC dropped it from 20 A to 8 A unprompted. Re-read after writing.
   */
  dcInputType: z.enum(['pv', 'dc']),
  /** Solar/DC charging current ceiling, 1-20 A. */
  maxChargingCurrent: z.number().int().min(1).max(20),
  /** Quieter, slower AC charging. */
  acSilentCharging: z.boolean(),
  /**
   * Minutes until AC charging is enabled. A live countdown on the device, not
   * a clock time — it decrements once a minute and charging resumes at 0.
   * Range 0-1439.
   */
  stopChargeAfterMinutes: z.number().int().min(0).max(1439),
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

export const StationSettingsPatchSchema = StationSettingsSchema.partial();

export const PortPatchSchema = z.object({ enabled: z.boolean() });

/** Fails to compile if the schema and the shared settings type ever diverge. */
type AssertAssignable<Target, Source extends Target> = Source;
type _SchemaMatchesType = AssertAssignable<StationSettings, z.infer<typeof StationSettingsSchema>>;
type _TypeMatchesSchema = AssertAssignable<z.infer<typeof StationSettingsSchema>, StationSettings>;
