import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeviceDescriptor, PluginHealth, Reading } from '@kraftverk/plugin-sdk';
import type { StationStatus } from '@kraftverk/protocol';

import { providerDeviceId } from '@kraftverk/plugin-sdk';

import { DeviceCatalog } from './catalog.ts';
import { DeviceRegistry } from './registry.ts';
import type { ConnectionManager } from '../connections/manager.ts';
import type { PluginHost } from '../plugins/host.ts';
import { closeDb, db } from '../history/db.ts';

/**
 * What the catalog says, joined to what is actually answering.
 *
 * Two things are being pinned down here. The first is that a saved device's
 * `id` is the catalog's and nothing else ever overwrites it — the registry used
 * to spread a descriptor whose `id` was the *vendor's* over the top, which
 * works only while one adapter provides exactly one device. The second is that
 * "not answering" is not one state: an uninstalled driver, a refused radio and
 * an unplugged station want three different sentences, and a boolean could
 * carry none of them.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-registry-'));

const NOW = '2026-08-21T10:00:00.000Z';
const EARLIER = '2026-08-21T09:00:00.000Z';

/** Only the fields the registry actually reads. */
const stationStatus = (
  over: Omit<Partial<StationStatus>, 'link'> & { link?: Partial<StationStatus['link']> }
) =>
  ({
    name: 'POWER-1234',
    model: 'AFERIY P280',
    lastUpdated: NOW,
    level: 82,
    totalInputWatts: 0,
    totalOutputWatts: 120,
    solarInputWatts: 0,
    acInputWatts: 0,
    acInputVolts: 0,
    acOutputVolts: 230,
    minutesRemaining: 300,
    minutesToFull: 0,
    gridConnected: false,
    ports: [
      { id: 'ac', label: 'AC', enabled: true, watts: 120 },
      { id: 'dc', label: 'DC', enabled: false, watts: 0 },
      { id: 'usb', label: 'USB', enabled: false, watts: 0 },
    ],
    ...over,
    link: {
      mode: 'device',
      state: 'connected',
      transport: 'ble',
      mac: 'AA:BB:CC:DD:EE:FF',
      lastSeen: NOW,
      ...over.link,
    },
  }) as unknown as StationStatus;

/** A manager holding whatever the test says it holds, and nothing more. */
const managerWith = (sessions: Record<string, StationStatus>, refusals: Record<string, string> = {}) =>
  ({
    get: (deviceId: string) =>
      sessions[deviceId]
        ? { deviceId, kind: 'ble', driver: { status: () => sessions[deviceId] }, device: null, transport: null }
        : null,
    refusal: (deviceId: string) => refusals[deviceId] ?? null,
  }) as unknown as ConnectionManager;

type Plugin = {
  descriptor?: DeviceDescriptor;
  health: PluginHealth;
  readings?: Reading[];
  /** Every id `readDevice` was called with, so the wrong one is visible. */
  asked: string[];
  /** Never resolves, like an adapter waiting on a socket nobody will answer. */
  hangs?: boolean;
};

const hostWith = (plugins: Record<string, Plugin>) =>
  ({
    instance: (id: string) => {
      const plugin = plugins[id];
      if (!plugin) return undefined;
      return {
        manifest: { id },
        plugin: {
          devices: () => (plugin.descriptor ? [plugin.descriptor] : []),
          readDevice: async (deviceId: string) => {
            plugin.asked.push(deviceId);
            if (plugin.hangs) return new Promise<Reading[]>(() => {});
            return plugin.readings ?? [];
          },
        },
      };
    },
    health: (id: string) => plugins[id]!.health,
  }) as unknown as PluginHost;

const plugDescriptor = (over: Partial<DeviceDescriptor> = {}): DeviceDescriptor => ({
  id: 'tuya:bf8dc9aabbcc',
  name: 'Smart Socket',
  kind: 'smart-plug',
  icon: 'power',
  measurements: [{ key: 'watts', label: 'Power', unit: 'W', kind: 'power', primary: true }],
  controls: [],
  ...over,
});

let catalog: DeviceCatalog;

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  catalog = new DeviceCatalog();
});

