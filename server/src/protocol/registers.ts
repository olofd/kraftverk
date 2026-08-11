/**
 * Register map for SYDPOWER-stack power stations.
 *
 * Sourced from https://github.com/schauveau/sydpower-mqtt/blob/main/MQTT-MODBUS.md
 * and cross-checked against iamslan/ha-fossibot.
 *
 * CAUTION: the published map was derived largely from FOSSiBOT F2400/F3600
 * hardware. The AFERIY P280 is the same Sydpower stack but a larger unit
 * (2048Wh, 2800W, 1800W AC input), so scaling on a few registers may differ —
 * notably the AC charging rate, documented as 300-1100W on an F2400.
 * Use the /api/diagnostics/registers endpoint to confirm against real hardware
 * before trusting any value marked `unverified`.
 */

/** Input registers (function 0x04) — read-only telemetry. */
export const INPUT = {
  AC_CHARGING_RATE: 2,
  CHARGING_POWER: 3,
  DC_INPUT_POWER: 4,
  TOTAL_INPUT_POWER: 6,
  DC_OUTPUT_POWER: 9,
  LED_POWER: 15,
  AC_OUTPUT_VOLTAGE: 18,
  AC_OUTPUT_FREQUENCY: 19,
  AC_OUTPUT_POWER: 20,
  AC_INPUT_VOLTAGE: 21,
  AC_INPUT_FREQUENCY: 22,
  LED_STATE: 25,
  USB_OUTPUT_1: 30,
  USB_OUTPUT_2: 31,
  USB_OUTPUT_3: 34,
  USB_OUTPUT_4: 35,
  USB_OUTPUT_5: 36,
  USB_OUTPUT_6: 37,
  TOTAL_OUTPUT_POWER: 39,
  STATUS_BITS: 41,
  DEVICE_STATE: 42,
  AC_CHARGING_STATE: 48,
  SOC_EXPANSION_1: 53,
  SOC_EXPANSION_2: 55,
  STATE_OF_CHARGE: 56,
  AC_CHARGING_BOOKING: 57,
  TIME_TO_FULL: 58,
  TIME_TO_EMPTY: 59,
} as const;

/** Total input registers the device returns in one 0x04 read. */
export const INPUT_REGISTER_COUNT = 80;

/** Holding registers (function 0x03 read / 0x06 write) — settings. */
export const HOLDING = {
  AC_CHARGING_RATE: 13,
  MAX_CHARGING_CURRENT: 20,
  USB_OUTPUT: 24,
  DC_OUTPUT: 25,
  AC_OUTPUT: 26,
  LED_MODE: 27,
  KEY_SOUND: 56,
  AC_SILENT_CHARGING: 57,
  USB_STANDBY_MINUTES: 59,
  AC_STANDBY_MINUTES: 60,
  DC_STANDBY_MINUTES: 61,
  SCREEN_REST_SECONDS: 62,
  STOP_CHARGE_AFTER_MINUTES: 63,
  DISCHARGE_LOWER_LIMIT: 66,
  AC_CHARGING_UPPER_LIMIT: 67,
  SLEEP_MINUTES: 68,
} as const;

export const HOLDING_REGISTER_COUNT = 80;

/**
 * Observed on a real AFERIY P280 but not yet confirmed against the display or
 * BrightEMS. Recorded here so the next session starts from evidence.
 *
 *   holding 14 = 1800  matches the P280's 1800 W AC input ceiling exactly, so
 *                      this is very likely AC charging power in watts. The
 *                      published map describes charging rate as a 1-5 config
 *                      value (registers 2 and 13, which read 3 here), so the
 *                      P280 appears to expose the wattage separately.
 *   input   54 = 376   plausible as battery temperature (37.6 C). No documented
 *                      temperature register exists; needs corroboration.
 *   input   70,71 = 1000 (i.e. 100.0) each. Possibly pack health or per-string
 *                      state of charge.
 *   input   47 = 0x3000, input 62 = 0x00ff, holding 11 = 0x1500  unknown flags.
 *
 * To identify any of these: snapshot the baseline, change one thing on the
 * station, and dump again (POST /api/diagnostics/snapshot).
 */
