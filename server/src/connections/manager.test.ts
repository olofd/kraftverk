import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DiscoveredDevice, ParsedFrame } from '@kraftverk/protocol';

import { ConnectionManager, type LinkKind } from './manager.ts';
import { DeviceCatalog, type DeviceRecord } from '../devices/catalog.ts';
import type { StationDriver } from '../drivers/types.ts';
import type { Transport } from '../transport/types.ts';
import { closeDb, db } from '../history/db.ts';

/**
 * Whose link is it.
 *
 * The server used to answer "the station's", because it held exactly one of
 * everything. These tests are about the questions that could not be asked
 * before: which saved device this session belongs to, what happens to it when
 * that device is forgotten, and what the second station is told when there is
 * only one radio to go round.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-connections-'));

class StubTransport implements Transport {
  readonly kind = 'ble' as const;
  boundId: string | null = null;
  connected = false;
  started = 0;
  bindings: string[] = [];
  #listeners: ((device: DiscoveredDevice) => void)[] = [];

  async start() {
    this.started += 1;
  }
  async stop() {}
  discovered(): DiscoveredDevice[] {
    return [];
  }
  async bind(id: string) {
    this.bindings.push(id);
    this.boundId = id;
    this.connected = true;
  }
  async unbind() {
    this.boundId = null;
    this.connected = false;
  }
  async send() {}
  async request(): Promise<ParsedFrame> {
    throw new Error('not used');
  }
  onFrame() {
    return () => {};
  }
  onDiscovery(listener: (device: DiscoveredDevice) => void) {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((candidate) => candidate !== listener);
    };
  }

  get watchers(): number {
    return this.#listeners.length;
  }

  /** Pretends a station advertised itself. */
  announce(device: Partial<DiscoveredDevice> & { id: string }) {
    const full = {
      kind: 'ble',
      name: 'POWER-1234',
      likelyStation: true,
      ...device,
    } as DiscoveredDevice;
    for (const listener of this.#listeners) listener(full);
  }
}

class StubDriver implements StationDriver {
  readonly mode = 'simulator' as const;
  started = 0;
  stopped = 0;

  async start() {
    this.started += 1;
  }
  async stop() {
    this.stopped += 1;
  }
  status() {
    return { name: 'Stub' } as never;
  }
  settings() {
    return {} as never;
  }
  async applySettings() {
    return {} as never;
  }
  async setPort() {
    return {} as never;
  }
}

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
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

type Harness = {
  catalog: DeviceCatalog;
  connections: ConnectionManager;
  transport: StubTransport;
  drivers: StubDriver[];
  bound: { deviceId: string; kind: LinkKind; boundId: string | null }[];
  station: (name?: string, config?: Record<string, unknown>) => DeviceRecord;
};

function harness(kind: LinkKind = 'sim', options: { autoBind?: boolean } = {}): Harness {
  const catalog = new DeviceCatalog();
  const transport = new StubTransport();
  const drivers: StubDriver[] = [];
  const bound: Harness['bound'] = [];

  const connections = new ConnectionManager({
    kind,
    readOnly: false,
    autoBind: options.autoBind,
    transport: () => transport,
    simulator: () => {
      const driver = new StubDriver();
      drivers.push(driver);
      return driver;
    },
    onBound: (deviceId, boundKind, boundId) => bound.push({ deviceId, kind: boundKind, boundId }),
  });

  return {
    catalog,
    connections,
    transport,
    drivers,
    bound,
    station: (name = 'Station', config = {}) =>
      catalog.add({ type: 'power-station', driver: 'core.station', name, config }),
  };
}

