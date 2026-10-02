import { describe, expect, test } from 'bun:test';

import { checkValue, MAIN_PART } from '@kraftverk/device-sdk';
import { writtenAttribute } from '@kraftverk/automation';

import { describeStation, settingsToValues, valuesToSettings } from './index.ts';
import { settingsWrites } from './model/station.ts';
import type { StationSettings } from './model/types.ts';

/*
  The station's settings every station has, by their standard meanings, so a
  recipe can change them without naming this station's keys — and its AC
  charging power as the number it is, in the five steps it has.
*/
describe('the settings every station has', () => {
  const description = describeStation();

  test('are found by what they mean, on the station itself', () => {
    expect(writtenAttribute(description, MAIN_PART, { means: 'battery.chargeLimit' })?.key).toBe('chargeLimit');
    expect(writtenAttribute(description, MAIN_PART, { means: 'battery.dischargeFloor' })?.key).toBe('dischargeFloor');
    expect(writtenAttribute(description, MAIN_PART, { means: 'power.in.ac.max' })?.key).toBe('acChargingWatts');
  });

  test('its AC charging power is watts, in its five steps: one between them is refused before it reaches a register', () => {
    const power = writtenAttribute(description, MAIN_PART, { means: 'power.in.ac.max' })!;
    expect(checkValue(power.value, 1200)).toEqual({ ok: true, value: 1200 });
    expect(checkValue(power.value, 700)).toEqual({ ok: false, problem: 'must be in steps of 300 from 600' });
    expect(() => settingsWrites({ acChargingWatts: 700 as never })).toThrow('AC charging power is one of 600, 900, 1200, 1500, 1800 W, not 700');
    expect(settingsWrites({ acChargingWatts: 1200 })).toEqual([[13, 3]]);
  });

  test('its AC charging power reads and writes as a number', () => {
    expect(settingsToValues({ acChargingWatts: 900 } as StationSettings).acChargingWatts).toBe(900);
    expect(valuesToSettings({ acChargingWatts: 1500 })).toEqual({ acChargingWatts: 1500 });
  });
});
