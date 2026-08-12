import {
  chargeRateToWatts,
  decodeFirmware,
  decodeSettings,
  decodeTelemetry,
  HOLDING,
  LED_MODE_VALUES,
  wattsToChargeRate,
  type DecodedSettings,
  type DecodedTelemetry,
} from './registers.ts';
import type {
  AcChargingWatts,
  PortId,
  PortState,
  StationSettings,
  StationSettingsPatch,
  StationState,
  StationStatus,
  TransportKind,
} from './types.ts';

/**
 * Turns raw register banks into the station model the UI renders, and settings
 * changes back into register writes.
 *
 * This lives in the shared package on purpose. The server and a direct
 * client-side Bluetooth connection both produce a `StationStatus` from the same
 * bytes; if the decoding lived in only one of them, the two paths would drift
 * and the app would show different numbers depending on how it happened to be
 * connected.
 */

/** AFERIY P280: 2048 Wh base pack, each expansion adds the same again. */
export const BASE_CAPACITY_WH = 2048;
export const DEFAULT_MODEL = 'AFERIY P280';

const PORT_LABELS: Record<PortId, string> = {
  ac: 'AC outlets',
  dc: '12V DC / car port',
  usb: 'USB-A + USB-C',
  led: 'Light',
};

export type StatusContext = {
  transport: TransportKind;
  connected: boolean;
  deviceId: string | null;
  lastSeen: Date | null;
  model?: string;
};

/** Builds the station model from decoded telemetry. */
export function buildStatus(
  telemetry: DecodedTelemetry | null,
  firmware: StationStatus['firmware'],
  context: StatusContext
): StationStatus {
  const t = telemetry;
  const packs = 1 + (t?.expansionSoc.length ?? 0);

  /*
    Derived from net power flow rather than the AC charging flag. Register 48 is
    AC-specific and reads 0 while a station charges happily from solar, so using
    it here reported "standby" with 114 W going in.
  */
  const net = (t?.totalInputWatts ?? 0) - (t?.totalOutputWatts ?? 0);
  const state: StationState = !t
    ? 'standby'
    : net > 5 || t.charging
      ? 'charging'
      : t.totalOutputWatts > 5
        ? 'discharging'
        : t.acInputConnected || t.dcInputConnected
          ? 'idle'
          : 'standby';

  const ports: PortState[] = [
    { id: 'ac', label: PORT_LABELS.ac, enabled: t?.acOutputEnabled ?? false, watts: t?.acOutputWatts ?? 0 },
    { id: 'dc', label: PORT_LABELS.dc, enabled: t?.dcOutputEnabled ?? false, watts: t?.dcOutputWatts ?? 0 },
    { id: 'usb', label: PORT_LABELS.usb, enabled: t?.usbOutputEnabled ?? false, watts: t?.usbOutputWatts ?? 0 },
    { id: 'led', label: PORT_LABELS.led, enabled: t?.ledEnabled ?? false, watts: t?.ledWatts ?? 0 },
  ];

  return {
    name: 'Aferiy Powerstation',
    model: context.model ?? DEFAULT_MODEL,
    firmware,
    state,
    link: {
      mode: 'device',
      state: !context.deviceId ? 'waiting' : t && context.connected ? 'connected' : 'offline',
      transport: context.transport,
      mac: context.deviceId,
      lastSeen: context.lastSeen?.toISOString() ?? null,
    },
    level: t?.socPercent ?? 0,
    expansionSoc: t?.expansionSoc ?? [],
    capacityWh: BASE_CAPACITY_WH * packs,
    gridConnected: t?.acInputConnected ?? false,
    solarConnected: t?.dcInputConnected ?? false,
    acInputWatts: Math.max(0, (t?.totalInputWatts ?? 0) - (t?.dcInputWatts ?? 0)),
    solarInputWatts: t?.dcInputWatts ?? 0,
    totalInputWatts: t?.totalInputWatts ?? 0,
    totalOutputWatts: t?.totalOutputWatts ?? 0,
    acInputVolts: t?.acInputVolts ?? 0,
    acInputHz: t?.acInputHz ?? 0,
    acOutputVolts: t?.acOutputVolts ?? 0,
    acOutputHz: t?.acOutputHz ?? 0,
    minutesToFull: t?.minutesToFull ?? null,
    minutesRemaining: t?.minutesToEmpty ?? null,
    chargeBookingMinutes: t?.chargingBookingMinutes ?? 0,
    ports,
    lastUpdated: (context.lastSeen ?? new Date()).toISOString(),
  };
}

const oneOf = <T extends number>(value: number, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly number[]).includes(value) ? (value as T) : fallback;

