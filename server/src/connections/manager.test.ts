import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DiscoveredDevice, ParsedFrame } from '@kraftverk/protocol';

import { ConnectionManager, type LinkKind } from './manager.ts';
import { DeviceCatalog, type DeviceRecord } from '../devices/catalog.ts';
import type { StationDriver } from '../drivers/types.ts';
import type { ServerLink, TransportHost } from '../transport/types.ts';
import { closeDb, db } from '../history/db.ts';

/**
 * Whose link is it.
 *
 * The server used to answer "the station's", because it held exactly one of
 * everything. These tests are about the questions that could not be asked
 * before: which saved device a session belongs to, what happens to it when that
 * device is forgotten, and — since the host/link split — what happens when there
 * are two stations rather than one.
 *
 * The second station used to be refused outright. It is not any more, and that
 * is the point: one broker serves every station that connects to it, and a BLE
 * central holds several peripherals at once. What is still refused is two saved
 * devices claiming the *same* station, because a station really does accept one
 * connection at a time.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-connections-'));

/**
 * Lets the discovery handler finish.
 *
 * Deliberately a macrotask rather than a counted number of `Promise.resolve()`s:
 * auto-binding now awaits the host and the link as well as the record, and a
 * test that counts microtasks silently starts asserting on a half-finished bind
 * the moment that chain gets one link longer.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One station's link. Several of these can be open on one host. */
class StubLink implements ServerLink {
  readonly kind = 'ble' as const;
  connected = true;
  closed = false;

  constructor(
    readonly boundId: string,
    private release: () => void
  ) {}

  async send() {}
  async request(): Promise<ParsedFrame> {
    throw new Error('not used');
  }
  onFrame() {
    return () => {};
  }
  async close() {
    this.closed = true;
    this.connected = false;
    this.release();
  }
}

class StubHost implements TransportHost {
  readonly kind = 'ble' as const;
  started = 0;
  /** Every station id ever opened, in order. */
  opened: string[] = [];
  links = new Map<string, StubLink>();
  #listeners: ((device: DiscoveredDevice) => void)[] = [];

  async start() {
    this.started += 1;
  }
  async stop() {}
  discovered(): DiscoveredDevice[] {
    return [];
  }
  openIds(): string[] {
    return [...this.links.keys()];
  }
  /** Set to a station id to make opening it fail, as an out-of-range one does. */
  failOn: string | null = null;

