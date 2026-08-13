import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Binding } from '../binding.ts';
import { DeviceCatalog } from './catalog.ts';
import { LegacyStationImport } from './legacy.ts';
import { closeDb, db } from '../history/db.ts';

/**
 * The only thing that survives the end of automatic adoption.
 *
 * The server used to insert a station at startup because one was answering.
 * These tests hold the replacement to a stricter standard: it is *offered*, not
 * taken; it is offered only when the server can actually operate the thing it
 * would create; and whichever way the user answers, it stops asking.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-legacy-'));

const BOUND: Binding = { kind: 'ble', id: 'AA:BB:CC:DD:EE:FF', boundAt: '2026-01-01T00:00:00.000Z' };

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
});

afterAll(() => {
  closeDb();
  delete process.env.KRAFTVERK_DB;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db().exec('DELETE FROM device; DELETE FROM sample; DELETE FROM app_state; DELETE FROM audit');
});

function subject(options: { transport?: 'ble' | 'mqtt' | null; binding?: Binding | null } = {}) {
  const catalog = new DeviceCatalog();
  const importer = new LegacyStationImport({
    catalog,
    transport: () => (options.transport === undefined ? 'ble' : options.transport),
    stationName: () => 'POWER-1234',
    binding: async () => (options.binding === undefined ? BOUND : options.binding),
  });
  return { catalog, importer };
}

describe('the legacy station import', () => {
  test('offers the binding when the server runs that transport', async () => {
    const { importer } = subject();

    expect(await importer.offer()).toEqual({
      state: 'offered',
      transport: 'ble',
      boundId: BOUND.id,
      boundAt: BOUND.boundAt,
      name: 'POWER-1234',
    });
  });

  test('offers nothing when there is no binding to import', async () => {
    const { importer } = subject({ binding: null });
    expect((await importer.offer()).state).toBe('none');
  });

  /*
    The rule that keeps this honest. A BLE binding while the simulator answers
    would create a device claiming a Bluetooth station, with simulated numbers
    behind it — a record the server cannot operate.
  */
  test('offers nothing when the running transport does not match the binding', async () => {
    expect((await subject({ transport: null }).importer.offer()).state).toBe('none');
    expect((await subject({ transport: 'mqtt' }).importer.offer()).state).toBe('none');
  });

  test('offers nothing once a station is already in the catalog', async () => {
    const { catalog, importer } = subject();
    catalog.add({ type: 'power-station', driver: 'core.station', name: 'Already mine' });

    expect((await importer.offer()).state).toBe('none');
  });

  test('accepting creates one station, carrying the binding forward', async () => {
    const { catalog, importer } = subject();
    const record = await importer.accept();

    expect(record).not.toBeNull();
    expect(record?.type).toBe('power-station');
    expect(record?.driver).toBe('core.station');
    expect(record?.name).toBe('POWER-1234');
    expect(record?.config).toEqual({ transport: 'ble', boundId: BOUND.id });
    expect(catalog.list()).toHaveLength(1);
  });

  test('accepting takes a name the user chose', async () => {
    const { importer } = subject();
    expect((await importer.accept('  Hallway station '))?.name).toBe('Hallway station');
  });

  test('accepting twice does not create a second station', async () => {
    const { catalog, importer } = subject();
    await importer.accept();

    expect(await importer.accept()).toBeNull();
    expect(catalog.list()).toHaveLength(1);
    expect((await importer.offer()).state).toBe('imported');
  });

  test('accepting is recorded, because it creates a device the user owns', async () => {
    const { importer } = subject();
    const record = await importer.accept();

    const entry = db()
      .query<{ kind: string; resource: string }, []>('SELECT kind, resource FROM audit')
      .get();
    expect(entry?.kind).toBe('device.imported');
    expect(entry?.resource).toBe(record!.id);
  });

  test('dismissing it stops the offer for good', async () => {
    const { catalog, importer } = subject();
    importer.dismiss();

    expect((await importer.offer()).state).toBe('dismissed');
    // A dismissed offer cannot be taken by calling the route directly either.
    expect(await importer.accept()).toBeNull();
    expect(catalog.list()).toEqual([]);
  });

  test('a decision survives a restart, since the banner must not come back', async () => {
    subject().importer.dismiss();

    // A fresh instance, as a restarted server would build.
    expect((await subject().importer.offer()).state).toBe('dismissed');
  });
});
