import { beforeEach, describe, expect, test } from 'bun:test';

import { savedDeviceId, type DeviceDescription, type Reading } from '@kraftverk/device-sdk';
import { LiveBus } from '@kraftverk/holder';

import type { SqlDatabase } from '@kraftverk/store';

import { ChangeLog, changesOf, loggedAttributes, pruneChanges, recordChanges } from '../src/history/changes.ts';
import { testDatabase } from './home.ts';

/**
 * The state-change log: an on/off or a mode, the moment it changed — and
 * nothing when it did not.
 */

let db: SqlDatabase;
const STATION = savedDeviceId('d-station');

const DESCRIPTION: DeviceDescription = {
  parts: [{ id: 'outlet.ac', label: 'AC outlets', kind: 'outlet' }],
  attributes: [
    { key: 'outlet.ac.on', part: 'outlet.ac', label: 'AC outlets', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'mode', label: 'Mode', value: { type: 'enum', options: [{ value: 'eco', label: 'Eco' }, { value: 'fast', label: 'Fast' }] } },
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power.draw' },
  ],
};
const LOGGED = loggedAttributes(DESCRIPTION);

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 14, minute)).toISOString();
const on = (value: boolean, minute: number): Reading => ({ key: 'outlet.ac.on', value, at: at(minute) });
const rows = () => db.query<{ key: string; at: string; value: number | null; text: string | null }, []>('SELECT key, at, value, text FROM sample_change ORDER BY key, at').all();

beforeEach(() => {
  db = testDatabase();
  db.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES (?1, ?1, 'test.station', 'Station', '{}', ?2)").run(STATION, at(0));
});

describe('the change log', () => {
  test('keeps on/offs and modes, not numbers', () => {
    expect([...LOGGED.keys()]).toEqual(['outlet.ac.on', 'mode']);
  });

  test('writes a row when a value changes, and nothing when it says the same again', () => {
    expect(recordChanges(db, STATION, LOGGED, [on(true, 0), { key: 'mode', value: 'eco', at: at(0) }, { key: 'watts', value: 40, at: at(0) }])).toBe(2);
    expect(recordChanges(db, STATION, LOGGED, [on(true, 1), on(true, 2)])).toBe(0);
    expect(recordChanges(db, STATION, LOGGED, [on(false, 2)])).toBe(1);
    expect(rows().filter((row) => row.key === 'outlet.ac.on').map((row) => [row.at, row.value])).toEqual([
      [at(0), 1],
      [at(2), 0],
    ]);
  });

  test('a late reading lands in its place, and what follows it goes if it no longer changes anything', () => {
    recordChanges(db, STATION, LOGGED, [on(true, 0), on(false, 10)]);
    // Queued by an app that was away: it was off from minute 5, so minute 10 is no change.
    recordChanges(db, STATION, LOGGED, [on(false, 5)]);
    expect(rows().map((row) => [row.at, row.value])).toEqual([
      [at(0), 1],
      [at(5), 0],
    ]);
  });

  test('a time to come is a clock that is wrong, not a change', () => {
    expect(recordChanges(db, STATION, LOGGED, [{ key: 'outlet.ac.on', value: true, at: new Date(Date.now() + 3_600_000).toISOString() }])).toBe(0);
  });

  test('a span starts knowing what each was', () => {
    recordChanges(db, STATION, LOGGED, [on(true, 0), { key: 'mode', value: 'eco', at: at(0) }, on(false, 20), on(true, 40)]);
    const changes = changesOf(db, STATION, DESCRIPTION, { from: at(10), to: at(30) });
    expect(changes).toEqual([
      { key: 'mode', part: 'main', at: at(0), value: 'eco' },
      { key: 'outlet.ac.on', part: 'outlet.ac', at: at(0), value: true },
      { key: 'outlet.ac.on', part: 'outlet.ac', at: at(20), value: false },
    ]);
    expect(changesOf(db, STATION, DESCRIPTION, { from: at(10), to: at(30), key: 'mode' }).map((change) => change.value)).toEqual(['eco']);
  });

  test('two years on, old changes go but each key keeps its latest', () => {
    recordChanges(db, STATION, LOGGED, [on(true, 0), on(false, 1), { key: 'mode', value: 'eco', at: at(0) }]);
    pruneChanges(db, Date.parse(at(0)) + 800 * 86_400_000);
    expect(rows().map((row) => [row.key, row.at])).toEqual([
      ['mode', at(0)],
      ['outlet.ac.on', at(1)],
    ]);
  });

  test('follows the live bus: what the server’s sessions report', () => {
    const bus = new LiveBus();
    const log = new ChangeLog(db, bus, (id) => (id === STATION ? DESCRIPTION : null));
    log.start();
    bus.publish({ kind: 'readings', deviceId: STATION, readings: [on(true, 0)] });
    bus.publish({ kind: 'readings', deviceId: STATION, readings: [on(false, 3)] });
    log.stop();
    bus.publish({ kind: 'readings', deviceId: STATION, readings: [on(true, 6)] });
    expect(rows().map((row) => row.value)).toEqual([1, 0]);
  });
});
