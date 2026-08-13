import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The catalog is what makes a device *yours*: it exists because you added it,
 * and it keeps existing when the thing itself stops answering. These cover the
 * lifecycle the device-first refactor depends on — add, rename, re-model,
 * forget — and the one destructive part, which takes the history with it.
 *
 * The database is a throwaway. Running these against `server/data` would put
 * test devices in the owner's own list.
 */

import { DeviceCatalog } from './catalog.ts';
import { closeDb, db } from '../history/db.ts';

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-catalog-'));
let catalog: DeviceCatalog;

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  catalog = new DeviceCatalog();
});

afterAll(() => {
  closeDb();
  delete process.env.KRAFTVERK_DB;
  rmSync(dir, { recursive: true, force: true });
});

const add = (name: string) =>
  catalog.add({ type: 'power-station', model: 'aferiy-p280', driver: 'core.station', name });

describe('the device catalog', () => {
  test('starts empty, because nothing is adopted', () => {
    expect(catalog.list()).toEqual([]);
  });

  test('remembers what was added, and hands back the same record', () => {
    const record = add('Living room');

    expect(record.id).toStartWith('power-station:');
    expect(catalog.get(record.id)).toEqual(record);
    expect(catalog.list().map((entry) => entry.id)).toEqual([record.id]);
  });

  test('renaming changes only the label', () => {
    const record = add('Before');
    const updated = catalog.update(record.id, { name: '  After  ' });

    expect(updated?.name).toBe('After');
    expect(updated?.model).toBe(record.model);
    expect(catalog.get(record.id)?.name).toBe('After');
  });

  test('an empty rename is refused rather than blanking the name', () => {
    const record = add('Keep me');
    expect(catalog.update(record.id, { name: '   ' })?.name).toBe('Keep me');
  });

  test('the model can be corrected, including back to unknown', () => {
    const record = add('Mystery');

    expect(catalog.update(record.id, { model: 'fossibot-f2400' })?.model).toBe('fossibot-f2400');
    expect(catalog.update(record.id, { model: null })?.model).toBeNull();
    // Absent is not the same as null: it must leave the model alone.
    expect(catalog.update(record.id, { name: 'Mystery' })?.model).toBeNull();
  });

  test('config is merged, so one key does not erase the rest', () => {
    const record = catalog.add({
      type: 'power-station',
      driver: 'core.station',
      name: 'Merged',
      config: { transport: 'ble', boundId: 'AA:BB' },
    });

    expect(catalog.update(record.id, { config: { boundId: 'CC:DD' } })?.config).toEqual({
      transport: 'ble',
      boundId: 'CC:DD',
    });
  });

  test('updating something that is not there says so', () => {
    expect(catalog.update('power-station:nope', { name: 'x' })).toBeNull();
    expect(catalog.get('power-station:nope')).toBeNull();
  });

  test('forgetting a device takes its samples with it', () => {
    const record = add('Doomed');
    const other = add('Spared');

    for (const id of [record.id, other.id]) {
      db()
        .query('INSERT INTO sample (device_id, key, at, value) VALUES (?, ?, ?, ?)')
        .run(id, 'soc', new Date().toISOString(), 50);
    }

    catalog.remove(record.id);

    expect(catalog.get(record.id)).toBeNull();
    const left = db()
      .query<{ device_id: string }, []>('SELECT device_id FROM sample')
      .all()
      .map((row) => row.device_id);
    expect(left).toEqual([other.id]);
  });
});