/** Builds the settings model from decoded holding registers. */
export function buildSettings(
  decoded: DecodedSettings | null,
  temperatureUnit: StationSettings['temperatureUnit'] = 'C'
): StationSettings {
  const s = decoded;
  return {
    chargeLimit: Math.round(s?.chargingUpperLimitPercent ?? 100),
    dischargeFloor: Math.round(s?.dischargeLowerLimitPercent ?? 0),
    acChargingWatts: (s?.acChargingWatts ?? 1800) as AcChargingWatts,
    dcInputType: s?.dcInputType ?? 'pv',
    maxChargingCurrent: s?.maxChargingCurrent || 20,
    acSilentCharging: s?.acSilentCharging ?? false,
    stopChargeAfterMinutes: s?.stopChargeAfterMinutes ?? 0,
    ledMode: LED_MODE_VALUES[s?.ledMode ?? 0] ?? 'off',
    keySound: s?.keySound ?? true,
    usbStandbyMinutes: oneOf(s?.usbStandbyMinutes ?? 0, [0, 3, 5, 10, 30] as const, 0),
    acStandbyMinutes: oneOf(s?.acStandbyMinutes ?? 0, [0, 480, 960, 1440] as const, 0),
    dcStandbyMinutes: oneOf(s?.dcStandbyMinutes ?? 0, [0, 480, 960, 1440] as const, 0),
    screenRestSeconds: oneOf(s?.screenRestSeconds ?? 300, [0, 180, 300, 600, 1800] as const, 300),
    sleepMinutes: oneOf(s?.sleepMinutes ?? 480, [5, 10, 30, 480] as const, 480),
    temperatureUnit,
  };
}

/**
 * Register writes for a settings change, in the order they should be sent.
 *
 * `temperatureUnit` is deliberately absent: it is a display preference with no
 * register behind it, so callers keep it themselves.
 */
export function settingsWrites(patch: StationSettingsPatch): [register: number, value: number][] {
  const writes: [number, number][] = [];

  if (patch.chargeLimit !== undefined)
    writes.push([HOLDING.AC_CHARGING_UPPER_LIMIT, Math.round(patch.chargeLimit * 10)]);
  if (patch.dischargeFloor !== undefined)
    writes.push([HOLDING.DISCHARGE_LOWER_LIMIT, Math.round(patch.dischargeFloor * 10)]);
  if (patch.acChargingWatts !== undefined)
    writes.push([HOLDING.AC_CHARGING_RATE, wattsToChargeRate(patch.acChargingWatts)]);
  // The station adjusts MAX_CHARGING_CURRENT itself in response to this, so
  // callers must re-read rather than assume the rest of the settings held.
  if (patch.dcInputType !== undefined)
    writes.push([HOLDING.DC_INPUT_TYPE, patch.dcInputType === 'dc' ? 1 : 0]);
  if (patch.maxChargingCurrent !== undefined)
    writes.push([HOLDING.MAX_CHARGING_CURRENT, patch.maxChargingCurrent]);
  if (patch.acSilentCharging !== undefined)
    writes.push([HOLDING.AC_SILENT_CHARGING, patch.acSilentCharging ? 1 : 0]);
  if (patch.stopChargeAfterMinutes !== undefined)
    writes.push([HOLDING.STOP_CHARGE_AFTER_MINUTES, patch.stopChargeAfterMinutes]);
  if (patch.ledMode !== undefined)
    writes.push([HOLDING.LED_MODE, LED_MODE_VALUES.indexOf(patch.ledMode)]);
  if (patch.keySound !== undefined) writes.push([HOLDING.KEY_SOUND, patch.keySound ? 1 : 0]);
  if (patch.usbStandbyMinutes !== undefined)
    writes.push([HOLDING.USB_STANDBY_MINUTES, patch.usbStandbyMinutes]);
  if (patch.acStandbyMinutes !== undefined)
    writes.push([HOLDING.AC_STANDBY_MINUTES, patch.acStandbyMinutes]);
  if (patch.dcStandbyMinutes !== undefined)
    writes.push([HOLDING.DC_STANDBY_MINUTES, patch.dcStandbyMinutes]);
  if (patch.screenRestSeconds !== undefined)
    writes.push([HOLDING.SCREEN_REST_SECONDS, patch.screenRestSeconds]);
  if (patch.sleepMinutes !== undefined) writes.push([HOLDING.SLEEP_MINUTES, patch.sleepMinutes]);

  return writes;
}

/** The holding register behind an output port. */
export function portRegister(id: PortId): number {
  return id === 'ac'
    ? HOLDING.AC_OUTPUT
    : id === 'dc'
      ? HOLDING.DC_OUTPUT
      : id === 'usb'
        ? HOLDING.USB_OUTPUT
        : HOLDING.LED_MODE;
}

export { decodeTelemetry, decodeSettings, decodeFirmware, chargeRateToWatts };
