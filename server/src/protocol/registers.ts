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
  /**
   * Confirmed on a P280: reads 10 with the light on, i.e. 1.0 W.
   *
   * The tenths scaling is proven by arithmetic rather than assumed — with the
   * inverter drawing 8 W and the light on, total output (register 39) read 9 W.
   * At whole watts the total would have been 18.
   */
  LED_POWER: 15,
  AC_OUTPUT_VOLTAGE: 18,
  AC_OUTPUT_FREQUENCY: 19,
  AC_OUTPUT_POWER: 20,
  AC_INPUT_VOLTAGE: 21,
  AC_INPUT_FREQUENCY: 22,
  /**
   * Confirmed on a P280 across three of four values: reads 1 in "always on"
   * and 2 in SOS, matching the documented enum 0=off, 1=on, 2=SOS, 3=flash.
   * Holding register 27 tracks it exactly.
   */
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
  /**
   * AC charging power, as a step 1-5. Confirmed on a P280 alongside input
   * register 2, which mirrors it: 1200 W read 3, 900 W read 2.
   *
   * The published map marks this read-only. It is not — BrightEMS changes it,
   * and nothing else moved when the power was changed.
   */
  AC_CHARGING_RATE: 13,
  /**
   * DC input type: 0 = PV (solar), 1 = DC (adapter / car).
   *
   * Not present in any published register map — the documented holding
   * registers skip from 13 to 20. Found by changing "DC input type setting" on
   * a P280 and diffing: this was the only register that moved to describe it.
   *
   * WARNING: writing this has a side effect. Switching PV -> DC also changed
   * MAX_CHARGING_CURRENT from 20 A to 8 A on its own. Re-read the settings
   * after writing rather than assuming the rest are unchanged.
   */
  DC_INPUT_TYPE: 15,
  /**
   * DC/solar charging current ceiling, in amps. Freely settable — a P280 was
   * observed at 20, 8 and 16 A.
   *
   * The usable maximum depends on the input type: 20 A in PV mode, 8 A in DC.
   * Switching to DC clamps a higher value down rather than rejecting it.
   */
  MAX_CHARGING_CURRENT: 20,
  /** Confirmed on a P280: 0 -> 1 when USB was switched on at the unit. */
  USB_OUTPUT: 24,
  /** Confirmed on a P280: 0 -> 1 when the 12V car port was switched on. */
  DC_OUTPUT: 25,
  /** Confirmed on a P280: 0 -> 1 when AC output was switched on at the unit. */
  AC_OUTPUT: 26,
  /** Confirmed on a P280: 0 -> 1 for "always on". */
  LED_MODE: 27,
  KEY_SOUND: 56,
  /** Confirmed on a P280: 0 -> 1 when "AC silent charging" was enabled. */
  AC_SILENT_CHARGING: 57,
  USB_STANDBY_MINUTES: 59,
  AC_STANDBY_MINUTES: 60,
  DC_STANDBY_MINUTES: 61,
  SCREEN_REST_SECONDS: 62,
  /**
   * Minutes until AC charging is enabled — a **live countdown**, not a clock
   * time or a static setting.
   *
   * Confirmed on a P280: scheduled for "24:00" in BrightEMS, the register read
   * 1439 and then ticked down one per minute (1438 -> 1437 over 101 s). Input
   * register 57 mirrors it. Reaching 0 lets charging resume.
   *
   * BrightEMS presents it as HH:MM, which reads like a clock time. It isn't.
   * Range is 0-1439; 1440 would be 24h exactly and appears not to be storable.
   */
  STOP_CHARGE_AFTER_MINUTES: 63,
  /**
   * Confirmed on a P280: read 100 while BrightEMS showed a 10% discharge limit.
   * Tenths of a percent, same scaling as the charge limit.
   */
  DISCHARGE_LOWER_LIMIT: 66,
  /**
   * Confirmed on a P280: read 600 while BrightEMS showed a 60% charge limit.
   *
   * The name is literal — it caps **AC** charging only. Solar charges past it,
   * which is why a station limited to 60% was sitting at 100% SOC. Don't
   * present this as a general "stop charging here" ceiling.
   */
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
 *   input   70,71    track state of charge but truncated to whole percent:
 *                      both read 1000 at 100.0% SOC and 990 the moment SOC fell
 *                      to 999 (99.9%). Most likely the value shown on the unit's
 *                      own display, in tenths. Two data points; needs a third at
 *                      a clearly different SOC before being relied on.
 *   input   47 = 0x3000, input 62 = 0x00ff, holding 11 = 0x1500  unknown flags.
 *
 * To identify any of these: snapshot the baseline, change one thing on the
 * station, and dump again (POST /api/diagnostics/snapshot).
 */
export const UNCONFIRMED_P280 = {
  MAYBE_BATTERY_TEMP: 54,
} as const;

/**
 * Holding registers 14-22 look like a capability block: constants describing
 * what the hardware supports, rather than settings.
 *
 * Three are effectively established. Holding 14 (`1800`) and 16 (`600`) are the
 * ends of the AC charging power scale and did not move when that setting
 * changed. Holding 17 (`20`) held steady while the actual current ceiling went
 * 20 -> 8 -> 16 A, so it is the maximum rather than a copy of it.
 *
 * That pattern makes 18 (`115`), 19 (`550`), 21 (`0x0300`) and 22 (`233`) more
 * likely to be limits too — plausibly voltages and currents — but none has been
 * moved by anything yet, which is exactly why they remain unidentified. Nothing
 * reads them.
 */
