import { describe, expect, test } from 'bun:test';

import type { RunLog, RunLogKey, RunLogReach, RunStep } from '@kraftverk/api-contract';

import { atOf, awayOf, changed, heldPath, marksOf, said, seriesOf, sinceStart, spansOf, valueAt, windowOf, xOf } from './run-chart.ts';
import { actor } from '@kraftverk/device-sdk';

/*
  A run's log, as its page draws it: each value held from one reading to the
  next across the run's window, the steps that changed something numbered,
  and every value said in its own words.
*/

const T0 = Date.parse('2026-10-01T09:50:00.000Z');
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const WATTS: RunLogKey = { device: 'd-plug', key: 'watts', part: 'main', label: 'Power', kind: 'number', unit: 'W', quantity: 'power', words: null, options: null };
const RELAY: RunLogKey = { device: 'd-plug', key: 'relay', part: 'main', label: 'Relay', kind: 'boolean', unit: null, quantity: null, words: null, options: null };
const VOLTS: RunLogKey = { device: 'd-plug', key: 'volts', part: 'main', label: 'Voltage', kind: 'number', unit: 'V', quantity: 'voltage', words: null, options: null };

const step = (kind: RunStep['kind'], seconds: number, what: string): RunStep => ({ kind, depth: 0, within: null, what, outcome: 'done', detail: 'Done', at: iso(seconds), endedAt: iso(seconds + 1), until: null });

const LOG: Pick<RunLog, 'run' | 'keys' | 'readings' | 'reach'> = {
  run: {
    id: 'r-1',
    at: iso(0),
    endedAt: iso(60),
    startedBy: actor('person', 'olof'),
    startedByRun: null,
    outcome: 'acted',
    summary: 'Turned Smart plug on',
    why: 'Started by olof',
    saw: [],
    conditions: [],
    steps: [step('command', 0, 'Turn Smart plug on'), step('ensure', 1, 'Make sure it draws'), step('wait', 2, 'Wait 5 s'), step('command', 30, 'Turn Smart plug off')],
    answered: null,
  },
  keys: [WATTS, RELAY, VOLTS],
  readings: [
    // Taken before the run began: what it was as it began.
    { device: 'd-plug', key: 'watts', at: iso(-5), heardAt: iso(0), value: 0 },
    { device: 'd-plug', key: 'relay', at: iso(-5), heardAt: iso(0), value: false },
    { device: 'd-plug', key: 'volts', at: iso(-5), heardAt: iso(0), value: 235 },
    { device: 'd-plug', key: 'relay', at: iso(0.5), heardAt: iso(1), value: true },
    // Said again: no news.
    { device: 'd-plug', key: 'watts', at: iso(2), heardAt: iso(3), value: 0 },
    { device: 'd-plug', key: 'watts', at: iso(7), heardAt: iso(8), value: 297 },
    { device: 'd-plug', key: 'watts', at: iso(20), heardAt: iso(21), value: null },
    { device: 'd-plug', key: 'watts', at: iso(25), heardAt: iso(26), value: 276 },
    { device: 'd-plug', key: 'relay', at: iso(30.2), heardAt: iso(31), value: false },
  ],
  reach: [{ device: 'd-plug', at: iso(0), reachable: true, detail: 'Connected' }],
};