export const UNCONFIRMED_P280 = {
  AC_CHARGING_WATTS: 14,
  MAYBE_BATTERY_TEMP: 54,
} as const;

/** Bit masks in input register 41. */
export const STATUS = {
  LED_ON: 0x1000,
  AC_OUTPUT_ON: 0x0800,
  DC_OUTPUT_ON: 0x0400,
  USB_OUTPUT_ON: 0x0200,
  DC_CONVERTER_ACTIVE: 0x0080,
  DC_INPUT_CONNECTED: 0x0060,
  CHARGING_FROM_AC: 0x0010,
  /**
   * The published map gives 0x000E here, but bit 2 (0x0004) is set on a device
   * that is demonstrably unplugged: in a captured frame with status 0x0804 the
   * AC input reads 1.3 V at 0 Hz, register 48 is 0x4000 (not charging), and the
   * unit is discharging with 641 minutes remaining. Bit 2 tracks something else
   * — most likely the inverter, since AC output is on in that same frame.
   *
   * The source notes bits 3 and 1 are the redundant pair, so we mask those.
   * `decodeTelemetry` also corroborates against AC input voltage.
   */
  AC_INPUT_CONNECTED: 0x000a,
} as const;

/**
 * Bit 15 of input register 48 is the charging flag.
 *
 * The published map describes this register as reading exactly 0x8000 when
 * charging and 0x4000 otherwise. A real P280 reports 0x8040 — the low bits
 * carry something else — so this must be masked, not compared for equality.
 */
export const AC_CHARGING_ACTIVE = 0x8000;

/**
 * Values this server will write, per register.
 *
 * Anything not listed here is refused. This is a safety mechanism, not a
 * convenience: writing 0 to SLEEP_MINUTES (68) permanently bricks the device,
 * and writing to undocumented registers has been reported to damage hardware.
 */
export type WriteRule =
  | { kind: 'set'; values: readonly number[] }
  | { kind: 'range'; min: number; max: number };

export const WRITABLE: Partial<Record<number, WriteRule>> = {
  [HOLDING.MAX_CHARGING_CURRENT]: { kind: 'range', min: 1, max: 20 },
  [HOLDING.USB_OUTPUT]: { kind: 'set', values: [0, 1] },
  [HOLDING.DC_OUTPUT]: { kind: 'set', values: [0, 1] },
  [HOLDING.AC_OUTPUT]: { kind: 'set', values: [0, 1] },
  [HOLDING.LED_MODE]: { kind: 'set', values: [0, 1, 2, 3] },
  [HOLDING.KEY_SOUND]: { kind: 'set', values: [0, 1] },
  [HOLDING.AC_SILENT_CHARGING]: { kind: 'set', values: [0, 1] },
  [HOLDING.USB_STANDBY_MINUTES]: { kind: 'set', values: [0, 3, 5, 10, 30] },
  [HOLDING.AC_STANDBY_MINUTES]: { kind: 'set', values: [0, 480, 960, 1440] },
  [HOLDING.DC_STANDBY_MINUTES]: { kind: 'set', values: [0, 480, 960, 1440] },
  [HOLDING.SCREEN_REST_SECONDS]: { kind: 'set', values: [0, 180, 300, 600, 1800] },
  [HOLDING.STOP_CHARGE_AFTER_MINUTES]: { kind: 'range', min: 0, max: 1440 },
  // Official app range is 0-500 (0-50%); the device accepts up to 1000.
  [HOLDING.DISCHARGE_LOWER_LIMIT]: { kind: 'range', min: 0, max: 500 },
  // Official app range is 600-1000 (60-100%).
  [HOLDING.AC_CHARGING_UPPER_LIMIT]: { kind: 'range', min: 600, max: 1000 },
  // NEVER include 0 here. Zero bricks the device.
  [HOLDING.SLEEP_MINUTES]: { kind: 'set', values: [5, 10, 30, 480] },
};

