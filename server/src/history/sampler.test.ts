import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AttributeSpec, DeviceDescription, Reading } from '@kraftverk/device-sdk';

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

/** What a device reporting these readings is: an attribute each, typed by what it reports. */
const describedBy = (readings: Reading[], extra: AttributeSpec[] = []): DeviceDescription => ({
  attributes: [
    ...readings.map(
      (reading): AttributeSpec => ({
        key: reading.key,
        label: reading.key,
        value: typeof reading.value === 'boolean' ? { type: 'boolean' } : typeof reading.value === 'string' ? { type: 'string' } : { type: 'number' },
      })
    ),
    ...extra,
  ].filter((attribute, index, all) => all.findIndex((other) => other.key === attribute.key) === index),
});

/** A registry holding one device with the given readings, saved as history needs it to be. */
const registry = (id: string, readings: Reading[], description = describedBy(readings)) => {
  db()
    .query("INSERT OR IGNORE INTO device (id, name, config, description, added_at, type_id) VALUES (?, ?, '{}', ?, ?, 'test.device')")
    .run(id, id, JSON.stringify(description), new Date().toISOString());
  return { all: async () => [{ id, readings, description }] } as unknown as DeviceRegistry;
};

const stored = (id: string) =>
  db().query('SELECT key, value FROM sample WHERE device_id = ? ORDER BY key').all(id) as { key: string; value: number }[];
const storedText = (id: string) =>
  db().query('SELECT key, text FROM sample WHERE device_id = ? AND text IS NOT NULL ORDER BY key').all(id) as { key: string; text: string }[];

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

  test('an operating mode is kept as text; a setting and a string are not kept at all unless asked', async () => {
    const at = new Date().toISOString();
    const readings: Reading[] = [
      { key: 'state', value: 'charging', at },
      { key: 'limit', value: 90, at },
      { key: 'serial', value: 'AB12', at },
    ];
    const description: DeviceDescription = {
      attributes: [
        { key: 'state', label: 'Doing', value: { type: 'enum', options: [{ value: 'charging', label: 'Charging' }] } },
        { key: 'limit', label: 'Limit', value: { type: 'number' }, access: 'write', category: 'config' },
        { key: 'serial', label: 'Serial', value: { type: 'string' } },
      ],
    };
    await new Sampler(registry('modes', readings, description)).sample();
    expect(storedText('modes')).toEqual([{ key: 'state', text: 'charging' }]);
    expect(stored('modes').map((row) => row.key)).toEqual(['state']);
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

  /*
    A forecast is fetched every half hour, and its value stays current for an
    hour: sampled every minute in between, not only in the two minutes after
    each fetch — which is what one global freshness rule did to weather history.
  */
  test('a value is kept as long as its attribute says it stays current', async () => {
    const fetched = new Date(Date.now() - 40 * 60_000).toISOString();
    const description: DeviceDescription = {
      attributes: [
        { key: 'temperature', label: 'Temperature', value: { type: 'number', unit: '°C' }, means: 'temperature.air', currentFor: 60 * 60_000 },
        { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' } },
      ],
    };
    await new Sampler(registry('forecast', [{ key: 'temperature', value: 12.5, at: fetched }, { key: 'watts', value: 40, at: fetched }], description)).sample();
    expect(stored('forecast')).toEqual([{ key: 'temperature', value: 12.5 }]);
  });

  test('each sample says which part it belongs to', async () => {
    const at = new Date().toISOString();
    const description: DeviceDescription = {
      parts: [{ id: 'pack.1', label: 'Pack 1', kind: 'battery' }],
      attributes: [
        { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%' } },
        { key: 'pack.1.soc', part: 'pack.1', label: 'Pack 1 charge', value: { type: 'number', unit: '%' } },
      ],
    };
    await new Sampler(registry('packs', [{ key: 'soc', value: 80, at }, { key: 'pack.1.soc', value: 60, at }], description)).sample();
    expect(db().query('SELECT part, key FROM sample WHERE device_id = ? ORDER BY key').all('packs')).toEqual([
      { part: 'pack.1', key: 'pack.1.soc' },
      { part: 'main', key: 'soc' },
    ]);
  });
});

describe('history that lasts', () => {
  const put = (id: string, at: Date, value: number) => db().query("INSERT OR REPLACE INTO sample (device_id, part, key, at, value) VALUES (?, 'main', ?, ?, ?)").run(id, 'soc', at.toISOString(), value);
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
    db().query("INSERT INTO sample_hour (device_id, part, key, hour, min, avg, max, n) VALUES ('kept', 'main', 'soc', '2020-01-01T00:00:00.000Z', 1, 1, 1, 1)").run();
    new Sampler(registry('kept', [])).prune(now);
    expect(stored('kept')).toEqual([]);
    expect(hours('kept').map((row) => [row.hour.slice(0, 10), row.avg])).toEqual([[old.toISOString().slice(0, 10), 42]]);
  });

  test('events a device raised are kept a year, like the audit', () => {
    registry('eventful', []);
    const now = Date.UTC(2026, 8, 28, 12, 0);
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const raise = (when: string) =>
      db().query("INSERT INTO device_event (device_id, part, event, level, data, at) VALUES ('eventful', 'main', 'tripped', 'warn', NULL, ?)").run(when);
    raise(at(400));
    raise(at(30));
    new Sampler(registry('eventful', [])).prune(now);
    const left = db().query("SELECT at FROM device_event WHERE device_id = 'eventful'").all() as { at: string }[];
    expect(left.map((row) => row.at)).toEqual([at(30)]);
  });

  test('a long span is drawn from the hours, a short one from the minutes', () => {
    const now = Date.now();
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const to = new Date(now).toISOString();
    expect(resolutionOf(ago(24), to)).toBe('minute');
    expect(resolutionOf(ago(24 * 30), to)).toBe('hour');

    registry('charted', []);
    const hour = new Date(Math.floor((now - 10 * 86_400_000) / 3_600_000) * 3_600_000);
    db().query("INSERT INTO sample_hour (device_id, part, key, hour, min, avg, max, n) VALUES (?, 'main', ?, ?, 1, 50, 99, 60)").run('charted', 'soc', hour.toISOString());
    expect(series('charted', 'soc', ago(24 * 30), to)).toEqual([{ at: hour.toISOString(), value: 50 }]);
  });
});
