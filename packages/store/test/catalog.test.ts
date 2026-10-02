import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * The catalog, the connections and the links: what you have, how each is
 * reached, and how they fit the house (docs/DATA-MODEL.md §3). These cover the
 * lifecycle — add, rename, remove keeping history, bring back, delete for good
 * — and the rules the data model depends on: one device per identity, one
 * device per exclusive address, one `feeds` link per source part.
 *
 * On each SQLite a home is kept in (`drivers.ts`), each a database of its own.
 */

import { connectionId, MAIN_PART, nodeId, savedDeviceId, type DeviceDescription } from '@kraftverk/device-sdk';

import { ConnectionStore, DeviceCatalog, LastHeard, LinkStore, NodeStore, SendQueue, type SecretsAtRest, type SqlDatabase } from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

/** The node this database belongs to: what holds every connection here. */
const HERE = nodeId('n-0000000000a1');

/** A device's description, as a lamp's. */
const LAMP: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Lamp', kind: 'light', offers: ['switch'] }],
  attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'switch.on' }],
};

/** Secrets sealed so that what is kept is not what was given: a stand-in for the server's key. */
const SEALED: SecretsAtRest = {
  encrypted: true,
  seal: (value) => ({ value: `sealed:${btoa(value)}`, encrypted: true }),
  open: (stored, encrypted) => (encrypted ? atob(stored.slice('sealed:'.length)) : stored),
};

