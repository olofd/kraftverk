import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Reading } from '@kraftverk/plugin-sdk';

import { closeDb, db } from './db.ts';
import { Sampler } from './sampler.ts';
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

/** A registry holding one device with the given readings. */
const registry = (id: string, readings: Reading[]) =>
  ({ all: async () => [{ id, readings }] }) as unknown as DeviceRegistry;

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