afterAll(() => {
  closeDb();
  // `KRAFTVERK_DB` is deliberately left set: bun shares one process across
  // test files, and clearing it here let a later file reopen the real
  // database and delete from it. See the guard in `history/db.ts`.
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db().exec('DELETE FROM device; DELETE FROM sample');
});

const station = (name = 'Living room', config: Record<string, unknown> = {}) =>
  catalog.add({ type: 'power-station', model: 'aferiy-p280', driver: 'core.station', name, config });

const plug = (driver: string, name = 'Utility room') =>
  catalog.add({ type: 'smart-plug', driver, name });

describe('a saved device and the two identities it carries', () => {
  test('the catalog id survives the descriptor, and the vendor id is its own field', async () => {
    const record = plug('com.tuya.local-relay');
    const plugin: Plugin = {
      descriptor: plugDescriptor(),
      health: { status: 'healthy' },
      readings: [{ key: 'watts', value: 240, at: NOW }],
      asked: [],
    };
    const registry = new DeviceRegistry(catalog, hostWith({ 'com.tuya.local-relay': plugin }), managerWith({}));

    const view = (await registry.find(record.id))!;

    expect(view.id).toBe(record.id);
    expect(view.id).not.toBe(providerDeviceId('tuya:bf8dc9aabbcc'));
    expect(view.providerDeviceId).toBe(providerDeviceId('tuya:bf8dc9aabbcc'));
  });

  test('the adapter is asked using its own id, never the catalog id', async () => {
    const record = plug('com.tuya.local-relay');
    const plugin: Plugin = {
      descriptor: plugDescriptor(),
      health: { status: 'healthy' },
      readings: [{ key: 'watts', value: 12, at: NOW }],
      asked: [],
    };
    const registry = new DeviceRegistry(catalog, hostWith({ 'com.tuya.local-relay': plugin }), managerWith({}));

    await registry.find(record.id);

    expect(plugin.asked).toEqual([providerDeviceId('tuya:bf8dc9aabbcc')]);
    expect(plugin.asked).not.toContain(record.id);
  });

  test('the user’s name wins, and the vendor’s is kept beside it', async () => {
    const record = plug('com.tuya.local-relay', 'Freezer');
    const registry = new DeviceRegistry(
      catalog,
      hostWith({
        'com.tuya.local-relay': { descriptor: plugDescriptor(), health: { status: 'healthy' }, asked: [] },
      }),
      managerWith({})
    );

    const view = (await registry.find(record.id))!;

    expect(view.name).toBe('Freezer');
    expect(view.providerName).toBe('Smart Socket');
  });

  test('an identical vendor name is dropped rather than shown twice', async () => {
    const record = plug('com.tuya.local-relay', 'Smart Socket');
    const registry = new DeviceRegistry(
      catalog,
      hostWith({
        'com.tuya.local-relay': { descriptor: plugDescriptor(), health: { status: 'healthy' }, asked: [] },
      }),
      managerWith({})
    );

    expect((await registry.find(record.id))!.providerName).toBeNull();
  });
});