describe('the connection manager', () => {
  test('opens nothing when nothing is saved', async () => {
    const { connections, catalog } = harness();
    await connections.sync(catalog.list());

    expect(connections.sessions).toEqual([]);
    expect(connections.station()).toBeNull();
  });

  test('opens one session per saved station, keyed by its catalog id', async () => {
    const { connections, catalog, station, drivers } = harness();
    const record = station('Living room');
    await connections.sync(catalog.list());

    const session = connections.get(record.id);
    expect(session?.deviceId).toBe(record.id);
    expect(connections.station()?.deviceId).toBe(record.id);
    expect(drivers[0]?.started).toBe(1);
  });

  test('ignores devices that are not stations', async () => {
    const { connections, catalog } = harness();
    catalog.add({ type: 'smart-plug', driver: 'com.tuya.local', name: 'Kitchen plug' });
    await connections.sync(catalog.list());

    expect(connections.sessions).toEqual([]);
  });

  /*
    The honest half of the single-link constraint. Two records cannot share one
    radio, so the second is told why in words the device card can show — rather
    than being handed the first one's link and appearing to work.
  */
  test('refuses a second station, and says why', async () => {
    const { connections, catalog, station } = harness();
    const first = station('First');
    const second = station('Second');
    await connections.sync(catalog.list());

    expect(connections.get(first.id)).not.toBeNull();
    expect(connections.get(second.id)).toBeNull();
    expect(connections.refusal(second.id)).toContain('one station link at a time');
  });

  test('forgetting a device closes its session', async () => {
    const { connections, catalog, station, drivers } = harness();
    const record = station();
    await connections.sync(catalog.list());

    catalog.remove(record.id);
    await connections.sync(catalog.list());

    expect(connections.get(record.id)).toBeNull();
    expect(connections.sessions).toEqual([]);
    expect(drivers[0]?.stopped).toBe(1);
  });

  test('a re-sync does not reopen a session that is already up', async () => {
    const { connections, catalog, station, drivers } = harness();
    station();
    await connections.sync(catalog.list());
    await connections.sync(catalog.list());

    expect(drivers).toHaveLength(1);
    expect(drivers[0]?.started).toBe(1);
  });

  test('the refusal clears once the device it belonged to is gone', async () => {
    const { connections, catalog, station } = harness();
    station('First');
    const second = station('Second');
    await connections.sync(catalog.list());
    expect(connections.refusal(second.id)).not.toBeNull();

    catalog.remove(second.id);
    await connections.sync(catalog.list());
    expect(connections.refusal(second.id)).toBeNull();
  });

  describe('on a hardware link', () => {
    test('starts the transport once, however many syncs run', async () => {
      const { connections, catalog, station, transport } = harness('ble');
      station();
      await connections.sync(catalog.list());
      await connections.link();

      expect(transport.started).toBe(1);
    });

    test('reconnects to the station the record already names', async () => {
      const { connections, catalog, station, transport } = harness('ble');
      station('Mine', { transport: 'ble', boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      expect(transport.bindings).toEqual(['AA:BB']);
    });

    /*
      Where a device is reached is a property of that device. The old code wrote
      it to one file per server, which is exactly why a second station could not
      be represented.
    */
    test('binding reports back which device was bound, and to what', async () => {
      const { connections, catalog, station, bound } = harness('ble');
      const record = station();
      await connections.sync(catalog.list());

      await connections.bind(record.id, 'CC:DD');
      expect(bound).toEqual([{ deviceId: record.id, kind: 'ble', boundId: 'CC:DD' }]);

      await connections.unbind(record.id);
      expect(bound[1]).toEqual({ deviceId: record.id, kind: 'ble', boundId: null });
    });

    test('auto-binds a discovered station to the device that is waiting for one', async () => {
      const { connections, catalog, station, transport, bound } = harness('ble', { autoBind: true });
      const record = station();
      await connections.sync(catalog.list());

      transport.announce({ id: 'EE:FF' });
      await Promise.resolve();
      await Promise.resolve();

      expect(transport.bindings).toEqual(['EE:FF']);
      expect(bound[0]?.deviceId).toBe(record.id);
    });

    test('never auto-binds something it cannot identify as a station', async () => {
      const { connections, catalog, station, transport } = harness('ble', { autoBind: true });
      station();
      await connections.sync(catalog.list());

      transport.announce({ id: 'EE:FF', likelyStation: false });
      await Promise.resolve();

      expect(transport.bindings).toEqual([]);
    });

    /*
      The failure this prevents is nasty: closing a session unbinds the radio,
      and a listener left behind by the closed session would see an unbound
      transport and bind the very station the user just forgot.
    */
    test('a forgotten device stops watching for stations', async () => {
      const { connections, catalog, station, transport, bound } = harness('ble', {
        autoBind: true,
      });
      const record = station();
      await connections.sync(catalog.list());
      expect(transport.watchers).toBe(1);

      catalog.remove(record.id);
      await connections.sync(catalog.list());
      expect(transport.watchers).toBe(0);

      transport.announce({ id: 'EE:FF' });
      await Promise.resolve();
      await Promise.resolve();

      expect(transport.bindings).toEqual([]);
      expect(bound).toEqual([]);
    });

    test('opening and closing repeatedly leaves one watcher, not a pile', async () => {
      const { connections, catalog, station, transport } = harness('ble');

      for (let round = 0; round < 3; round += 1) {
        const record = station(`Round ${round}`);
        await connections.sync(catalog.list());
        expect(transport.watchers).toBe(1);
        catalog.remove(record.id);
        await connections.sync(catalog.list());
      }

      expect(transport.watchers).toBe(0);
    });

    /*
      The record is the authority on which station is this device's. A session
      that kept preferring the id it opened with would drag the user back to the
      station they had just moved away from.
    */
    test('after a rebind, a dropped link comes back to the new station', async () => {
      const { connections, catalog, station, transport } = harness('ble', { autoBind: false });
      const record = station('Mine', { boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      await connections.bind(record.id, 'CC:DD');
      // The link drops on its own — the radio loses it, nobody asked it to.
      await transport.unbind();

      // The station it was moved *away* from advertises. Auto-bind is off, so
      // only this device's own station may be taken, and this is not it.
      transport.announce({ id: 'AA:BB' });
      await Promise.resolve();
      expect(transport.boundId).toBeNull();

      transport.announce({ id: 'CC:DD' });
      await Promise.resolve();
      await Promise.resolve();
      expect(transport.boundId).toBe('CC:DD');
    });

    /** A deliberate unbind means stop, not "reconnect at the first chance". */
    test('an explicit unbind is not undone by the station reappearing', async () => {
      const { connections, catalog, station, transport } = harness('ble', { autoBind: false });
      const record = station('Mine', { boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      await connections.unbind(record.id);
      transport.announce({ id: 'AA:BB' });
      await Promise.resolve();
      await Promise.resolve();

      expect(transport.boundId).toBeNull();
    });

    test('closing a session releases the station but keeps the radio', async () => {
      const { connections, catalog, station, transport } = harness('ble');
      const record = station('Mine', { boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      await connections.close(record.id);
      expect(transport.boundId).toBeNull();
      expect(connections.transport).toBe(transport);
    });
  });
});
