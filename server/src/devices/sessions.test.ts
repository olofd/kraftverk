import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SIMULATED_ADDRESS, SIMULATED_METHOD_ID, SIMULATED_TRANSPORT } from '@kraftverk/device-sdk';
import { LiveBus, type LiveMessage, SessionManager } from '@kraftverk/holder';

import { closeDb, db, deviceStore, audit } from '../platform/database.ts';
import { DeviceTypeRegistry, ProtocolRegistry, TransportHost } from '@kraftverk/hub';
import { busDefinition, FakeBus, LAMP, lampControl, lampProtocol, lampType, opened } from '@kraftverk/hub/testing';
import { DeviceCatalog, ClientStore, ConnectionStore, holding } from '@kraftverk/store';
import { serverSecrets } from '../platform/secrets.ts';

/**
 * One session per saved device, whatever it is, over the connection it is
 * reached by.
 *
 * The manager knows no product, protocol or transport, so these use a lamp on
 * a pretend bus. What is pinned down: each device gets its own config, store
 * and lifecycle; the connection in use is the preferred one this server can
 * reach; a device that cannot open says why; and a connection that turns out
 * to reach a different device is refused.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-sessions-'));

let catalog: DeviceCatalog;
let connections: ConnectionStore;
let clients: ClientStore;
let sessions: SessionManager;
let bus: FakeBus;
let identified: [string, string][];

const build = (options: { readOnly?: boolean; bus?: LiveBus } = {}) => {
  const protocols = new ProtocolRegistry();
  expect(protocols.install(lampProtocol)).toEqual([]);
  const transports = new TransportHost({ platform: 'server', context: { env: {}, log: () => {}, audit: () => {} } });
  expect(transports.install(busDefinition, { create: () => bus })).toEqual([]);
  const types = new DeviceTypeRegistry();
  expect(types.install(lampType)).toEqual([]);
  return new SessionManager({
    platform: 'server',
    owner: 'server',
    types,
    protocols,
    transports,
    ...holding(connections, null),
    store: deviceStore,
    readOnly: () => options.readOnly ?? false,
    allowRawFrames: false,
    heldByName: (id) => clients.get(id)?.name ?? null,
    record: audit,
    onIdentified: (deviceId, identity) => identified.push([deviceId, identity]),
    bus: options.bus,
  });
};

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  catalog = new DeviceCatalog(db());
  connections = new ConnectionStore(db(), serverSecrets);
  clients = new ClientStore(db());
});

afterAll(async () => {
  await sessions?.closeAll();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sessions?.closeAll();
  db().exec('DELETE FROM device');
  opened.length = 0;
  lampControl.failOpen = false;
  identified = [];
  bus = new FakeBus();
  sessions = build();
});

/** A lamp on the bus, saved, with its connection. */
const addLamp = (name: string, address: string, config: Record<string, unknown> = { room: name }, identity: string | null = null) => {
  bus.lamps.set(address, { serial: address.toUpperCase(), model: 'L1', on: true, answers: true });
  const record = catalog.add({ description: LAMP, typeId: 'test.lamp', name, config, identity });
  const connection = connections.add({ deviceId: record.id, method: 'bus', transport: 'bus', heldBy: null, address });
  return { record, connection };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('one session per device', () => {
  test('two devices of one type run side by side, each with its own config and connection', async () => {
    const hall = addLamp('Hall', 'lamp-1').record;
    const porch = addLamp('Porch', 'lamp-2').record;
    await sessions.sync(catalog.list());

    expect(sessions.get(hall.id)!.health().detail).toBe('Lamp in Hall');
    expect(sessions.get(porch.id)!.health().detail).toBe('Lamp in Porch');
    expect(opened.map((entry) => entry.ctx.connection?.address).sort()).toEqual(['lamp-1', 'lamp-2']);
    expect(sessions.inUse(hall.id)?.address).toBe('lamp-1');
  });

  test('each device has a store of its own', async () => {
    addLamp('Hall', 'lamp-1');
    addLamp('Porch', 'lamp-2');
    await sessions.sync(catalog.list());

    const [first, second] = opened.map((entry) => entry.ctx);
    first!.store.set('brightness', 80);
    expect(first!.store.get<number>('brightness')).toBe(80);
    expect(second!.store.get('brightness')).toBeNull();
  });

  test('removing a device closes its session, and keeps its store', async () => {
    const hall = addLamp('Hall', 'lamp-1').record;
    await sessions.sync(catalog.list());
    opened[0]!.ctx.store.set('brightness', 80);

    catalog.remove(hall.id);
    await sessions.sync(catalog.list());

    expect(sessions.get(hall.id)).toBeNull();
    expect(opened[0]!.closed).toBe(true);
    // Kept with its history, so bringing it back brings its store back too.
    expect(db().query('SELECT COUNT(*) AS n FROM device_kv').get()).toEqual({ n: 1 });
  });

  test('a changed config reopens the device with the new one', async () => {
    const hall = addLamp('Hall', 'lamp-1').record;
    await sessions.sync(catalog.list());
    catalog.update(hall.id, { config: { room: 'Kitchen' } });
    await sessions.sync(catalog.list());

    expect(opened[0]!.closed).toBe(true);
    expect(sessions.get(hall.id)!.health().detail).toBe('Lamp in Kitchen');
  });

  test('preferring another connection reopens the device over it', async () => {
    const { record } = addLamp('Hall', 'lamp-1');
    bus.lamps.set('lamp-9', { serial: 'LAMP-1', model: 'L1', on: true, answers: true });
    const second = connections.add({ deviceId: record.id, method: 'backup', transport: 'bus', heldBy: null, address: 'lamp-9' });
    await sessions.sync(catalog.list());
    expect(sessions.inUse(record.id)?.address).toBe('lamp-1');

    connections.prefer(second.id);
    await sessions.sync(catalog.list());
    expect(sessions.inUse(record.id)?.address).toBe('lamp-9');
  });

  test('a simulated connection opens its type’s simulator, beside real ones, and reaches nothing', async () => {
    const readOnly = build({ readOnly: true });
    const real = addLamp('Hall', 'lamp-1').record;
    const pretend = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Pretend lamp', config: { room: 'Attic' } });
    connections.add({ deviceId: pretend.id, method: SIMULATED_METHOD_ID, transport: SIMULATED_TRANSPORT, heldBy: null, address: SIMULATED_ADDRESS });
    await readOnly.sync(catalog.list());

    expect(readOnly.get(real.id)).not.toBeNull();
    expect(readOnly.get(pretend.id)).not.toBeNull();
    const simulator = opened.find((entry) => entry.ctx.connection === null)!;
    expect(simulator).toBeDefined();
    // Read-only guards hardware; a simulator has none.
    expect(simulator.ctx.readOnly).toBe(false);
    expect(readOnly.reachable(pretend.id)).toBe(true);
    await readOnly.closeAll();
  });
});

describe('a device that cannot open is still a device, saying why', () => {
  test('a setting its type does not have is refused, not guessed around', async () => {
    const { record } = addLamp('Hall', 'lamp-1', { room: 'Hall', retiredField: 'from another shape' });
    await sessions.sync(catalog.list());
    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record)).toMatchObject({ status: 'unconfigured', detail: 'Needs setting up again: Test lamp has no setting "retiredField"' });
  });

  test('a session that fails to open is an error, with the reason', async () => {
    lampControl.failOpen = true;
    const { record } = addLamp('Hall', 'lamp-1');
    await sessions.sync(catalog.list());
    expect(sessions.health(record)).toMatchObject({ status: 'error', detail: 'The lamp refused the connection; trying again in under a minute' });

    // It may refuse because of something that has since passed: tried again when due.
    lampControl.failOpen = false;
    await sessions.check(Date.now() + 31_000);
    expect(sessions.get(record.id)).not.toBeNull();
  });

  test('a device no installed type claims gets no session at all', async () => {
    const record = catalog.add({ description: LAMP, typeId: 'nobody.knows', name: 'Mystery' });
    await sessions.sync(catalog.list());
    expect(sessions.typeOf(record)).toBeNull();
    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record).detail).toContain('nobody.knows');
  });

  test('a device with no connection says nothing can reach it', async () => {
    const record = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Unreachable' });
    await sessions.sync(catalog.list());
    expect(sessions.health(record)).toMatchObject({ status: 'unconfigured' });
    expect(sessions.health(record).detail).toContain('Nothing can reach');
  });

  test('a transport that cannot run here is the reason given, and the device opens by itself when it can', async () => {
    bus.unavailable = 'No bus on this machine';
    const { record } = addLamp('Hall', 'lamp-1');
    await sessions.sync(catalog.list());
    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record)).toMatchObject({ status: 'error', detail: 'No bus on this machine; trying again in under a minute' });

    // Not yet due: left alone.
    await sessions.check(Date.now() + 10_000);
    expect(sessions.get(record.id)).toBeNull();

    // Still down when due: tried, refused, and the next wait is longer.
    await sessions.check(Date.now() + 31_000);
    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record).detail).toBe('No bus on this machine; trying again in 1 min');

    // Back: opened on the next try, with no one touching the catalog.
    bus.unavailable = null;
    await sessions.check(Date.now() + 61_000);
    expect(sessions.get(record.id)).not.toBeNull();
  });

  test('what waits on a person is not tried again', async () => {
    const record = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Unreachable' });
    await sessions.sync(catalog.list());
    await sessions.check(Date.now() + 3_600_000);
    expect(sessions.health(record)).toMatchObject({ status: 'unconfigured' });
    expect(sessions.health(record).detail).not.toContain('trying again');
  });

  test('a device held only by a phone has no session here, and says who holds it', async () => {
    const user = db().query<{ id: string }, []>('SELECT id FROM users LIMIT 1').get();
    const userId = user?.id ?? (db().exec("INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES ('u-test', 'tester', 'x', '2026-01-01', '2026-01-01')"), 'u-test');
    const phone = clients.register({ userId, name: 'Olof’s iPhone', platform: 'native', transports: ['ble'] });
    const record = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Pocket lamp' });
    connections.add({ deviceId: record.id, method: 'bus', transport: 'bus', heldBy: phone.id, address: 'lamp-7' });
    await sessions.sync(catalog.list());

    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record).detail).toBe('Held by Olof’s iPhone, not by this server');
  });
});

