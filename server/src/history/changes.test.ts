import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { savedDeviceId, type DeviceDescription, type Reading } from '@kraftverk/device-sdk';
import { LiveBus } from '@kraftverk/holder';

import { ChangeLog, changesOf, loggedAttributes, pruneChanges, recordChanges } from './changes.ts';
import { closeDb, db } from './db.ts';

/**
 * The state-change log: an on/off or a mode, the moment it changed — and
 * nothing when it did not.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-changes-'));
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
const rows = () => db().query<{ key: string; at: string; value: number | null; text: string | null }, []>('SELECT key, at, value, text FROM sample_change ORDER BY key, at').all();

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db().exec('DELETE FROM sample_change; DELETE FROM device');
  db().query("INSERT INTO device (id, type_id, name, description, added_at) VALUES (?, 'test.station', 'Station', '{}', ?)").run(STATION, at(0));
});

describe('the change log', () => {
  test('keeps on/offs and modes, not numbers', () => {
    expect([...LOGGED.keys()]).toEqual(['outlet.ac.on', 'mode']);
  });

  test('writes a row when a value changes, and nothing when it says the same again', () => {
    expect(recordChanges(STATION, LOGGED, [on(true, 0), { key: 'mode', value: 'eco', at: at(0) }, { key: 'watts', value: 40, at: at(0) }])).toBe(2);
    expect(recordChanges(STATION, LOGGED, [on(true, 1), on(true, 2)])).toBe(0);
    expect(recordChanges(STATION, LOGGED, [on(false, 2)])).toBe(1);
    expect(rows().filter((row) => row.key === 'outlet.ac.on').map((row) => [row.at, row.value])).toEqual([
      [at(0), 1],
      [at(2), 0],
    ]);
  });

  test('a late reading lands in its place, and what follows it goes if it no longer changes anything', () => {
    recordChanges(STATION, LOGGED, [on(true, 0), on(false, 10)]);
    // Queued by an app that was away: it was off from minute 5, so minute 10 is no change.
    recordChanges(STATION, LOGGED, [on(false, 5)]);
    expect(rows().map((row) => [row.at, row.value])).toEqual([
      [at(0), 1],
      [at(5), 0],
    ]);
  });

  test('a time to come is a clock that is wrong, not a change', () => {
    expect(recordChanges(STATION, LOGGED, [{ key: 'outlet.ac.on', value: true, at: new Date(Date.now() + 3_600_000).toISOString() }])).toBe(0);
  });

  test('a span starts knowing what each was', () => {
    recordChanges(STATION, LOGGED, [on(true, 0), { key: 'mode', value: 'eco', at: at(0) }, on(false, 20), on(true, 40)]);
    const changes = changesOf(STATION, DESCRIPTION, { from: at(10), to: at(30) });
    expect(changes).toEqual([
      { key: 'mode', part: 'main', at: at(0), value: 'eco' },
      { key: 'outlet.ac.on', part: 'outlet.ac', at: at(0), value: true },
      { key: 'outlet.ac.on', part: 'outlet.ac', at: at(20), value: false },
    ]);
    expect(changesOf(STATION, DESCRIPTION, { from: at(10), to: at(30), key: 'mode' }).map((change) => change.value)).toEqual(['eco']);
  });

  test('two years on, old changes go but each key keeps its latest', () => {
    recordChanges(STATION, LOGGED, [on(true, 0), on(false, 1), { key: 'mode', value: 'eco', at: at(0) }]);
    pruneChanges(Date.parse(at(0)) + 800 * 86_400_000);
    expect(rows().map((row) => [row.key, row.at])).toEqual([
      ['mode', at(0)],
      ['outlet.ac.on', at(1)],
    ]);
  });

  test('follows the live bus: what the server’s sessions report', () => {
    const bus = new LiveBus();
    const log = new ChangeLog(bus, (id) => (id === STATION ? DESCRIPTION : null));
    log.start();
    bus.publish({ kind: 'readings', deviceId: STATION, readings: [on(true, 0)] });
    bus.publish({ kind: 'readings', deviceId: STATION, readings: [on(false, 3)] });
    log.stop();
    bus.publish({ kind: 'readings', deviceId: STATION, readings: [on(true, 6)] });
    expect(rows().map((row) => row.value)).toEqual([1, 0]);
  });
});
