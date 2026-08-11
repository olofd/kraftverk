import { z } from 'zod';

/**
 * Everything the API speaks is described here once, as zod schemas, and the
 * TypeScript types are inferred from them. That keeps validation and types
 * from drifting apart.
 */

export const PortIdSchema = z.enum(['ac', 'dc', 'usb']);
export type PortId = z.infer<typeof PortIdSchema>;

export const ChargeSpeedSchema = z.enum(['silent', 'standard', 'turbo']);
export type ChargeSpeed = z.infer<typeof ChargeSpeedSchema>;

export const StationSettingsSchema = z.object({
  /** Stop charging at this state of charge. Lower = longer battery life. */
  chargeLimit: z.number().int().min(50).max(100),
  /** Cut output at this state of charge to protect the cells. */
  dischargeFloor: z.number().int().min(0).max(50),
  /** Caps AC input draw so the station plays nicely with weak circuits. */
  maxInputWatts: z.number().int().min(200).max(1500),
  chargeSpeed: ChargeSpeedSchema,
  /** Auto-shut-off when output stays below a trickle. */
  ecoMode: z.boolean(),
  /** Pass-through power so connected gear rides out a grid failure. */
  upsMode: z.boolean(),
  /** Fan/inverter noise ceiling in silent hours. */
  quietHours: z.boolean(),
  displayBrightness: z.number().int().min(10).max(100),
  /** Minutes before the built-in screen sleeps. 0 = never. */
  screenTimeoutMinutes: z.number().int().min(0).max(60),
  temperatureUnit: z.enum(['C', 'F']),
});
export type StationSettings = z.infer<typeof StationSettingsSchema>;

/** PATCH accepts any subset of the settings. */
export const StationSettingsPatchSchema = StationSettingsSchema.partial();
export type StationSettingsPatch = z.infer<typeof StationSettingsPatchSchema>;

export const PortStateSchema = z.object({
  id: PortIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  watts: z.number(),
});
export type PortState = z.infer<typeof PortStateSchema>;

export const PortPatchSchema = z.object({ enabled: z.boolean() });

export type StationState = 'charging' | 'discharging' | 'idle' | 'standby';

export type StationStatus = {
  name: string;
  model: string;
  state: StationState;
  /** Whether the station currently sees AC input from the wall. */
  gridConnected: boolean;
  /** State of charge, 0-100. */
  level: number;
  capacityWh: number;
  inputWatts: number;
  outputWatts: number;
  batteryTempC: number;
  /** Null when not charging / not discharging respectively. */
  minutesToFull: number | null;
  minutesRemaining: number | null;
  cycleCount: number;
  healthPercent: number;
  ports: PortState[];
  lastUpdated: string;
};

export type VersionInfo = {
  name: string;
  version: string;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
};