describe('connection health, which is not a boolean', () => {
  test('an uninstalled driver is unconfigured, not offline', async () => {
    const record = plug('com.nobody.missing');
    const registry = new DeviceRegistry(catalog, hostWith({}), managerWith({}));

    const view = (await registry.find(record.id))!;

    expect(view.health.status).toBe('unconfigured');
    expect(view.health.detail).toContain('com.nobody.missing');
  });

  test('a healthy driver with nothing at the other end is offline, not connected', async () => {
    const record = plug('com.tuya.local-relay');
    const registry = new DeviceRegistry(
      catalog,
      hostWith({
        'com.tuya.local-relay': {
          descriptor: plugDescriptor(),
          health: { status: 'healthy', detail: 'No datapoints since 09:00' },
          readings: [{ key: 'watts', value: null, at: NOW }],
          asked: [],
        },
      }),
      managerWith({})
    );

    const view = (await registry.find(record.id))!;

    expect(view.health.status).toBe('offline');
    expect(view.health.detail).toBe('No datapoints since 09:00');
    expect(view.health.lastReadingAt).toBeNull();
  });

  test('a failed driver is an error, because someone has to act on it', async () => {
    const record = plug('com.tuya.local-relay');
    const registry = new DeviceRegistry(
      catalog,
      hostWith({
        'com.tuya.local-relay': {
          descriptor: plugDescriptor(),
          health: { status: 'failed', detail: 'The local key was refused' },
          asked: [],
        },
      }),
      managerWith({})
    );

    expect((await registry.find(record.id))!.health).toMatchObject({
      status: 'error',
      detail: 'The local key was refused',
    });
  });

  test('a station the server is refusing to open says why, as an error', async () => {
    const record = station();
    const refusal = 'The server holds one Bluetooth station at a time, and another is already open';
    const registry = new DeviceRegistry(catalog, hostWith({}), managerWith({}, { [record.id]: refusal }));

    const view = (await registry.find(record.id))!;

    expect(view.health.status).toBe('error');
    expect(view.health.detail).toBe(refusal);
  });

  test('a station with no session and no refusal is simply quiet', async () => {
    const record = station();
    const registry = new DeviceRegistry(catalog, hostWith({}), managerWith({}));

    const view = (await registry.find(record.id))!;

    expect(view.health.status).toBe('offline');
    expect(view.health.detail).toBe('The server is not holding a link to it');
    // Still yours, still named, still in the list — the point of a catalog.
    expect(view.name).toBe('Living room');
    expect(view.readings).toEqual([]);
  });

  test('a station that has not been found yet is connecting, not offline', async () => {
    const record = station();
    const registry = new DeviceRegistry(
      catalog,
      hostWith({}),
      managerWith({ [record.id]: stationStatus({ link: { state: 'waiting', mac: null, lastSeen: EARLIER } }) })
    );

    const view = (await registry.find(record.id))!;

    expect(view.health.status).toBe('connecting');
    expect(view.health.lastReadingAt).toBe(EARLIER);
  });

  test('a connected station reports its transport, its MAC and when it last spoke', async () => {
    const record = station();
    const registry = new DeviceRegistry(
      catalog,
      hostWith({}),
      managerWith({ [record.id]: stationStatus({}) })
    );

    const view = (await registry.find(record.id))!;

    expect(view.health).toMatchObject({
      status: 'connected',
      owner: 'server',
      transport: 'ble',
      lastReadingAt: NOW,
    });
    expect(view.providerDeviceId).toBe(providerDeviceId('AA:BB:CC:DD:EE:FF'));
    expect(view.readings.find((reading) => reading.key === 'soc')?.value).toBe(82);
  });

  test('the simulator says so, rather than claiming a radio it does not have', async () => {
    const record = station();
    const registry = new DeviceRegistry(
      catalog,
      hostWith({}),
      managerWith({ [record.id]: stationStatus({ link: { mode: 'simulator', state: 'offline' } }) })
    );

    expect((await registry.find(record.id))!.health).toMatchObject({
      status: 'connected',
      transport: 'sim',
      detail: 'Simulated',
    });
  });

  test('a station with no live link falls back to the id it was bound to', async () => {
    const record = station('Van', { boundId: 'AA:BB:CC:00:11:22' });
    const registry = new DeviceRegistry(catalog, hostWith({}), managerWith({}));

    expect((await registry.find(record.id))!.providerDeviceId).toBe(providerDeviceId('AA:BB:CC:00:11:22'));
  });
});

/*
  `all()` is on the path of every GET /api/devices, which the app polls
  continuously, and of every sampler round. An extension that never answers
  must not be able to take the catalog down with it.
*/
describe('one badly behaved adapter', () => {
  test('cannot hang the whole device list', async () => {
    const stuck = plug('com.slow.adapter', 'Stuck');
    const fine = station('Living room');

    const registry = new DeviceRegistry(
      catalog,
      hostWith({
        'com.slow.adapter': {
          descriptor: plugDescriptor(),
          health: { status: 'healthy' },
          hangs: true,
          asked: [],
        },
      }),
      managerWith({ [fine.id]: stationStatus({}) })
    );

    const views = await registry.all();

    expect(views).toHaveLength(2);
    expect(views.find((v) => v.id === stuck.id)!.health.status).toBe('offline');
    // The station beside it is unaffected, which is the point.
    expect(views.find((v) => v.id === fine.id)!.health.status).toBe('connected');
  }, 10_000);
});