describe('a run’s log, drawn', () => {
  test('its window: from its start to its end', () => {
    expect(windowOf(LOG)).toEqual({ from: T0, to: T0 + 60_000 });
    // Still running: to the latest it heard, or now.
    expect(windowOf({ ...LOG, run: { ...LOG.run, endedAt: null } }, T0 + 45_000)).toEqual({ from: T0, to: T0 + 45_000 });
  });

  test('each value as the points it went through — a value said again left out, one from before the run at its start', () => {
    const window = windowOf(LOG);
    const [watts, relay, volts] = seriesOf(LOG, window);
    expect(watts!.points).toEqual([
      { at: T0, value: 0 },
      { at: T0 + 7_000, value: 297 },
      { at: T0 + 20_000, value: null },
      { at: T0 + 25_000, value: 276 },
    ]);
    expect(relay!.points.map((point) => point.value)).toEqual([false, true, false]);
    expect(changed(watts!)).toBe(true);
    expect(changed(volts!)).toBe(false);
  });

  test('a value that moved and moved back at one instant did not change', () => {
    const key = LOG.keys[0]!;
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    const readings = [3, 4, 3].map((value, index) => ({ device: key.device, key: key.key, value, at: at(index ? 200 : 100) }));
    const [only] = seriesOf({ keys: [key], readings } as never, { from: T0, to: T0 + 1_000 });
    expect(only!.points.map((point) => point.value)).toEqual([3]);
    expect(changed(only!)).toBe(false);
  });

  test('the steps that changed something, numbered: a check, a pause, or a switch already so is not marked', () => {
    expect(marksOf(LOG.run).map((mark) => [mark.n, mark.step.what, mark.at])).toEqual([
      [1, 'Turn Smart plug on', T0],
      [2, 'Turn Smart plug off', T0 + 30_000],
    ]);
    const already = { ...step('command', 0, 'Turn the supply on'), outcome: 'already' as const };
    expect(marksOf({ steps: [already, ...LOG.run.steps] }).map((mark) => mark.step.what)).toEqual(['Turn Smart plug on', 'Turn Smart plug off']);
  });

  test('held from one reading to the next, and on to the end — broken where it was not known', () => {
    const window = windowOf(LOG);
    const [watts] = seriesOf(LOG, window);
    // 60 s across 600 px: 10 px a second; 0 W at the bottom, 300 W at the top of 100 px.
    const path = heldPath(watts!.points, window, 600, (value) => 100 - value / 3);
    expect(path).toBe('M0.0,100.0H70.0L70.0,1.0H200.0M250.0,8.0H600.0');
    expect(spansOf(watts!.points, window).at(-1)).toEqual({ from: T0 + 25_000, to: T0 + 60_000, value: 276 });
  });

  test('a place across the chart and the instant it stands for, both ways — and what each value was then', () => {
    const window = windowOf(LOG);
    expect(xOf(T0 + 15_000, window, 600)).toBe(150);
    expect(atOf(150, window, 600)).toBe(T0 + 15_000);
    // Outside the window: held to its edges.
    expect(xOf(T0 - 5_000, window, 600)).toBe(0);
    const [watts] = seriesOf(LOG, window);
    expect(valueAt(watts!, T0 + 10_000)?.value).toBe(297);
    expect(valueAt(watts!, T0 + 22_000)?.value).toBeNull();
  });

  test('a device away: from each time it could not be reached to the next it could, or to the end', () => {
    const window = { from: T0, to: T0 + 60_000 };
    const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
    const reach: RunLogReach[] = [
      { device: 'd-plug', at: at(-5), reachable: false, detail: '' },
      { device: 'd-plug', at: at(10), reachable: true, detail: '' },
      { device: 'd-other', at: at(20), reachable: false, detail: '' },
      { device: 'd-plug', at: at(40), reachable: false, detail: '' },
    ];
    // Away before the run began counts from its start; away at its end, to its end.
    expect(awayOf(reach, 'd-plug', window)).toEqual([
      { from: T0, to: T0 + 10_000 },
      { from: T0 + 40_000, to: T0 + 60_000 },
    ]);
    expect(awayOf(reach, 'd-none', window)).toEqual([]);
  });

  test('time into the run, and each value in its own words', () => {
    const window = windowOf(LOG);
    expect(sinceStart(T0 + 67_300, window)).toBe('+1:07');
    expect(sinceStart(T0 + 7_300, window, true)).toBe('+0:07.3');
    expect(sinceStart(T0 + 59_960, window, true)).toBe('+1:00.0');
    expect(said(WATTS, 297)).toBe('297 W');
    expect(said(WATTS, null)).toBe('—');
    expect(said(RELAY, true)).toBe('on');
    expect(said({ ...RELAY, words: { true: 'Locked', false: 'Unlocked' } }, false)).toBe('Unlocked');
    expect(said({ ...RELAY, kind: 'enum', options: [{ value: 'relay', label: 'Lit while it is on' }] }, 'relay')).toBe('Lit while it is on');
  });
});
