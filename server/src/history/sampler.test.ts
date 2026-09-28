import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Reading } from '@kraftverk/device-sdk';

import { closeDb, db } from './db.ts';
import { resolutionOf, rollUp, Sampler, series } from './sampler.ts';
import type { DeviceRegistry } from '../devices/registry.ts';

/**
 * What goes into history — and, as much, what does not.
 *
 * A chart is only as honest as its gaps: a device that has not reported, or
 * has stopped reporting, must leave one rather than a zero or a flat line.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-sampler-'));

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
});

afterAll(() => {
  closeDb();
  delete process.env.KRAFTVERK_DB;
  rmSync(dir, { recursive: true, force: true });
});

/** A registry holding one device with the given readings, saved as history needs it to be. */
const registry = (id: string, readings: Reading[]) => {
  db()
    .query("INSERT OR IGNORE INTO device (id, name, config, added_at, type_id) VALUES (?, ?, '{}', ?, 'test.device')")
    .run(id, id, new Date().toISOString());
  return { all: async () => [{ id, readings }] } as unknown as DeviceRegistry;
};

const stored = (id: string) =>
  db().query('SELECT key, value FROM sample WHERE device_id = ? ORDER BY key').all(id) as { key: string; value: number }[];

describe('sampling', () => {
  test('a current reading is stored; booleans as 0 and 1', async () => {
    const at = new Date().toISOString();
    await new Sampler(registry('fresh', [
      { key: 'soc', value: 73.4, at },
      { key: 'gridConnected', value: true, at },
    ])).sample();
    expect(stored('fresh')).toEqual([
      { key: 'gridConnected', value: 1 },
      { key: 'soc', value: 73.4 },
    ]);
  });

  test('a device that has not reported leaves a gap, not a zero', async () => {
    await new Sampler(registry('silent', [{ key: 'soc', value: null, at: new Date().toISOString() }])).sample();
    expect(stored('silent')).toEqual([]);
  });

  test('a device that stopped reporting leaves a gap, not its last value again', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await new Sampler(registry('stale', [{ key: 'soc', value: 73.4, at: tenMinutesAgo }])).sample();
    expect(stored('stale')).toEqual([]);
  });
});

describe('history that lasts', () => {
  const put = (id: string, at: Date, value: number) => db().query('INSERT OR REPLACE INTO sample (device_id, key, at, value) VALUES (?, ?, ?, ?)').run(id, 'soc', at.toISOString(), value);
  const hours = (id: string) =>
    db().query('SELECT hour, min, avg, max, n FROM sample_hour WHERE device_id = ? ORDER BY hour').all(id) as { hour: string; min: number; avg: number; max: number; n: number }[];

  test('minutes roll up into hours — and again, correctly, when late readings arrive', () => {
    registry('rolled', []);
    const hour = new Date(Date.UTC(2026, 8, 27, 10, 0));
    put('rolled', new Date(hour.getTime() + 60_000), 10);
    put('rolled', new Date(hour.getTime() + 2 * 60_000), 20);
    rollUp(hour.toISOString(), new Date(hour.getTime() + 3_600_000).toISOString());
    expect(hours('rolled')).toEqual([{ hour: '2026-09-27T10:00:00.000Z', min: 10, avg: 15, max: 20, n: 2 }]);

    put('rolled', new Date(hour.getTime() + 30 * 60_000), 60);
    rollUp(hour.toISOString(), new Date(hour.getTime() + 3_600_000).toISOString());
    expect(hours('rolled')).toEqual([{ hour: '2026-09-27T10:00:00.000Z', min: 10, avg: 30, max: 60, n: 3 }]);
  });

  test('pruning keeps the hours of the minutes it deletes, and two years of hours', () => {
    registry('kept', []);
    const now = Date.UTC(2026, 8, 28, 12, 0);
    const old = new Date(now - 15 * 86_400_000);
    put('kept', old, 42);
    db().query("INSERT INTO sample_hour (device_id, key, hour, min, avg, max, n) VALUES ('kept', 'soc', '2020-01-01T00:00:00.000Z', 1, 1, 1, 1)").run();
    new Sampler(registry('kept', [])).prune(now);
    expect(stored('kept')).toEqual([]);
    expect(hours('kept').map((row) => [row.hour.slice(0, 10), row.avg])).toEqual([[old.toISOString().slice(0, 10), 42]]);
  });

  test('a long span is drawn from the hours, a short one from the minutes', () => {
    const now = Date.now();
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const to = new Date(now).toISOString();
    expect(resolutionOf(ago(24), to)).toBe('minute');
    expect(resolutionOf(ago(24 * 30), to)).toBe('hour');

    registry('charted', []);
    const hour = new Date(Math.floor((now - 10 * 86_400_000) / 3_600_000) * 3_600_000);
    db().query('INSERT INTO sample_hour (device_id, key, hour, min, avg, max, n) VALUES (?, ?, ?, 1, 50, 99, 60)').run('charted', 'soc', hour.toISOString());
    expect(series('charted', 'soc', ago(24 * 30), to)).toEqual([{ at: hour.toISOString(), value: 50 }]);
  });
});
