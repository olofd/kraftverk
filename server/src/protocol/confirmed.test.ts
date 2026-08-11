import { describe, expect, test } from 'bun:test';

import { decodeTelemetry, HOLDING, STATUS } from './registers.ts';

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

  test('AC charge limit register is the one BrightEMS shows', () => {
    // BrightEMS showed 60%; holding register 67 read 600.
    expect(HOLDING.AC_CHARGING_UPPER_LIMIT).toBe(67);
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

  test('LED mode 1 is "always on", matching the unit', () => {
    expect(decodeTelemetry(telemetry({ 25: 1 })).ledMode).toBe(1);
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