  async open(stationId: string): Promise<ServerLink> {
    this.opened.push(stationId);
    if (stationId === this.failOn) throw new Error(`${stationId} is not in range`);
    const existing = this.links.get(stationId);
    if (existing) return existing;
    const link = new StubLink(stationId, () => this.links.delete(stationId));
    this.links.set(stationId, link);
    return link;
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
  host: StubHost;
  drivers: StubDriver[];
  bound: { deviceId: string; kind: LinkKind; boundId: string | null }[];
  station: (name?: string, config?: Record<string, unknown>) => DeviceRecord;
};

function harness(kind: LinkKind = 'sim', options: { autoBind?: boolean } = {}): Harness {
  const catalog = new DeviceCatalog();
  const host = new StubHost();
  const drivers: StubDriver[] = [];
  const bound: Harness['bound'] = [];

  const connections = new ConnectionManager({
    kind,
    readOnly: false,
    autoBind: options.autoBind,
    host: () => host,
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
    host,
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
  });

  test('opens one session per saved station, keyed by its catalog id', async () => {
    const { connections, catalog, station, drivers } = harness();
    const record = station('Living room');
    await connections.sync(catalog.list());

    const session = connections.get(record.id);
    expect(session?.deviceId).toBe(record.id);
    expect(drivers[0]?.started).toBe(1);
  });

  test('ignores devices that are not stations', async () => {
    const { connections, catalog } = harness();
    catalog.add({ type: 'smart-plug', driver: 'com.tuya.local', name: 'Kitchen plug' });
    await connections.sync(catalog.list());

    expect(connections.sessions).toEqual([]);
  });

  /*
    The refusal this replaced was the whole reason for the host/link split. The
    server told the second station it had no room, which was true of the old
    transport and untrue of the hardware.
  */
  test('opens a session for every saved station, not just the first', async () => {
    const { connections, catalog, station } = harness();
    const first = station('First');
    const second = station('Second');
    const third = station('Third');
    await connections.sync(catalog.list());

    expect(connections.get(first.id)).not.toBeNull();
    expect(connections.get(second.id)).not.toBeNull();
    expect(connections.get(third.id)).not.toBeNull();
    expect(connections.sessions).toHaveLength(3);
    expect(connections.refusal(second.id)).toBeNull();
  });

  test('each station gets its own driver, so none reads another one’s numbers', async () => {
    const { connections, catalog, station, drivers } = harness();
    station('First');
    station('Second');
    await connections.sync(catalog.list());

    expect(drivers).toHaveLength(2);
    expect(drivers[0]).not.toBe(drivers[1]);
    expect(drivers.every((driver) => driver.started === 1)).toBe(true);
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

  /*
    The conflict that is real, and the only one left: a station accepts one
    connection, so two saved devices naming the same unit cannot both have it.
  */
  test('refuses the second device that names a station another one already holds', async () => {
    const { connections, catalog, station, host } = harness('ble');
    const first = station('Mine', { boundId: 'AA:BB' });
    const second = station('Also mine', { boundId: 'AA:BB' });
    await connections.sync(catalog.list());

    expect(connections.get(first.id)?.link?.boundId).toBe('AA:BB');
    expect(connections.get(second.id)?.link).toBeNull();
    expect(connections.refusal(second.id)).toContain('already bound to AA:BB');
    // One link, not two fighting over one connection.
    expect(host.openIds()).toEqual(['AA:BB']);
  });

  test('the refusal clears once the device it belonged to is gone', async () => {
    const { connections, catalog, station } = harness('ble');
    station('First', { boundId: 'AA:BB' });
    const second = station('Second', { boundId: 'AA:BB' });
    await connections.sync(catalog.list());
    expect(connections.refusal(second.id)).not.toBeNull();

    catalog.remove(second.id);
    await connections.sync(catalog.list());
    expect(connections.refusal(second.id)).toBeNull();
  });

  describe('on a hardware link', () => {
    test('starts the host once, however many syncs run', async () => {
      const { connections, catalog, station, host } = harness('ble');
      station();
      await connections.sync(catalog.list());
      await connections.link();

      expect(host.started).toBe(1);
    });

    test('reconnects to the station the record already names', async () => {
      const { connections, catalog, station, host } = harness('ble');
      station('Mine', { transport: 'ble', boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      expect(host.opened).toEqual(['AA:BB']);
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
      const { connections, catalog, station, host, bound } = harness('ble', { autoBind: true });
      const record = station();
      await connections.sync(catalog.list());

      host.announce({ id: 'EE:FF' });
      await settle();

      expect(host.opened).toEqual(['EE:FF']);
      expect(bound[0]?.deviceId).toBe(record.id);
    });

    test('never auto-binds something it cannot identify as a station', async () => {
      const { connections, catalog, station, host } = harness('ble', { autoBind: true });
      station();
      await connections.sync(catalog.list());

      host.announce({ id: 'EE:FF', likelyStation: false });
      await settle();

      expect(host.opened).toEqual([]);
    });

    /*
      Every waiting session's watcher fires in the same turn, so a claim that is
      only recorded after an `await` is not a claim at all: each one looks and
      sees the station free. One station, two owners, and both drivers polling
      the same link — with whichever closed first taking it away from the other.

      Only possible once the server could hold more than one station, which is
      exactly why it needs a test rather than an argument.
    */
    test('two waiting devices do not both claim the same discovered station', async () => {
      const { connections, catalog, station, host, bound } = harness('ble', { autoBind: true });
      station('First');
      station('Second');
      await connections.sync(catalog.list());

      host.announce({ id: 'EE:FF' });
      await settle();

      expect(host.openIds()).toEqual(['EE:FF']);
      expect(bound.filter((entry) => entry.boundId === 'EE:FF')).toHaveLength(1);
      const owners = connections.sessions.filter((s) => s.link?.boundId === 'EE:FF');
      expect(owners).toHaveLength(1);
    });

    /*
      A deliberate unbind means stop. Auto-bind is on by default, and the
      watcher treats "no preferred station" as "free to take the first one it
      sees" — which is the station the user just released, a second later.
    */
    test('an explicit unbind survives auto-bind, not just a quiet radio', async () => {
      const { connections, catalog, station, host } = harness('ble', { autoBind: true });
      const record = station('Mine', { boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      await connections.unbind(record.id);
      host.announce({ id: 'AA:BB' });
      await settle();

      expect(connections.get(record.id)?.link).toBeNull();
      expect(host.openIds()).toEqual([]);
    });

    /* One unreachable station must not stop the others from ever opening. */
    test('a station that fails to open does not abort the rest of the sync', async () => {
      const { connections, catalog, station, host } = harness('ble');
      host.failOn = 'AA:BB';
      station('Broken', { boundId: 'AA:BB' });
      const good = station('Fine', { boundId: 'CC:DD' });

      await connections.sync(catalog.list());

      expect(connections.get(good.id)?.link?.boundId).toBe('CC:DD');
      expect(connections.sessions).toHaveLength(2);
    });

    /*
      The failure this prevents is nasty: closing a session unbinds the radio,
      and a listener left behind by the closed session would see an unbound
      host and bind the very station the user just forgot.
    */
    test('a forgotten device stops watching for stations', async () => {
      const { connections, catalog, station, host, bound } = harness('ble', {
        autoBind: true,
      });
      const record = station();
      await connections.sync(catalog.list());
      expect(host.watchers).toBe(1);

      catalog.remove(record.id);
      await connections.sync(catalog.list());
      expect(host.watchers).toBe(0);

      host.announce({ id: 'EE:FF' });
      await settle();

      expect(host.opened).toEqual([]);
      expect(bound).toEqual([]);
    });

    test('opening and closing repeatedly leaves one watcher, not a pile', async () => {
      const { connections, catalog, station, host } = harness('ble');

      for (let round = 0; round < 3; round += 1) {
        const record = station(`Round ${round}`);
        await connections.sync(catalog.list());
        expect(host.watchers).toBe(1);
        catalog.remove(record.id);
        await connections.sync(catalog.list());
      }

      expect(host.watchers).toBe(0);
    });

    /*
      The record is the authority on which station is this device's. Rebinding
      has to release the old link as well as take the new one, or the server
      would quietly keep a connection to the station the user walked away from —
      and that station would go on refusing everything else.
    */
    test('rebinding releases the old station and takes the new one', async () => {
      const { connections, catalog, station, host } = harness('ble', { autoBind: false });
      const record = station('Mine', { boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      const before = host.links.get('AA:BB');
      await connections.bind(record.id, 'CC:DD');

      expect(before?.closed).toBe(true);
      expect(host.openIds()).toEqual(['CC:DD']);
      expect(connections.get(record.id)?.link?.boundId).toBe('CC:DD');
    });

    /** A deliberate unbind means stop, not "reconnect at the first chance". */
    test('an explicit unbind is not undone by the station reappearing', async () => {
      const { connections, catalog, station, host } = harness('ble', { autoBind: false });
      const record = station('Mine', { boundId: 'AA:BB' });
      await connections.sync(catalog.list());

      await connections.unbind(record.id);
      host.announce({ id: 'AA:BB' });
      await settle();

      expect(host.openIds()).toEqual([]);
      expect(connections.get(record.id)?.link).toBeNull();
    });

    /*
      The point of the split, stated as a test: closing one device's session
      must not disturb another's station, and must not take down the radio that
      both of them share.
    */
    test('closing one session leaves the other station and the radio alone', async () => {
      const { connections, catalog, station, host } = harness('ble');
      const first = station('First', { boundId: 'AA:BB' });
      const second = station('Second', { boundId: 'CC:DD' });
      await connections.sync(catalog.list());
      expect(host.openIds()).toEqual(['AA:BB', 'CC:DD']);

      await connections.close(first.id);

      expect(host.openIds()).toEqual(['CC:DD']);
      expect(connections.get(second.id)?.link?.connected).toBe(true);
      expect(connections.transport).toBe(host);
    });
  });
});
