/**
 * Mirrors `server/src/types.ts`.
 *
 * Hand-written rather than a cross-workspace import so Metro never resolves
 * outside `client/`.
 */

export type PortId = 'ac' | 'dc' | 'usb' | 'led';
export type LedMode = 'off' | 'on' | 'sos' | 'flash';
export type StationState = 'charging' | 'discharging' | 'idle' | 'standby';
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

export type DeviceList = {
  transport: TransportKind | null;
  boundId: string | null;
  connected: boolean;
  autoBind: boolean;
  devices: DiscoveredDevice[];
};

export type StationSettings = {
  chargeLimit: number;
  dischargeFloor: number;
  maxChargingCurrent: number;
  acSilentCharging: boolean;
  stopChargeAfterMinutes: number;
  ledMode: LedMode;
  keySound: boolean;
  usbStandbyMinutes: 0 | 3 | 5 | 10 | 30;
  acStandbyMinutes: 0 | 480 | 960 | 1440;
  dcStandbyMinutes: 0 | 480 | 960 | 1440;
  screenRestSeconds: 0 | 180 | 300 | 600 | 1800;
  /** Never 0 — that value permanently bricks the device. */
  sleepMinutes: 5 | 10 | 30 | 480;
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
  link: {
    mode: LinkMode;
    state: LinkState;
    transport?: TransportKind;
    mac: string | null;
    lastSeen: string | null;
  };

  level: number;
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
  transport?: TransportKind;
  /** True when the server is refusing every write to the station. */
  readOnly: boolean;
};

export type LinkDiagnostics = {
  driver: LinkMode;
  brokerListening: boolean;
  mqtt: { host: string; port: number };
  devices: { mac: string; lastSeen: string }[];
  configuredMac: string | null;
};

export type TrafficEntry = {
  at: string;
  mac: string;
  topic: string;
  bytes: number;
  hex: string;
};
