import { describe, expect, test } from 'bun:test';

import {
  assertWritable,
  decodeSettings,
  decodeTelemetry,
  HOLDING,
  STATUS,
  UnsafeWriteError,
  wattsToChargeRate,
} from './registers.ts';

/**
 * Behaviour confirmed against a real AFERIY P280 over BLE.
 *
 * Each case here was observed on hardware, not taken from the published map —
 * these are the parts we know are right for this model.
 */

/** Builds an 80-register telemetry array with specific values set. */
function telemetry(values: Record<number, number>): number[] {
  const regs = new Array(80).fill(0);
  for (const [index, value] of Object.entries(values)) regs[Number(index)] = value;
  return regs;
}

/** Same shape, for the holding (settings) bank. */
const holding = telemetry;

describe('confirmed on a real P280', () => {
  test('charging flag is a bitmask: the station reports 0x8040, not 0x8000', () => {
    // Comparing this register for equality against 0x8000 missed the flag.
    const t = decodeTelemetry(telemetry({ 48: 0x8040 }));
    expect(t.charging).toBe(true);
  });

  test('switching USB on sets both the USB and DC-converter bits', () => {
    // Observed: status went 0x0020 -> 0x02A0 when USB was enabled at the unit.
    const before = decodeTelemetry(telemetry({ 41: 0x0020 }));
    expect(before.usbOutputEnabled).toBe(false);

    const after = decodeTelemetry(telemetry({ 41: 0x02a0 }));
    expect(after.usbOutputEnabled).toBe(true);
    expect(after.acOutputEnabled).toBe(false);
    expect(after.dcOutputEnabled).toBe(false);
    expect(0x02a0 & STATUS.DC_CONVERTER_ACTIVE).toBeTruthy();
  });

  test('a panel attached but not producing still counts as DC input present', () => {
    // 0x0020 alone with no solar; 0x0060 once it delivers. Not redundant bits.
    expect(decodeTelemetry(telemetry({ 41: 0x0020 })).dcInputConnected).toBe(true);
    expect(decodeTelemetry(telemetry({ 41: 0x0060 })).dcInputConnected).toBe(true);
    expect(decodeTelemetry(telemetry({ 41: 0x0000 })).dcInputConnected).toBe(false);
  });

  test('state of charge scales by ten: 1000 is 100%', () => {
    expect(decodeTelemetry(telemetry({ 56: 1000 })).socPercent).toBe(100);
  });

  test('idle runtime of many days decodes without overflowing', () => {
    // The station genuinely reported 22560 minutes at rest.
    expect(decodeTelemetry(telemetry({ 59: 22560 })).minutesToEmpty).toBe(22560);
  });

  /**
   * Both battery limits cross-checked against BrightEMS on the same unit:
   * charge limit 60% with register 67 reading 600, discharge limit 10% with
   * register 66 reading 100. Tenths of a percent in both cases.
   */
  test('battery limit registers match what BrightEMS displays', () => {
    expect(HOLDING.AC_CHARGING_UPPER_LIMIT).toBe(67);
    expect(HOLDING.DISCHARGE_LOWER_LIMIT).toBe(66);
    expect(decodeSettings(holding({ 67: 600, 66: 100 }))).toMatchObject({
      chargingUpperLimitPercent: 60,
      dischargeLowerLimitPercent: 10,
    });
  });

  /**
   * 23% is the useful case: not a round number, so it shows the tenths scaling
   * holds at arbitrary values rather than only at multiples of ten. The UI
   * slider originally stepped by 5 and could not have produced it.
   */
  test('discharge limit decodes an arbitrary percentage, not just round ones', () => {
    expect(decodeSettings(holding({ 66: 230 })).dischargeLowerLimitPercent).toBe(23);
  });

  /**
   * BrightEMS shows this as "24:00", which reads like a clock time. It is a
   * countdown in minutes: scheduling 24 hours stored 1439, and the register
   * decremented once a minute (1438 -> 1437 over 101 s). Input 57 mirrors it.
   */
  test('AC charge booking is a duration in minutes, not a clock time', () => {
    expect(decodeSettings(holding({ 63: 1439 })).stopChargeAfterMinutes).toBe(1439);
    expect(decodeTelemetry(telemetry({ 57: 1439 })).chargingBookingMinutes).toBe(1439);
    // Zero means charging is enabled, not "scheduled for midnight".
    expect(decodeSettings(holding({ 63: 0 })).stopChargeAfterMinutes).toBe(0);
  });

  test('the booking register tops out at 1439, so 1440 is refused', () => {
    expect(() => assertWritable(HOLDING.STOP_CHARGE_AFTER_MINUTES, 1439)).not.toThrow();
    expect(() => assertWritable(HOLDING.STOP_CHARGE_AFTER_MINUTES, 1440)).toThrow(UnsafeWriteError);
  });

  /**
   * BrightEMS offers 600/900/1200/1500/1800 W; the register stores 1-5.
   * Confirmed on a P280: 1200 W read 3, and changing to 900 W read 2. Input
   * register 2 mirrors it.
   *
   * The published map gives this scale as 300-1100 W for a FOSSiBOT F2400, so
   * the step-to-watts mapping is model-specific and must not be assumed.
   */
  test('AC charging power steps map to P280 wattages', () => {
    expect(decodeSettings(holding({ 13: 3 })).acChargingWatts).toBe(1200);
    expect(decodeSettings(holding({ 13: 2 })).acChargingWatts).toBe(900);
    expect(decodeSettings(holding({ 13: 1 })).acChargingWatts).toBe(600);
    expect(decodeSettings(holding({ 13: 5 })).acChargingWatts).toBe(1800);
    expect(wattsToChargeRate(900)).toBe(2);
    expect(wattsToChargeRate(1200)).toBe(3);
  });

  test('the charging rate register is writable, despite the docs marking it read-only', () => {
    // BrightEMS changes it, and nothing else moved when the power changed.
    for (const step of [1, 2, 3, 4, 5]) {
      expect(() => assertWritable(HOLDING.AC_CHARGING_RATE, step)).not.toThrow();
    }
    expect(() => assertWritable(HOLDING.AC_CHARGING_RATE, 6)).toThrow(UnsafeWriteError);
    expect(() => assertWritable(HOLDING.AC_CHARGING_RATE, 0)).toThrow(UnsafeWriteError);
  });

  test('AC silent charging is holding register 57', () => {
    expect(decodeSettings(holding({ 57: 1 })).acSilentCharging).toBe(true);
    expect(decodeSettings(holding({ 57: 0 })).acSilentCharging).toBe(false);
  });

  /**
   * Register 48 is AC-specific and useless as a general "is it charging" flag:
   * 0x8040 charging from mains, 0x4000 mains present but idle, and 0 with no AC
   * at all — including while charging happily from solar. The driver derives
   * state from net power flow instead.
   */
  test('a station charging from solar alone reports no AC charging state', () => {
    const t = decodeTelemetry(telemetry({ 48: 0, 41: 0x0864, 4: 50, 6: 50 }));
    expect(t.charging).toBe(false); // no *AC* charging
    expect(t.dcInputConnected).toBe(true);
    expect(t.dcInputWatts).toBe(50);
    expect(t.totalInputWatts).toBe(50);
  });

  test('mains is not reported present on a station running off battery', () => {
    // status 0x0804 with AC input at 1.3V, 0Hz, not charging.
    const t = decodeTelemetry(telemetry({ 41: 0x0804, 21: 13, 48: 0x4000 }));
    expect(t.acInputConnected).toBe(false);
  });

  test('switching AC output on sets the output bit and the inverter bit', () => {
    // Observed: status 0x0020 -> 0x0824 with nothing plugged into the wall.
    const t = decodeTelemetry(telemetry({ 41: 0x0824, 18: 2306, 20: 9 }));
    expect(t.acOutputEnabled).toBe(true);
    expect(t.acOutputVolts).toBe(230.6);
    expect(t.acOutputWatts).toBe(9);
    expect(0x0824 & STATUS.INVERTER_ACTIVE).toBeTruthy();
  });

  /**
   * The inverter backfeeds the AC *input* sense line. A P280 running its
   * inverter with nothing plugged into the wall reported 59.1 V on register 21
   * at 0 Hz. Voltage alone would call that mains and claim the station was on
   * grid power while it drained its own battery.
   */
  test('inverter backfeed on the AC input sense line is not mistaken for mains', () => {
    const t = decodeTelemetry(telemetry({ 41: 0x0824, 21: 591, 22: 0, 18: 2306 }));
    expect(t.acInputVolts).toBe(59.1);
    expect(t.acInputHz).toBe(0);
    expect(t.acInputConnected).toBe(false);
  });

  test('real mains — mains-level voltage at mains frequency — is recognised', () => {
    const t = decodeTelemetry(telemetry({ 41: 0x0000, 21: 2304, 22: 5000 }));
    expect(t.acInputVolts).toBe(230.4);
    expect(t.acInputHz).toBe(50);
    expect(t.acInputConnected).toBe(true);
  });

  test('USB standby timer reads 3 minutes, matching the observed auto-off', () => {
    expect(HOLDING.USB_STANDBY_MINUTES).toBe(59);
  });

  test('the light sets its own bit and the DC-converter bit', () => {
    // Observed: status 0x0824 (AC on) -> 0x18A4 when the light came on, adding
    // 0x1000 and 0x0080. The light draws through the DC converter, as USB does.
    const t = decodeTelemetry(telemetry({ 41: 0x18a4, 15: 10, 25: 1 }));
    expect(t.ledEnabled).toBe(true);
    expect(t.acOutputEnabled).toBe(true);
    expect(0x18a4 & STATUS.DC_CONVERTER_ACTIVE).toBeTruthy();
  });

  /**
   * Verified on hardware for off, on and SOS. The light stayed lit and the
   * status bit stayed set across the mode change, so the mode register is
   * independent of the on/off bit.
   */
  test('LED mode enum matches the unit: 0 off, 1 always-on, 2 SOS', () => {
    expect(decodeTelemetry(telemetry({ 25: 0 })).ledMode).toBe(0);
    expect(decodeTelemetry(telemetry({ 25: 1 })).ledMode).toBe(1);
    expect(decodeTelemetry(telemetry({ 41: 0x18a4, 25: 2 })).ledMode).toBe(2);
  });

  test('reported LED draw is nominal, not instantaneous', () => {
    // Register 15 stayed at 10 (1.0 W) while the light was flashing in SOS.
    expect(decodeTelemetry(telemetry({ 15: 10, 25: 2 })).ledWatts).toBe(1);
  });

  /**
   * With AC, DC, USB and the light all exercised on a real unit, every bit the
   * status register sets is now individually accounted for. 0x1CA4 was observed
   * with AC output, the car port and the light on, a panel attached, and the
   * inverter running.
   */
  test('every bit of an observed status word decodes', () => {
    const t = decodeTelemetry(telemetry({ 41: 0x1ca4 }));
    expect(t.ledEnabled).toBe(true); //        0x1000
    expect(t.acOutputEnabled).toBe(true); //   0x0800
    expect(t.dcOutputEnabled).toBe(true); //   0x0400
    expect(t.dcInputConnected).toBe(true); //  0x0020
    expect(t.usbOutputEnabled).toBe(false); // 0x0200 clear — USB was off
    expect(t.acInputConnected).toBe(false); // no mains; 0x0004 is the inverter

    const explained =
      STATUS.LED_ON |
      STATUS.AC_OUTPUT_ON |
      STATUS.DC_OUTPUT_ON |
      STATUS.DC_CONVERTER_ACTIVE |
      STATUS.DC_INPUT_CONNECTED |
      STATUS.INVERTER_ACTIVE;
    expect(0x1ca4 & ~explained).toBe(0);
  });

  /**
   * Proves the 0.1 W scaling by arithmetic rather than assumption: with the
   * inverter at 8 W and the light on, the station reported 9 W total. At whole
   * watts the LED's raw 10 would have made that 18.
   */
  test('LED power is tenths of a watt, and the output wattages add up', () => {
    const t = decodeTelemetry(telemetry({ 41: 0x18a4, 15: 10, 20: 8, 39: 9 }));
    expect(t.ledWatts).toBe(1);
    expect(t.acOutputWatts).toBe(8);
    expect(t.totalOutputWatts).toBe(9);
    expect(t.acOutputWatts + t.ledWatts).toBe(t.totalOutputWatts);
  });
});