for (const driver of DRIVERS) {
  describe(driver.name, () => {
    let database: SqlDatabase;
    let catalog: DeviceCatalog;
    let connections: ConnectionStore;
    let links: LinkStore;

    beforeAll(async () => {
      database = await driver.open();
      new NodeStore(database).declareSelf({ id: HERE, name: 'Test machine', platform: 'system', transports: ['mqtt', 'ble', 'lan'], alwaysOn: true, reachable: true, trusted: true });
      catalog = new DeviceCatalog(database);
      connections = new ConnectionStore(database, SEALED);
      links = new LinkStore(database);
    });

    afterAll(() => database.close());

    const add = (name: string, identity: string | null = null) => catalog.add({ description: LAMP, typeId: 'test.station', name, identity });

    const sample = (id: string) =>
      database.query("INSERT INTO sample (device_id, part, key, at, value) VALUES (?, 'main', ?, ?, ?)").run(id, 'soc', new Date().toISOString(), 50);

    const samplesOf = (id: string) => database.query<{ n: number }, [string]>('SELECT COUNT(*) n FROM sample WHERE device_id = ?').get(id)!.n;

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
        expect(catalog.get(record.id)?.typeId).toBe('test.station');
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

      test('its key, its name in configuration: made from its name, one device to a key, changed only to a free one', () => {
        const first = add('Kitchen Plug');
        const second = add('Kitchen plug');
        expect([first.key, second.key]).toEqual(['kitchen-plug', 'kitchen-plug-2']);
        // Given, as a file gives it: kept as it is — but not one taken, nor one that is not a key.
        expect(catalog.add({ description: LAMP, typeId: 'test.station', name: 'Whatever', key: 'hall-lamp' }).key).toBe('hall-lamp');
        expect(() => catalog.add({ description: LAMP, typeId: 'test.station', name: 'Again', key: 'hall-lamp' })).toThrow('not a free key');
        expect(() => catalog.update(first.id, { key: 'Kitchen_Plug' })).toThrow('not a free key');
        expect(() => catalog.update(first.id, { key: 'kitchen-plug-2' })).toThrow('not a free key');
        expect(catalog.update(first.id, { key: 'counter-plug' })?.key).toBe('counter-plug');
        // A name changed leaves the key as it is: files that name it still do.
        expect(catalog.update(first.id, { name: 'Coffee' })?.key).toBe('counter-plug');
      });

      test('brought back, it has its key again — or one made from its name, when another has it since', () => {
        const gone = add('Porch light');
        catalog.remove(gone.id);
        add('Porch light');
        expect(catalog.restore(gone.id)?.key).toBe('porch-light-2');
      });
    });

    describe('removing a device', () => {
      test('keeps its history, and drops its connections, their secrets and its links', () => {
        const station = add('Doomed', 'sydpower:AABBCC000003');
        const plug = catalog.add({ description: LAMP, typeId: 'test.plug', name: 'Plug' });
        const connection = connections.add({ deviceId: station.id, method: 'wifi', transport: 'mqtt', heldBy: HERE, address: 'AABBCC000003' });
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
        const wifi = connections.add({ deviceId: record.id, method: 'wifi', transport: 'mqtt', heldBy: HERE, address: 'AABBCC000010' });
        const ble = connections.add({ deviceId: record.id, method: 'bluetooth', transport: 'ble', heldBy: HERE, address: 'AA:BB:CC:00:00:10' });
        expect([wifi.priority, ble.priority]).toEqual([0, 1]);

        connections.prefer(ble.id);
        expect(connections.forDevice(record.id).map((connection) => connection.method)).toEqual(['bluetooth', 'wifi']);
      });

      test('an exclusive address is claimed whatever its case', () => {
        const record = add('Claimed');
        connections.add({ deviceId: record.id, method: 'wifi', transport: 'mqtt', heldBy: HERE, address: 'AABBCC000011' });
        expect(connections.claimant('mqtt', 'aabbcc000011')?.deviceId).toBe(record.id);
        expect(connections.claimant('ble', 'AABBCC000011')).toBeNull();
      });

      test('secrets are sealed at rest, listed by field, and opened only on request', () => {
        const record = add('Keyed');
        const connection = connections.add({ deviceId: record.id, method: 'lan', transport: 'lan', heldBy: HERE, address: '192.0.2.10' });
        connections.setSecrets(connection.id, { localKey: 'abcdefghijklmnop' });

        expect(connections.secretFields(connection.id)).toEqual(['localKey']);
        expect(connections.secret(connection.id, 'localKey')).toBe('abcdefghijklmnop');
        const stored = database.query<{ value: string }, [string]>('SELECT value FROM connection_secret WHERE connection_id = ?').get(connection.id)!.value;
        expect(stored).not.toContain('abcdefghijklmnop');
      });
    });

    describe('links', () => {
      test('a source part feeds one thing: a second feeds link replaces the first', () => {
        const plug = catalog.add({ description: LAMP, typeId: 'test.plug', name: 'Feeder' });
        const first = add('First station');
        const second = add('Second station');
        links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: first.id, part: 'input.ac' } });
        links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: second.id, part: 'input.ac' } });

        expect(links.from(plug.id, 'main').map((link) => link.target)).toEqual([{ device: second.id, part: 'input.ac' }]);
        expect(links.forDevice(first.id)).toEqual([]);

        // Held by the database too: a write that goes around the store cannot give the plug a second.
        const around = database.query(
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
        const plug = catalog.add({ description: LAMP, typeId: 'test.plug', name: 'Loop' });
        expect(() => links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: plug.id, part: 'main' } })).toThrow();
      });
    });

    describe('a copy of another home’s device, held here', () => {
      const theirs = {
        id: savedDeviceId('d-0000000000aa'),
        key: 'their-lamp',
        typeId: 'test.lamp',
        identity: 'lamp:AA',
        name: 'Their lamp',
        placeId: null,
        config: {},
        addedAt: '2026-10-01T00:00:00.000Z',
        removedAt: null,
        description: LAMP,
        descriptionSource: 'type' as const,
        info: null,
        picture: null,
      };
      const way = { id: connectionId('c-0000000000aa'), deviceId: theirs.id, method: 'bluetooth', transport: 'ble', heldBy: HERE, address: 'AA', priority: 1, config: {}, secretsExportable: false, createdAt: theirs.addedAt };

      test('is kept by its own id, held here, and brought up to date without losing what only this holder has', () => {
        catalog.mirror(theirs);
        connections.mirror(way);
        connections.setSecrets(way.id, { key: 'only-here' });
        expect(catalog.get(theirs.id)).toMatchObject({ key: 'their-lamp', name: 'Their lamp', identity: 'lamp:AA' });
        expect(connections.forDevice(theirs.id)).toEqual([expect.objectContaining({ id: way.id, heldBy: HERE, priority: 1 })]);

        catalog.mirror({ ...theirs, name: 'Renamed there' });
        connections.mirror({ ...way, priority: 0, address: 'BB' });
        expect(catalog.get(theirs.id)?.name).toBe('Renamed there');
        expect(connections.get(way.id)).toMatchObject({ priority: 0, address: 'BB' });
        expect(connections.secret(way.id, 'key')).toBe('only-here');
      });
    });

    describe('what a server last said', () => {
      test('is kept by what was asked, each answer in place of the one before, with when it was heard', () => {
        const heard = new LastHeard(database);
        expect(heard.get('devices')).toBeNull();
        heard.keep('devices', [{ id: 'd-1' }], '2026-10-02T10:00:00.000Z');
        heard.keep('devices', [{ id: 'd-1' }, { id: 'd-2' }], '2026-10-02T10:05:00.000Z');
        expect(heard.get('devices')).toEqual({ body: [{ id: 'd-1' }, { id: 'd-2' }], heardAt: '2026-10-02T10:05:00.000Z' });
      });
    });

    describe('what is owed to a server', () => {
      test('is taken in the order it was owed, and gone once sent', () => {
        const queue = new SendQueue(database);
        queue.add('readings', 'd-1', { readings: [1] });
        queue.add('audit', null, { kind: 'device.command' });
        queue.add('readings', 'd-1', { readings: [2] });
        const owed = queue.next(10);
        expect(owed.map((each) => [each.kind, each.deviceId, each.body])).toEqual([
          ['readings', 'd-1', { readings: [1] }],
          ['audit', null, { kind: 'device.command' }],
          ['readings', 'd-1', { readings: [2] }],
        ]);
        queue.done([owed[0]!.id]);
        expect(queue.count()).toBe(2);
        // Only the newest of a kind are kept, past what a phone should carry.
        queue.trim('readings', 0);
        expect(queue.next(10).map((each) => each.kind)).toEqual(['audit']);
      });
    });
  });
}
