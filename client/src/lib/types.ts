/**
 * Mirrors `server/src/types.ts`.
 *
 * Kept as a hand-written copy rather than a cross-workspace import so Metro
 * never has to resolve outside `client/`. If the API surface grows, the next
 * step is Hono's RPC client (`hc<AppType>`), which gives the client these types
 * straight from the server's route definitions.
 */

export type PortId = 'ac' | 'dc' | 'usb';
export type ChargeSpeed = 'silent' | 'standard' | 'turbo';
export type StationState = 'charging' | 'discharging' | 'idle' | 'standby';

export type StationSettings = {
  chargeLimit: number;
  dischargeFloor: number;
  maxInputWatts: number;
  chargeSpeed: ChargeSpeed;
  ecoMode: boolean;
  upsMode: boolean;
  quietHours: boolean;
  displayBrightness: number;
  screenTimeoutMinutes: number;
  temperatureUnit: 'C' | 'F';
};

export type StationSettingsPatch = Partial<StationSettings>;

export type PortState = {
  id: PortId;
  label: string;
  enabled: boolean;
  watts: number;
};

export type StationStatus = {
  name: string;
  model: string;
  state: StationState;
  gridConnected: boolean;
  level: number;
  capacityWh: number;
  inputWatts: number;
  outputWatts: number;
  batteryTempC: number;
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