describe('what devices say, as it changes', () => {
  test('the bus hears every reading once, then only what moved, and health when it changes', async () => {
    const live = new LiveBus();
    const heard: LiveMessage[] = [];
    const manager = build({ bus: live });
    const { record } = addLamp('Hall', 'lamp-1');
    await manager.sync(catalog.list());
    await new Promise((resolve) => setTimeout(resolve, 30)); // its first read

    // Nobody listening: nothing is published, and nothing is remembered as sent.
    manager.pulse();
    expect(heard).toEqual([]);

    live.subscribe((message) => heard.push(message));
    manager.pulse();
    expect(heard.map((message) => message.kind)).toEqual(['readings', 'health']);
    expect(heard[0]).toMatchObject({ kind: 'readings', deviceId: record.id, readings: [expect.objectContaining({ key: 'on', value: true })] });
    expect(heard[1]).toMatchObject({ kind: 'health', health: { status: 'connected', owner: 'server', transport: 'bus' } });

    // Nothing moved: nothing said.
    heard.length = 0;
    manager.pulse();
    expect(heard).toEqual([]);

    // Switched: the one reading that moved.
    await manager.get(record.id)!.command({ part: 'main', capability: 'switch', command: 'set', args: { on: false } });
    manager.pulse();
    expect(heard).toEqual([{ kind: 'readings', deviceId: record.id, readings: [expect.objectContaining({ key: 'on', value: false })] }]);

    // Gone: its health says so.
    heard.length = 0;
    await manager.close(record.id);
    manager.pulse();
    expect(heard).toEqual([expect.objectContaining({ kind: 'health', health: expect.objectContaining({ status: 'offline' }) })]);
    await manager.closeAll();
  });
});

describe('who a device is', () => {
  test('a device saved before it answered learns its identity the first time it does', async () => {
    const { record } = addLamp('Hall', 'lamp-1');
    await sessions.sync(catalog.list());
    await settle();
    await sessions.check();
    expect(identified).toEqual([[record.id, 'lampish:LAMP-1']]);
  });

  test('a connection that now reaches a different device is refused, and recorded', async () => {
    const { record } = addLamp('Hall', 'lamp-1', { room: 'Hall' }, 'lampish:SOMEONE-ELSE');
    await sessions.sync(catalog.list());
    await settle();
    await sessions.check();

    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record).detail).toContain('different device');
    const audit = db().query<{ kind: string }, [string]>("SELECT kind FROM audit WHERE resource = ? AND kind = 'device.mismatch'").all(record.id);
    expect(audit).toHaveLength(1);
  });
});