export class UnsafeWriteError extends Error {}

/** Throws unless (register, value) is explicitly allowed. */
export function assertWritable(register: number, value: number): void {
  const rule = WRITABLE[register];
  if (!rule) {
    throw new UnsafeWriteError(
      `Register ${register} is not writable. Writing undocumented registers can permanently damage the device.`
    );
  }
  if (!Number.isInteger(value)) {
    throw new UnsafeWriteError(`Register ${register}: value must be an integer, got ${value}`);
  }
  if (rule.kind === 'set') {
    if (!rule.values.includes(value)) {
      throw new UnsafeWriteError(
        `Register ${register}: ${value} not allowed. Permitted: ${rule.values.join(', ')}`
      );
    }
    return;
  }
  if (value < rule.min || value > rule.max) {
    throw new UnsafeWriteError(
      `Register ${register}: ${value} out of range ${rule.min}-${rule.max}`
    );
  }
}

// --- decoding -------------------------------------------------------------

const at = (regs: readonly number[], index: number) => regs[index] ?? 0;

/** Tenths of a unit (power, voltage, percent) to a whole unit. */
const tenths = (raw: number) => Math.round(raw) / 10;

export type DecodedTelemetry = {
  socPercent: number;
  expansionSoc: number[];
  acInputVolts: number;
  acInputHz: number;
  acOutputVolts: number;
  acOutputHz: number;
  acOutputWatts: number;
  dcInputWatts: number;
  dcOutputWatts: number;
  usbOutputWatts: number;
  ledWatts: number;
  totalInputWatts: number;
  totalOutputWatts: number;
  charging: boolean;
  acInputConnected: boolean;
  dcInputConnected: boolean;
  acOutputEnabled: boolean;
  dcOutputEnabled: boolean;
  usbOutputEnabled: boolean;
  ledEnabled: boolean;
  ledMode: number;
  minutesToFull: number | null;
  minutesToEmpty: number | null;
  chargingBookingMinutes: number;
};

/** Mains is ~110-240 V; anything below this is sensor noise on an idle input. */
const AC_INPUT_PRESENT_VOLTS = 50;

