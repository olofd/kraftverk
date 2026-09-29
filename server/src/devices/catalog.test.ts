import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The catalog, the connections and the links: what you have, how each is
 * reached, and how they fit the house (docs/DATA-MODEL.md §3). These cover the
 * lifecycle — add, rename, remove keeping history, bring back, delete for good
 * — and the rules the data model depends on: one device per identity, one
 * device per exclusive address, one `feeds` link per source part.
 *
 * The database is a throwaway. Running these against `server/data` would put
 * test devices in the owner's own list.
 */

import { savedDeviceId } from '@kraftverk/device-sdk';

import { closeDb, db } from '../history/db.ts';
import { DeviceCatalog } from './catalog.ts';
import { ConnectionStore } from './connections.ts';
import { LinkStore } from './links.ts';
import { LAMP } from './testing.ts';

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-catalog-'));
let catalog: DeviceCatalog;
let connections: ConnectionStore;
let links: LinkStore;

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  catalog = new DeviceCatalog();
  connections = new ConnectionStore();
  links = new LinkStore();
});

afterAll(() => {
  closeDb();
  // `KRAFTVERK_DB` is deliberately left set: bun shares one process across
  // test files, and clearing it here let a later file reopen the real
  // database and delete from it. See the guard in `history/db.ts`.
  rmSync(dir, { recursive: true, force: true });
});

const add = (name: string, identity: string | null = null) => catalog.add({ description: LAMP, typeId: 'aferiy.p280', name, identity });

const sample = (id: string) =>
  db().query("INSERT INTO sample (device_id, part, key, at, value) VALUES (?, 'main', ?, ?, ?)").run(id, 'soc', new Date().toISOString(), 50);

const samplesOf = (id: string) => db().query<{ n: number }, [string]>('SELECT COUNT(*) n FROM sample WHERE device_id = ?').get(id)!.n;

describe('the device catalog', () => {
  test('starts empty, because nothing is adopted', () => {
    expect(catalog.list()).toEqual([]);
  });

  test('remembers what was added, and hands back the same record', () => {
    const record = add('Living room');

    // Opaque: an id that said what a device is would invite code that reads it.
    expect(record.id).toMatch(/^d-[0-9a-f]{12}$/);
    expect(catalog.get(record.id)).toEqual(record);
    expect(catalog.list().map((entry) => entry.id)).toContain(record.id);
  });

  test('knows whose word its description is: its type’s when added, its own once it says more', () => {
    const record = add('Station');
    expect(record.descriptionSource).toBe('type');
    const own = { ...record.description, attributes: [...record.description.attributes, { key: 'pack.1.soc', label: 'Pack 1', value: { type: 'number' as const, unit: '%' } }] };
    expect(catalog.describe(record.id, own, null, 'device')).toBe(true);
    expect(catalog.get(record.id)).toMatchObject({ descriptionSource: 'device', description: own });
  });

  test('renaming changes only the label, and an empty rename is refused', () => {
    const record = add('Before');
    expect(catalog.update(record.id, { name: '  After  ' })?.name).toBe('After');
    expect(catalog.update(record.id, { name: '   ' })?.name).toBe('After');
    expect(catalog.get(record.id)?.typeId).toBe('aferiy.p280');
  });

  test('updating something that is not there says so', () => {
    expect(catalog.update(savedDeviceId('d-nope'), { name: 'x' })).toBeNull();
    expect(catalog.get(savedDeviceId('d-nope'))).toBeNull();
  });

  test('a device is found by its identity', () => {
    const record = add('Garage', 'sydpower:AABBCC000001');
    expect(catalog.byIdentity('sydpower:AABBCC000001').active?.id).toBe(record.id);
    expect(catalog.byIdentity('sydpower:FFFFFF000000')).toEqual({ active: null, removed: [] });
  });

  test('two devices you have cannot share an identity', () => {
    add('One', 'sydpower:AABBCC000002');
    expect(() => add('Two', 'sydpower:AABBCC000002')).toThrow();
  });
});

