/**
 * The station's shape, shared by everything that talks to one.
 *
 * These are plain types with no validation library attached, so the app can
 * import them without pulling zod into its bundle. The server layers zod
 * schemas on top for request validation; the app uses them directly.
 *
 * Previously the app kept a hand-written copy of these, which is exactly the
 * kind of duplication that drifts silently.
 */

import type { AcChargingWatts, DcInputType, FirmwareVersions, LedMode } from './registers.ts';

export type { AcChargingWatts, DcInputType, FirmwareVersions, LedMode };

export type PortId = 'ac' | 'dc' | 'usb' | 'led';
export type StationState = 'charging' | 'discharging' | 'idle' | 'standby';

/** Where the telemetry came from. */
export type LinkMode = 'device' | 'simulator';
export type LinkState = 'connected' | 'waiting' | 'offline';
/** How the frames are carried. `direct-*` means the app itself is the client. */
export type TransportKind = 'mqtt' | 'ble' | 'direct-web-ble' | 'direct-native-ble';

export type StationSettings = {
  /** Caps mains charging only — solar charges straight past it. */
  chargeLimit: number;
  dischargeFloor: number;
  acChargingWatts: AcChargingWatts;
  /** Changing this also moves maxChargingCurrent on the device. */
  dcInputType: DcInputType;
  maxChargingCurrent: number;
  acSilentCharging: boolean;
  /** A live countdown in minutes, not a clock time. 0 means charging is on. */
  stopChargeAfterMinutes: number;
  ledMode: LedMode;
  keySound: boolean;
  usbStandbyMinutes: 0 | 3 | 5 | 10 | 30;
  acStandbyMinutes: 0 | 480 | 960 | 1440;
  dcStandbyMinutes: 0 | 480 | 960 | 1440;
  /** Seconds, unlike the standby timers above, which are minutes. */
  screenRestSeconds: 0 | 180 | 300 | 600 | 1800;
  /** Never 0 — that value permanently bricks the station. */
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

/**
 * How the link is *doing* — not the link itself, which is `StationLink` in
 * `client.ts`. The two were both called `StationLink`, which was survivable
 * only while there was no such thing as a link object.
 */
export type StationLinkState = {
  mode: LinkMode;
  state: LinkState;
  transport?: TransportKind;
  /** MAC over MQTT, peripheral id over BLE. */
  mac: string | null;
  lastSeen: string | null;
};

/**
 * What the station last said about itself.
 *
 * Before its first reading, the facts that anything *decides* on are `null`,
 * not a plausible default: an invented "0 %" was charted as a flat battery, an
 * invented "no mains" confirmed that mains had been cut, and an invented "just
 * now" made a silent station look fresh. The power figures stay numbers — 0
 * until a reading says otherwise — and are only meaningful when `lastUpdated`
 * is set.
 */
export type StationStatus = {
  name: string;
  model: string;
  firmware: FirmwareVersions | null;
  state: StationState;
  link: StationLinkState;

  /** Charge in percent; null before the first reading. */
  level: number | null;
  expansionSoc: number[];
  capacityWh: number;

  /** Whether mains is present at the AC input; null before the first reading. */
  gridConnected: boolean | null;
  solarConnected: boolean | null;

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
  /** When the station last sent a reading; null if it never has. */
  lastUpdated: string | null;
};

export type VersionInfo = {
  name: string;
  version: string;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
  link: LinkMode;
  transport?: TransportKind;
  readOnly: boolean;
};
