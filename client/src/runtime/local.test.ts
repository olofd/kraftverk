import { beforeEach, describe, expect, test } from 'bun:test';

import { clearPreference, readPreference, writePreference } from '../lib/preferences';
import { LocalCatalog, memorySecrets } from './local';

/*
  Local mode's catalog: the same records a server keeps — devices,
  connections, their secrets, links — in this app's own storage.
*/

beforeEach(() => clearPreference('kraftverk.local'));

const lamp = (catalog: LocalCatalog, options: { id?: string; method?: string; secrets?: Record<string, string> } = {}) =>
  catalog.save({
    device: { id: options.id, typeId: 'test.lamp', name: 'Hall lamp', identity: 'lampish:A', config: { room: 'Hall' } },
    connection: { method: options.method ?? 'ble', transport: 'ble', address: 'handle-1', config: {}, secrets: options.secrets ?? {} },
  });

describe('the local catalog', () => {
  test('keeps a device with its connection and secrets, across a restart', () => {
    const vault = memorySecrets();
    const device = lamp(new LocalCatalog(vault), { secrets: { pin: '1234' } });
    const again = new LocalCatalog(vault);
    expect(again.device(device.id)).toMatchObject({ name: 'Hall lamp', identity: 'lampish:A' });
    const [connection] = again.connections(device.id);
    expect(connection).toMatchObject({ method: 'ble', priority: 0 });
    expect(again.secrets(connection!.id)).toEqual({ pin: '1234' });
    expect(again.byIdentity('lampish:A')?.id).toBe(device.id);
  });

  test('a second way to reach the same device is a second connection, lower in the list — not a second device', () => {
    const catalog = new LocalCatalog();
    const device = lamp(catalog);
    lamp(catalog, { id: device.id, method: 'lan' });
    expect(catalog.devices()).toHaveLength(1);
    expect(catalog.connections(device.id).map((connection) => [connection.method, connection.priority])).toEqual([
      ['ble', 0],
      ['lan', 1],
    ]);
    expect(() => lamp(catalog, { id: device.id, method: 'lan' })).toThrow('already reached this way');
  });

  test('preferring a connection moves it to the top', () => {
    const catalog = new LocalCatalog();
    const device = lamp(catalog);
    lamp(catalog, { id: device.id, method: 'lan' });
    const lan = catalog.connections(device.id).find((connection) => connection.method === 'lan')!;
    catalog.prefer(lan.id);
    expect(catalog.connections(device.id)[0]!.method).toBe('lan');
  });

  test('changing a secret keeps the others', () => {
    const catalog = new LocalCatalog();
    const device = lamp(catalog, { secrets: { pin: '1234', key: 'abc' } });
    const [connection] = catalog.connections(device.id);
    catalog.setSecrets(connection!.id, { pin: '9999' });
    expect(catalog.secrets(connection!.id)).toEqual({ pin: '9999', key: 'abc' });
  });

  test('one feeds link per source part: a new one replaces the old', () => {
    const catalog = new LocalCatalog();
    catalog.save({
      device: { typeId: 'test.plug', name: 'Plug', identity: null, config: {} },
      connection: { method: 'lan', transport: 'lan', address: '192.0.2.5', config: {}, secrets: {} },
      links: [{ kind: 'feeds', part: 'main', other: { device: 'd-station-1', part: 'input.ac' }, role: 'source' }],
    });
    const plug = catalog.devices()[0]!;
    lamp(catalog, { id: plug.id, method: 'ble' });
    catalog.save({
      device: { id: plug.id, typeId: 'test.plug', name: 'Plug', identity: null, config: {} },
      connection: { method: 'usb', transport: 'usb', address: 'x', config: {}, secrets: {} },
      links: [{ kind: 'feeds', part: 'main', other: { device: 'd-station-2', part: 'input.ac' }, role: 'source' }],
    });
    expect(catalog.links(plug.id).map((link) => link.target)).toEqual([{ device: 'd-station-2', part: 'input.ac' }]);
  });

  test('links kept before they joined parts are set aside', () => {
    writePreference('kraftverk.local', JSON.stringify({ devices: [], connections: [], links: [{ id: 'l-1', kind: 'feeds', sourceId: 'd-1', targetId: 'd-2' }], stores: {} }));
    expect(new LocalCatalog().links()).toEqual([]);
  });

  test('secrets an older version kept in plaintext move into the vault, and leave the catalog', () => {
    writePreference('kraftverk.local', JSON.stringify({ devices: [], connections: [], links: [], stores: {}, secrets: { 'c-old': { localKey: 'plain' } } }));
    const vault = memorySecrets();
    new LocalCatalog(vault);
    expect(vault.get('c-old')).toEqual({ localKey: 'plain' });
    expect(readPreference('kraftverk.local')).not.toContain('plain');
  });

  test('removing a device takes its connections, secrets, links and store with it', () => {
    const catalog = new LocalCatalog();
    const device = lamp(catalog, { secrets: { pin: '1234' } });
    const [connection] = catalog.connections(device.id);
    catalog.setStore(device.id, 'baseline', [1, 2]);
    catalog.remove(device.id);
    expect(catalog.devices()).toEqual([]);
    expect(catalog.connections(device.id)).toEqual([]);
    expect(catalog.secrets(connection!.id)).toEqual({});
    expect(catalog.store(device.id)).toEqual({});
  });
});