describe('removing a device', () => {
  test('keeps its history, and drops its connections, their secrets and its links', () => {
    const station = add('Doomed', 'sydpower:AABBCC000003');
    const plug = catalog.add({ description: LAMP, typeId: 'atorch.s1w', name: 'Plug' });
    const connection = connections.add({ deviceId: station.id, method: 'wifi', transport: 'mqtt', heldBy: null, address: 'AABBCC000003' });
    connections.setSecrets(connection.id, { localKey: 'k' });
    links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: station.id, part: 'input.ac' } });
    sample(station.id);

    catalog.remove(station.id);

    expect(catalog.active(station.id)).toBeNull();
    expect(catalog.get(station.id)?.removedAt).not.toBeNull();
    expect(catalog.list().map((record) => record.id)).not.toContain(station.id);
    expect(catalog.removed().map((record) => record.id)).toContain(station.id);
    expect(samplesOf(station.id)).toBe(1);
    expect(connections.forDevice(station.id)).toEqual([]);
    expect(connections.secretFields(connection.id)).toEqual([]);
    expect(links.forDevice(plug.id)).toEqual([]);
    // Its address is free for something else.
    expect(connections.claimant('mqtt', 'AABBCC000003')).toBeNull();
  });

  test('frees its identity, and can be brought back with its history', () => {
    const record = add('Returning', 'sydpower:AABBCC000004');
    sample(record.id);
    catalog.remove(record.id);

    expect(catalog.byIdentity('sydpower:AABBCC000004')).toEqual({ active: null, removed: [expect.objectContaining({ id: record.id })] });
    expect(catalog.restore(record.id)?.removedAt).toBeNull();
    expect(catalog.active(record.id)?.name).toBe('Returning');
    expect(samplesOf(record.id)).toBe(1);
  });

  test('is not brought back over one you already have with the same identity', () => {
    const old = add('Old', 'sydpower:AABBCC000005');
    catalog.remove(old.id);
    add('New', 'sydpower:AABBCC000005');
    expect(() => catalog.restore(old.id)).toThrow('You already have that device');
  });

  test('deleting its history takes the samples, and nobody else’s', () => {
    const doomed = add('Doomed for good');
    const spared = add('Spared');
    sample(doomed.id);
    sample(spared.id);
    catalog.remove(doomed.id);

    expect(catalog.deleteForever(doomed.id)).toEqual({ samples: 1 });
    expect(catalog.get(doomed.id)).toBeNull();
    expect(samplesOf(spared.id)).toBe(1);
  });
});

describe('connections', () => {
  test('a new one comes after the ones a device already has, and can be preferred', () => {
    const record = add('Two ways');
    const wifi = connections.add({ deviceId: record.id, method: 'wifi', transport: 'mqtt', heldBy: null, address: 'AABBCC000010' });
    const ble = connections.add({ deviceId: record.id, method: 'bluetooth', transport: 'ble', heldBy: null, address: 'AA:BB:CC:00:00:10' });
    expect([wifi.priority, ble.priority]).toEqual([0, 1]);

    connections.prefer(ble.id);
    expect(connections.forDevice(record.id).map((connection) => connection.method)).toEqual(['bluetooth', 'wifi']);
  });

  test('an exclusive address is claimed whatever its case', () => {
    const record = add('Claimed');
    connections.add({ deviceId: record.id, method: 'wifi', transport: 'mqtt', heldBy: null, address: 'AABBCC000011' });
    expect(connections.claimant('mqtt', 'aabbcc000011')?.deviceId).toBe(record.id);
    expect(connections.claimant('ble', 'AABBCC000011')).toBeNull();
  });

  test('secrets are sealed at rest, listed by field, and opened only on request', () => {
    const record = add('Keyed');
    const connection = connections.add({ deviceId: record.id, method: 'lan', transport: 'lan', heldBy: null, address: '192.0.2.10' });
    connections.setSecrets(connection.id, { localKey: 'abcdefghijklmnop' });

    expect(connections.secretFields(connection.id)).toEqual(['localKey']);
    expect(connections.secret(connection.id, 'localKey')).toBe('abcdefghijklmnop');
    const stored = db().query<{ value: string }, [string]>('SELECT value FROM connection_secret WHERE connection_id = ?').get(connection.id)!.value;
    if (process.env.KRAFTVERK_SECRET_KEY) expect(stored).not.toContain('abcdefghijklmnop');
  });
});

describe('links', () => {
  test('a source part feeds one thing: a second feeds link replaces the first', () => {
    const plug = catalog.add({ description: LAMP, typeId: 'atorch.s1w', name: 'Feeder' });
    const first = add('First station');
    const second = add('Second station');
    links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: first.id, part: 'input.ac' } });
    links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: second.id, part: 'input.ac' } });

    expect(links.from(plug.id, 'main').map((link) => link.target)).toEqual([{ device: second.id, part: 'input.ac' }]);
    expect(links.forDevice(first.id)).toEqual([]);

    // Held by the database too: a write that goes around the store cannot give the plug a second.
    const around = db().query(
      "INSERT INTO device_link (id, kind, source_device, source_part, target_device, target_part, one_per_source, created_at) VALUES ('l-around', 'feeds', ?, 'main', ?, 'input.ac', 1, '2026-09-29T00:00:00Z')"
    );
    expect(() => around.run(plug.id, first.id)).toThrow(/UNIQUE/);
  });

  test('each part of a device is a source of its own', () => {
    const station = add('Station with outlets');
    const one = add('One');
    const two = add('Two');
    links.add({ kind: 'feeds', source: { device: station.id, part: 'outlet.ac' }, target: { device: one.id, part: 'input.ac' } });
    links.add({ kind: 'feeds', source: { device: station.id, part: 'outlet.dc' }, target: { device: two.id, part: 'input.ac' } });
    expect(links.from(station.id, 'outlet.ac').map((link) => link.target.device)).toEqual([one.id]);
    expect(links.from(station.id, 'outlet.dc').map((link) => link.target.device)).toEqual([two.id]);
    expect(links.from(station.id, 'main')).toEqual([]);
  });

  test('a device cannot feed itself', () => {
    const plug = catalog.add({ description: LAMP, typeId: 'atorch.s1w', name: 'Loop' });
    expect(() => links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: plug.id, part: 'main' } })).toThrow();
  });
});