export const CAPABILITY_BLOCK = {
  MAX_AC_CHARGING_WATTS: 14,
  MIN_AC_CHARGING_WATTS: 16,
  MAX_DC_CHARGING_AMPS: 17,
} as const;

/**
 * AC charging power steps, confirmed on a P280.
 *
 * The published map documents this scale as 300-1100 W for a FOSSiBOT F2400.
 * The P280 is a bigger machine and uses an entirely different range, so the
 * step-to-watts mapping is model-specific and must not be assumed.
 *
 * Holding 14 reads 1800 and holding 16 reads 600 — the two ends of this scale.
 * Neither moved when the power was changed, so they look like capability
 * constants rather than settings.
 */
export const AC_CHARGING_WATTS = [600, 900, 1200, 1500, 1800] as const;
export type AcChargingWatts = (typeof AC_CHARGING_WATTS)[number];

/** Step 1-5 as stored in register 13, from a wattage. */
export const wattsToChargeRate = (watts: AcChargingWatts): number =>
  AC_CHARGING_WATTS.indexOf(watts) + 1;

/** Wattage from the 1-5 step, falling back to the nearest sane value. */
export const chargeRateToWatts = (rate: number): AcChargingWatts =>
  AC_CHARGING_WATTS[rate - 1] ?? 1800;

/**
 * Bit masks in input register 41.
 *
 * USB_OUTPUT_ON and DC_CONVERTER_ACTIVE are confirmed on a P280: switching USB
 * on at the unit moved the register from 0x0020 to 0x02A0, setting exactly
 * those two bits (USB feeds through the DC converter, so both are expected).
 */
export const STATUS = {
  /** Confirmed on a P280: set when the light was switched on at the unit. */
  LED_ON: 0x1000,
  /** Confirmed on a P280: set when AC output was switched on at the unit. */
  AC_OUTPUT_ON: 0x0800,
  /** Confirmed on a P280: set when the 12V car port was switched on. */
  DC_OUTPUT_ON: 0x0400,
  /** Confirmed on a P280. */
  USB_OUTPUT_ON: 0x0200,
  /** Confirmed on a P280. */
  DC_CONVERTER_ACTIVE: 0x0080,
  /**
   * The published map calls these two bits redundant. They are not: a P280 with
   * a panel attached but producing nothing reads 0x0020, and reads 0x0060 once
   * solar is actually delivering. Masking both still answers "is DC input
   * present", which is all this flag is used for.
   */
  DC_INPUT_CONNECTED: 0x0060,
  CHARGING_FROM_AC: 0x0010,
  /**
   * Confirmed by experiment: switching AC output on at a P280 with nothing
   * plugged into the wall moved status from 0x0020 to 0x0824 — setting 0x0800
   * (AC output) and 0x0004 together. Bit 2 is the inverter, not mains.
   *
   * The published map folds bit 2 into a 0x000E "AC input connected" mask,
   * which would report a station running purely off its own battery as being
   * on grid power. Mask bits 3 and 1 only.
   */
  INVERTER_ACTIVE: 0x0004,
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
  // Steps 1-5. On a P280 these are 600/900/1200/1500/1800 W — see AC_CHARGING_WATTS.
  [HOLDING.AC_CHARGING_RATE]: { kind: 'set', values: [1, 2, 3, 4, 5] },
  // 0 = PV, 1 = DC. Undocumented; both values observed on a P280.
  [HOLDING.DC_INPUT_TYPE]: { kind: 'set', values: [0, 1] },
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
  // 0-1439, not 0-1440: a P280 set to "24:00" stored 1439, and the published
  // map gives the same upper bound.
  [HOLDING.STOP_CHARGE_AFTER_MINUTES]: { kind: 'range', min: 0, max: 1439 },
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

/**
 * Corroborating a mains connection needs both voltage and frequency.
 *
 * Voltage alone is not enough: with the inverter running and nothing plugged
 * into the wall, a P280 reports 59.1 V on the AC *input* sense line — backfeed
 * from its own output. Real mains is ~110-240 V at 50/60 Hz, and the frequency
 * register reads 0 when no supply is present, so requiring both rejects the
 * backfeed case.
 */
const AC_INPUT_PRESENT_VOLTS = 100;
const AC_INPUT_PRESENT_HZ = 40;

export function decodeTelemetry(regs: readonly number[]): DecodedTelemetry {
  const status = at(regs, INPUT.STATUS_BITS);
  const acInputVolts = tenths(at(regs, INPUT.AC_INPUT_VOLTAGE));
  const acInputHz = Math.round(at(regs, INPUT.AC_INPUT_FREQUENCY)) / 100;

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
    acInputHz,
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
      (status & STATUS.AC_INPUT_CONNECTED) !== 0 ||
      (acInputVolts >= AC_INPUT_PRESENT_VOLTS && acInputHz >= AC_INPUT_PRESENT_HZ),
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

export type DcInputType = 'pv' | 'dc';

export type DecodedSettings = {
  /** AC charging power in watts, resolved from the 1-5 step. */
  acChargingWatts: AcChargingWatts;
  dcInputType: DcInputType;
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
    acChargingWatts: chargeRateToWatts(at(regs, HOLDING.AC_CHARGING_RATE)),
    dcInputType: at(regs, HOLDING.DC_INPUT_TYPE) === 1 ? 'dc' : 'pv',
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