export function decodeTelemetry(regs: readonly number[]): DecodedTelemetry {
  const status = at(regs, INPUT.STATUS_BITS);
  const acInputVolts = tenths(at(regs, INPUT.AC_INPUT_VOLTAGE));

  const usbWatts =
    tenths(at(regs, INPUT.USB_OUTPUT_1)) +
    tenths(at(regs, INPUT.USB_OUTPUT_2)) +
    tenths(at(regs, INPUT.USB_OUTPUT_3)) +
    tenths(at(regs, INPUT.USB_OUTPUT_4)) +
    tenths(at(regs, INPUT.USB_OUTPUT_5)) +
    tenths(at(regs, INPUT.USB_OUTPUT_6));

  const expansion = [at(regs, INPUT.SOC_EXPANSION_1), at(regs, INPUT.SOC_EXPANSION_2)]
    .filter((raw) => raw > 0)
    .map(tenths);

  const toFull = at(regs, INPUT.TIME_TO_FULL);
  const toEmpty = at(regs, INPUT.TIME_TO_EMPTY);

  return {
    socPercent: tenths(at(regs, INPUT.STATE_OF_CHARGE)),
    expansionSoc: expansion,
    acInputVolts,
    acInputHz: Math.round(at(regs, INPUT.AC_INPUT_FREQUENCY)) / 100,
    acOutputVolts: tenths(at(regs, INPUT.AC_OUTPUT_VOLTAGE)),
    acOutputHz: tenths(at(regs, INPUT.AC_OUTPUT_FREQUENCY)),
    acOutputWatts: at(regs, INPUT.AC_OUTPUT_POWER),
    dcInputWatts: at(regs, INPUT.DC_INPUT_POWER),
    dcOutputWatts: tenths(at(regs, INPUT.DC_OUTPUT_POWER)),
    usbOutputWatts: Math.round(usbWatts * 10) / 10,
    ledWatts: tenths(at(regs, INPUT.LED_POWER)),
    totalInputWatts: at(regs, INPUT.TOTAL_INPUT_POWER),
    totalOutputWatts: at(regs, INPUT.TOTAL_OUTPUT_POWER),
    charging:
      (at(regs, INPUT.AC_CHARGING_STATE) & AC_CHARGING_ACTIVE) !== 0 ||
      (status & STATUS.CHARGING_FROM_AC) !== 0,
    acInputConnected:
      (status & STATUS.AC_INPUT_CONNECTED) !== 0 || acInputVolts >= AC_INPUT_PRESENT_VOLTS,
    dcInputConnected: (status & STATUS.DC_INPUT_CONNECTED) !== 0,
    acOutputEnabled: (status & STATUS.AC_OUTPUT_ON) !== 0,
    dcOutputEnabled: (status & STATUS.DC_OUTPUT_ON) !== 0,
    usbOutputEnabled: (status & STATUS.USB_OUTPUT_ON) !== 0,
    ledEnabled: (status & STATUS.LED_ON) !== 0,
    ledMode: at(regs, INPUT.LED_STATE),
    minutesToFull: toFull > 0 ? toFull : null,
    minutesToEmpty: toEmpty > 0 ? toEmpty : null,
    chargingBookingMinutes: at(regs, INPUT.AC_CHARGING_BOOKING),
  };
}

export type DecodedSettings = {
  maxChargingCurrent: number;
  usbOutput: boolean;
  dcOutput: boolean;
  acOutput: boolean;
  ledMode: number;
  keySound: boolean;
  acSilentCharging: boolean;
  usbStandbyMinutes: number;
  acStandbyMinutes: number;
  dcStandbyMinutes: number;
  screenRestSeconds: number;
  stopChargeAfterMinutes: number;
  dischargeLowerLimitPercent: number;
  chargingUpperLimitPercent: number;
  sleepMinutes: number;
};

export function decodeSettings(regs: readonly number[]): DecodedSettings {
  return {
    maxChargingCurrent: at(regs, HOLDING.MAX_CHARGING_CURRENT),
    usbOutput: at(regs, HOLDING.USB_OUTPUT) === 1,
    dcOutput: at(regs, HOLDING.DC_OUTPUT) === 1,
    acOutput: at(regs, HOLDING.AC_OUTPUT) === 1,
    ledMode: at(regs, HOLDING.LED_MODE),
    keySound: at(regs, HOLDING.KEY_SOUND) === 1,
    acSilentCharging: at(regs, HOLDING.AC_SILENT_CHARGING) === 1,
    usbStandbyMinutes: at(regs, HOLDING.USB_STANDBY_MINUTES),
    acStandbyMinutes: at(regs, HOLDING.AC_STANDBY_MINUTES),
    dcStandbyMinutes: at(regs, HOLDING.DC_STANDBY_MINUTES),
    screenRestSeconds: at(regs, HOLDING.SCREEN_REST_SECONDS),
    stopChargeAfterMinutes: at(regs, HOLDING.STOP_CHARGE_AFTER_MINUTES),
    dischargeLowerLimitPercent: tenths(at(regs, HOLDING.DISCHARGE_LOWER_LIMIT)),
    chargingUpperLimitPercent: tenths(at(regs, HOLDING.AC_CHARGING_UPPER_LIMIT)),
    sleepMinutes: at(regs, HOLDING.SLEEP_MINUTES),
  };
}

/** Human-readable names, for the diagnostics register dump. */
export const INPUT_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(INPUT).map(([name, reg]) => [reg, name])
);

export const HOLDING_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(HOLDING).map(([name, reg]) => [reg, name])
);
