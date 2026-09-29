import { describe, expect, test } from 'bun:test';

import { chargeBetween, MAIN_PART, savedDeviceId, type DeviceDescription, type Recipe } from '@kraftverk/device-sdk';

import { rehearse, type RehearseSource } from './rehearse.ts';

/*
  A rule rehearsed on what happened: the owner's charge window, walked
  through a morning of a station's charge, minute by minute.
*/

const STATION = savedDeviceId('d-station');
const PLUG = savedDeviceId('d-plug');
const START = Date.parse('2026-09-29T06:00:00.000Z');
const minute = (n: number) => new Date(START + n * 60_000).toISOString();

const BATTERY: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Station', kind: 'device' }],
  attributes: [{ key: 'soc', label: 'Charge', value: { type: 'number', unit: '%' }, quantity: 'percent', means: 'battery.soc' }],
};
const SWITCH: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
  attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'switch.on' }],
};

/** A charge that falls to 12 %, dips back above for a minute, stays under, then — charged some other way — climbs past 50 %. */
const CHARGE = [20, 18, 16, 14, 16, 13, 12, 12, 12, 12, 20, 30, 40, 49, 51, 55].map((soc, n) => ({ at: minute(n), value: soc, text: null }));

const source = (charge = CHARGE): RehearseSource => ({
  device: (binding) => (binding.device === STATION ? { name: 'Garage station', description: BATTERY } : binding.device === PLUG ? { name: 'Charger plug', description: SWITCH } : null),
  samples: (deviceId, key, from, to) => (deviceId === STATION && key === 'soc' ? charge.filter((row) => row.at >= from && row.at <= to) : []),
  events: () => [],
});

const automation = { roles: { battery: { device: STATION, part: MAIN_PART }, charger: { device: PLUG, part: MAIN_PART } }, params: { low: 15, high: 50, minutes: 2 }, timeZone: 'Europe/Stockholm' };
const window = { from: new Date(START), to: new Date(START + 20 * 60_000) };

describe('a rule rehearsed on history', () => {
  test('the charge window: on once it has stayed below 15 % for 2 min, not at a dip; off when it reaches 50 %', async () => {
    const rehearsal = await rehearse(chargeBetween, automation, source(), window);
    expect(rehearsal.runs.map((run) => [run.at, run.outcome, run.summary.split('.')[0]])).toEqual([
      // 14 % at minute 3 is back to 16 % at 4: no run. Under from 5, for two minutes by 7.
      [minute(7), 'would-act', 'Would turn Charger plug on'],
      [minute(14), 'would-act', 'Would turn Charger plug off'],
    ]);
    expect(rehearsal.caveats).toEqual(['History is what happened without it: what it would have changed is not in it']);
  });

  test('says what it cannot see: a part with no history, a function history does not keep', async () => {
    const asksTheSky: Recipe = { ...chargeBetween, if: { call: 'acme.weather.skyLooks', role: 'battery' } };
    const rehearsal = await rehearse(asksTheSky, automation, source([]), window);
    expect(rehearsal.runs).toEqual([]);
    expect(rehearsal.caveats).toEqual(['Garage station kept no charge in that time', 'It asks acme.weather.skyLooks of Garage station, which history does not keep: taken as unknown']);
  });

  test('a hold runs its time with no new sample, as the engine’s timer does; a value older than it stays current is not known then', async () => {
    // One sample at 10 %, then silence: two minutes on, it is still current, and the hold has run.
    const once = [{ at: minute(0), value: 10, text: null }];
    const later = { from: new Date(START), to: new Date(START + 60 * 60_000) };
    expect((await rehearse(chargeBetween, automation, source(once), later)).runs.map((run) => [run.at, run.summary.split('.')[0]])).toEqual([[minute(2), 'Would turn Charger plug on']]);
    // Held for five: by then the sample is five minutes old, past current, and nothing is known.
    expect((await rehearse(chargeBetween, { ...automation, params: { ...automation.params, minutes: 5 } }, source(once), later)).runs).toEqual([]);
  });
});
