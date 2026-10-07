import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { NeedsSignIn, nodeId, NotReachable, SIMULATED_ADDRESS, SIMULATED_METHOD_ID, SIMULATED_TRANSPORT } from '@kraftverk/device-sdk';
import { LiveBus, type LiveMessage, SessionManager } from '@kraftverk/holder';
import { AuditLog, ConnectionStore, DeviceCatalog, deviceStore, holding, LastReadings, NodeStore, plainSecrets, type SqlDatabase } from '@kraftverk/store';

import { DeviceTypeRegistry, ProtocolRegistry, TransportHost } from '../src/index.ts';
import { busDefinition, FakeBus, LAMP, lampProtocol, makeLampType, MACHINE_NODE, TEST_INTEGRATION, TEST_SOURCE } from '../src/testing.ts';

/** The lamp these tests open, and what they see of its sessions. */
const { type: lampType, watch } = makeLampType();
const { opened } = watch;
import { testDatabase } from './home.ts';

/**
 * One session per saved device, whatever it is, over the connection it is
 * reached by, as a node holds them: the session manager, over the stores.
 *
 * The manager knows no product, protocol or transport, so these use a lamp on
 * a pretend bus. What is pinned down: each device gets its own config, store
 * and lifecycle; the connection in use is the preferred one this node holds; a device that cannot open says why; and a connection that turns out
 * to reach a different device is refused.
 */

let db: SqlDatabase;
let catalog: DeviceCatalog;
let connections: ConnectionStore;
let nodes: NodeStore;
let sessions: SessionManager;
let bus: FakeBus;
let identified: [string, string][];

const build = (options: { readOnly?: boolean; bus?: LiveBus; lastReadings?: LastReadings } = {}) => {
  const protocols = new ProtocolRegistry();
  expect(protocols.install(lampProtocol, 'test')).toEqual([]);
  const transports = new TransportHost({ platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } });
  expect(transports.install(busDefinition, { create: () => bus })).toEqual([]);
  const types = new DeviceTypeRegistry();
  expect(types.installIntegration(TEST_INTEGRATION)).toEqual([]);
  expect(types.install(lampType, TEST_SOURCE)).toEqual([]);
  return new SessionManager({
    platform: 'system',
    node: { id: MACHINE_NODE.id, name: MACHINE_NODE.name },
    types,
    protocols: { get: (id) => protocols.loaded(id) },
    transports,
    ...holding(connections, MACHINE_NODE.id),
    store: (deviceId) => deviceStore(db, deviceId),
    readOnly: () => options.readOnly ?? false,
    allowRawFrames: false,
    nodeName: (id) => nodes.get(id)?.name ?? null,
    record: (entry) => new AuditLog(db).record(entry),
    onIdentified: (deviceId, identity) => identified.push([deviceId, identity]),
    bus: options.bus,
    ...(options.lastReadings ? { lastReadings: options.lastReadings } : {}),
  });
};

beforeAll(() => {
  db = testDatabase();
  catalog = new DeviceCatalog(db);
  connections = new ConnectionStore(db, plainSecrets);
  nodes = new NodeStore(db);
  // This node, the one every connection here is held by unless another is said.
  nodes.declareSelf({ ...MACHINE_NODE, platform: 'system', transports: ['bus'] });
});

afterAll(async () => {
  await sessions?.closeAll();
  db.close();
});

beforeEach(async () => {
  await sessions?.closeAll();
  db.exec('DELETE FROM device');
  opened.length = 0;
  watch.failOpen = false;
  identified = [];
  bus = new FakeBus();
  sessions = build();
});

