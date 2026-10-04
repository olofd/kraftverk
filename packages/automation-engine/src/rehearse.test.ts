import { describe, expect, test } from 'bun:test';

import { chargeBetween, inlineParams, type Recipe } from '@kraftverk/automation';
import { MAIN_PART, savedDeviceId, type DeviceDescription } from '@kraftverk/device-sdk';

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

const automation = { roles: { battery: { device: STATION, part: MAIN_PART }, charger: { device: PLUG, part: MAIN_PART } }, timeZone: 'Europe/Stockholm' };
/** The charge window as an automation owns it: its settings written into its blocks. */
const SETTINGS = { low: 15, lowFor: 120, high: 50, highFor: 0 };
const window15to50 = inlineParams(chargeBetween, SETTINGS);
const window = { from: new Date(START), to: new Date(START + 20 * 60_000) };

describe('a rule rehearsed on history', () => {
  test('the charge window: on once it has stayed below 15 % for 2 min, not at a dip; off when it reaches 50 %', async () => {
    const rehearsal = await rehearse(window15to50, automation, source(), window);
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
    expect((await rehearse(window15to50, automation, source(once), later)).runs.map((run) => [run.at, run.summary.split('.')[0]])).toEqual([[minute(2), 'Would turn Charger plug on']]);
    // Held for five: by then the sample is five minutes old, past current, and nothing is known.
    expect((await rehearse(inlineParams(chargeBetween, { ...SETTINGS, lowFor: 300 }), automation, source(once), later)).runs).toEqual([]);
  });
});

describe('a window of the day, rehearsed', () => {
  test('runs as it opens each evening, with no sample to say so', async () => {
    const nightly = inlineParams(
      {
        roles: { charger: { label: 'Charger plug', description: 'What charges it', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ becomes: { within: { from: { value: '22:00' }, to: { value: '06:00' } } } }],
        then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      {}
    );
    const twoDays = { from: new Date('2026-09-28T12:00:00.000Z'), to: new Date('2026-09-30T12:00:00.000Z') };
    const rehearsal = await rehearse(nightly, automation, source([]), twoDays);
    // 22:00 in Stockholm, summer time: 20:00 UTC.
    expect(rehearsal.runs.map((run) => [run.at, run.outcome])).toEqual([
      ['2026-09-28T20:00:00.000Z', 'would-act'],
      ['2026-09-29T20:00:00.000Z', 'would-act'],
    ]);
  });
});

describe('a time of day, rehearsed across a night the clocks change', () => {
  test('every day of the owner’s calendar has its 07:00 — the spring-forward night too', async () => {
    const morning = inlineParams(
      {
        roles: { charger: { label: 'Charger plug', description: 'What charges it', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ at: { value: '07:00' } }],
        then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      {}
    );
    // From 23:30 the evening before Stockholm springs forward (02:00 becomes 03:00 on 28 March 2027): a day is not 24 hours that night.
    const span = { from: new Date('2027-03-27T22:30:00.000Z'), to: new Date('2027-03-29T12:00:00.000Z') };
    const rehearsal = await rehearse(morning, automation, source([]), span);
    // 07:00 in Stockholm, summer time from that night: 05:00 UTC.
    expect(rehearsal.runs.map((run) => run.at)).toEqual(['2027-03-28T05:00:00.000Z', '2027-03-29T05:00:00.000Z']);
  });
});

describe('every so many minutes, rehearsed', () => {
  test('runs at each slot of the window, on the owner’s clock', async () => {
    const quarterly = inlineParams(
      {
        roles: { charger: { label: 'Charger plug', description: 'What charges it', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ every: { value: 30 * 60 } }],
        then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      {}
    );
    const hours = { from: new Date('2026-09-29T06:00:00.000Z'), to: new Date('2026-09-29T07:59:00.000Z') };
    const rehearsal = await rehearse(quarterly, automation, source([]), hours);
    expect(rehearsal.runs.map((run) => run.at)).toEqual(['2026-09-29T06:00:00.000Z', '2026-09-29T06:30:00.000Z', '2026-09-29T07:00:00.000Z', '2026-09-29T07:30:00.000Z']);
  });
});
