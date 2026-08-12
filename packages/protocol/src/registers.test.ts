import { describe, expect, test } from 'bun:test';

import { fromHex, parseFrame } from './modbus.ts';
import { assertWritable, decodeTelemetry, HOLDING, UnsafeWriteError } from './registers.ts';

// prettier-ignore
const CAPTURE =
  '110400000050000000000005000000000000000000000000000000000000000000000000000000000000090001f40066000d00000000000000000000000000000000000000000000000000000000000000000000006600000804000000000000000000003000400000000000000000000000016d000002980000000002810000000000ffffff0000000000000000000000000000000000000000000000000000000000000000dfb5';

function telemetryFromCapture() {
  const parsed = parseFrame(fromHex(CAPTURE));
  if (parsed?.kind !== 'registers') throw new Error('capture did not parse');
  return decodeTelemetry(parsed.values);
}

describe('telemetry decoding against a real device capture', () => {
  const t = telemetryFromCapture();

  test('state of charge is scaled from tenths of a percent', () => {
    expect(t.socPercent).toBe(66.4);
  });

  test('total output power', () => {
    expect(t.totalOutputWatts).toBe(102);
  });

  test('runtime remaining, and no charge ETA while discharging', () => {
    expect(t.minutesToEmpty).toBe(641);
    expect(t.minutesToFull).toBeNull();
  });

  test('not charging in this capture', () => {
    // Register 48 reads 0x4000 here, not 0x8000.
    expect(t.charging).toBe(false);
  });

  test('no expansion batteries attached', () => {
    expect(t.expansionSoc).toEqual([]);
  });

  test('no charge booking set', () => {
    expect(t.chargingBookingMinutes).toBe(0);
  });

  test('AC output is on and reporting mains-shaped values', () => {
    expect(t.acOutputEnabled).toBe(true);
    expect(t.acOutputVolts).toBe(230.4);
    expect(t.acOutputHz).toBe(50);
  });

  /**
   * Status register is 0x0804 here. The published map treats mask 0x000E as
   * "AC input connected", which would make bit 2 flag mains — but the input
   * reads 1.3 V at 0 Hz, register 48 says not charging, and the pack is
   * draining. Treating this device as grid-connected would be wrong.
   */
  test('does not report mains when the unit is demonstrably on battery', () => {
    expect(t.acInputVolts).toBe(1.3);
    expect(t.acInputHz).toBe(0);
    expect(t.acInputConnected).toBe(false);
  });

  test('no DC/solar input in this capture', () => {
    expect(t.dcInputConnected).toBe(false);
    expect(t.dcInputWatts).toBe(0);
  });
});

describe('write safety', () => {
  test('refuses the register/value combination that bricks the device', () => {
    expect(() => assertWritable(HOLDING.SLEEP_MINUTES, 0)).toThrow(UnsafeWriteError);
  });

  test('allows documented sleep values', () => {
    expect(() => assertWritable(HOLDING.SLEEP_MINUTES, 30)).not.toThrow();
  });

  test('refuses registers that are not on the whitelist', () => {
    expect(() => assertWritable(999, 1)).toThrow(UnsafeWriteError);
    expect(() => assertWritable(0, 0)).toThrow(UnsafeWriteError);
  });

  test('enforces the official charge-limit range', () => {
    expect(() => assertWritable(HOLDING.AC_CHARGING_UPPER_LIMIT, 800)).not.toThrow();
    expect(() => assertWritable(HOLDING.AC_CHARGING_UPPER_LIMIT, 100)).toThrow(UnsafeWriteError);
  });

  test('rejects non-integers', () => {
    expect(() => assertWritable(HOLDING.MAX_CHARGING_CURRENT, 5.5)).toThrow(UnsafeWriteError);
  });
});