/** A lamp on the bus, saved, with its connection. */
const addLamp = (name: string, address: string, config: Record<string, unknown> = { room: name }, identity: string | null = null) => {
  bus.lamps.set(address, { serial: address.toUpperCase(), model: 'L1', on: true, answers: true });
  const record = catalog.add({ description: LAMP, typeId: 'test.lamp', name, config, identity });
  const connection = connections.add({ deviceId: record.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address });
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
    expect(db.query('SELECT COUNT(*) AS n FROM device_kv').get()).toEqual({ n: 1 });
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
    const second = connections.add({ deviceId: record.id, method: 'backup', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-9' });
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
    connections.add({ deviceId: pretend.id, method: SIMULATED_METHOD_ID, transport: SIMULATED_TRANSPORT, heldBy: MACHINE_NODE.id, address: SIMULATED_ADDRESS });
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
    watch.failOpen = true;
    const { record } = addLamp('Hall', 'lamp-1');
    await sessions.sync(catalog.list());
    expect(sessions.health(record)).toMatchObject({ status: 'error', detail: 'The lamp refused the connection; trying again in under a minute' });

    // Still refusing when due: tried, and the next wait is longer — a dead one is not tried every quarter minute for ever.
    await sessions.check(Date.now() + 31_000);
    expect(sessions.health(record).detail).toBe('The lamp refused the connection; trying again in under a minute');
    await sessions.check(Date.now() + 92_000);
    expect(sessions.health(record).detail).toBe('The lamp refused the connection; trying again in 1 min');

    // It may refuse because of something that has since passed: tried again when due.
    watch.failOpen = false;
    await sessions.check(Date.now() + 213_000);
    expect(sessions.get(record.id)).not.toBeNull();
  });

  test('one that waits on a person is not tried again until they act; one that says when, is tried then', async () => {
    watch.failOpen = true;
    watch.failWith = new NeedsSignIn('The lamp refused its PIN: give it again');
    const { record } = addLamp('Hall', 'lamp-1');
    await sessions.sync(catalog.list());
    expect(sessions.health(record)).toMatchObject({ status: 'needs-you', detail: 'The lamp refused its PIN: give it again' });
    // Due or not, synced or checked, it is left alone: a vendor tried in a loop locks the account.
    watch.failOpen = false;
    await sessions.check(Date.now() + 3_600_000);
    await sessions.sync(catalog.list());
    expect(sessions.get(record.id)).toBeNull();
    // A person acted — its secrets given anew close it on purpose — and it is tried at once.
    await sessions.close(record.id);
    await sessions.sync(catalog.list());
    expect(sessions.get(record.id)).not.toBeNull();
    await sessions.close(record.id);

    // Rate-limited: tried again when it said, not before.
    watch.failOpen = true;
    watch.failWith = new NotReachable('Too many requests: wait a while', 600_000);
    await sessions.sync(catalog.list());
    expect(sessions.health(record)).toMatchObject({ status: 'error', detail: 'Too many requests: wait a while; trying again in 10 min' });
    watch.failOpen = false;
    await sessions.check(Date.now() + 300_000);
    expect(sessions.get(record.id)).toBeNull();
    await sessions.check(Date.now() + 601_000);
    expect(sessions.get(record.id)).not.toBeNull();
    watch.failWith = null;
  });

  test('what its session keeps is kept as the session’s: sealed, never a reason to reopen it, and refused when it is not its to keep', async () => {
    watch.keepToken = 'a-token-from-a-sign-in';
    const { record } = addLamp('Hall', 'lamp-1');
    await sessions.sync(catalog.list());
    const session = sessions.get(record.id);
    expect(session).not.toBeNull();
    const [way] = connections.forDevice(record.id);
    expect(connections.secret(way!.id, 'token')).toBe('a-token-from-a-sign-in');
    expect(connections.secretFields(way!.id, 'session')).toEqual(['token']);
    // Synced again: the same session, not one reopened for a secret its session wrote.
    await sessions.sync(catalog.list());
    expect(sessions.get(record.id)).toBe(session);
    const ctx = watch.opened.at(-1)!.ctx;
    expect(() => (ctx.connection as { secrets: { set(field: string, value: string): void } }).secrets.set('pin', 'not its to keep')).toThrow('not a secret its session keeps');
    watch.keepToken = undefined;
  });

  test('a paused one is kept, and not opened, until resumed — and what is through it says why', async () => {
    const { record } = addLamp('Hall', 'lamp-1');
    catalog.setPaused(record.id, true);
    await sessions.sync(catalog.list());
    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record)).toMatchObject({ status: 'paused' });
    catalog.setPaused(record.id, false);
    await sessions.sync(catalog.list());
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
    expect(sessions.health(record).detail).toBe('No bus on this machine; trying again in under a minute');

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
    const userId = 'u-test';
    const phone = nodes.join({ id: nodeId('n-000000000000aa02'), name: 'Olof’s iPhone', platform: 'native', transports: ['ble'], alwaysOn: false, reachable: false, trusted: false }, userId);
    const record = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Pocket lamp' });
    connections.add({ deviceId: record.id, method: 'bus', transport: 'bus', heldBy: phone.id, address: 'lamp-7' });
    await sessions.sync(catalog.list());

    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record).detail).toBe('Held by Olof’s iPhone, not by Test machine');
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
    expect(heard[1]).toMatchObject({ kind: 'health', health: { status: 'connected', node: MACHINE_NODE.id, transport: 'bus' } });

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
    expect(identified).toEqual([[record.id, 'test-lamp:LAMP-1']]);
  });

  test('a connection that now reaches a different device is refused, and recorded', async () => {
    const { record } = addLamp('Hall', 'lamp-1', { room: 'Hall' }, 'test-lamp:SOMEONE-ELSE');
    await sessions.sync(catalog.list());
    await settle();
    await sessions.check();

    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record).detail).toContain('different device');
    const audit = db.query<{ kind: string }, [string]>("SELECT kind FROM audit WHERE resource = ? AND kind = 'device.mismatch'").all(record.id);
    expect(audit).toHaveLength(1);
  });
});

describe('what a device last said', () => {
  test('kept as it says it, and shown as it was after a restart until it says again: its value and when, never confirmed now', async () => {
    const kept = new LastReadings(db);
    sessions = build({ lastReadings: kept });
    const hall = addLamp('Hall', 'lamp-1').record;
    await sessions.sync(catalog.list());
    await settle();
    sessions.pulse();
    const said = kept.of(hall.id);
    expect(said).toEqual([{ key: 'on', value: true, at: expect.any(String) }]);

    // A restart, and the lamp quiet: what it said, as it was.
    await sessions.closeAll();
    bus.lamps.get('lamp-1')!.answers = false;
    sessions = build({ lastReadings: kept });
    await sessions.sync(catalog.list());
    expect(sessions.readings(hall.id)).toEqual(said);
    expect(sessions.readings(hall.id)[0]).not.toHaveProperty('confirmedAt');

    // It speaks again: its own word wins, and is kept.
    bus.lamps.set('lamp-1', { ...bus.lamps.get('lamp-1')!, on: false, answers: true });
    await sessions.closeAll();
    sessions = build({ lastReadings: kept });
    await sessions.sync(catalog.list());
    await settle();
    expect(sessions.readings(hall.id)[0]?.value).toBe(false);
    sessions.pulse();
    expect(kept.of(hall.id)[0]?.value).toBe(false);
  });
});
