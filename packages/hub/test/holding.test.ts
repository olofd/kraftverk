import { afterEach, expect, test } from 'bun:test';

import { ApiError, type Caller, type ConnectionView, type DeviceView, type KraftverkApi } from '@kraftverk/api-contract';
import { connectionId, savedDeviceId } from '@kraftverk/device-sdk';
import { plainSecrets, type SqlDatabase } from '@kraftverk/store';

import { createHolding, createHub, installedFrom, type Holding, type Hub } from '../src/index.ts';
import { busDefinition, FakeBus, lampProtocol, lampType } from '../src/testing.ts';
import { testDatabase } from './home.ts';

/*
  An app holding a way for a server's home (docs/PLAN-SHARED-CORE.md, phase
  6): a server's hub in the process, asked as a person signed in on it, and
  an app beside it with a database of its own and a lamp on a bus only the
  app reaches — as a phone reaches a station over its own Bluetooth.
*/

const PERSON: Caller = { kind: 'person', name: 'olof', account: 'u-1' };
const NO_NETWORK = () => Promise.reject(new Error('no network here'));
const sealing = { seal: async () => '', open: async () => '' };

let running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const each of running.reverse()) await each.stop();
  running = [];
});

/** A server whose home has no way to the bus: only an app can reach the lamp. */
async function server(): Promise<{ hub: Hub; home: KraftverkApi }> {
  const database = testDatabase();
  database.exec("INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES ('u-1', 'olof', 'x', '2026-10-01', '2026-10-01')");
  const installed = installedFrom(
    { types: [{ type: lampType }], protocols: [lampProtocol], transports: [{ definition: { ...busDefinition, platforms: ['web'], discovery: { web: 'list' } }, create: null }] },
    { platform: 'server', context: { env: {}, log: () => {}, audit: () => {} } }
  );
  const hub = createHub({ database, secrets: plainSecrets, sealing, installed, readOnly: () => false, http: NO_NETWORK });
  await hub.start();
  running.push(hub);
  return { hub, home: hub.as(PERSON) };
}

/** The app: its own database, its own bus with a lamp on it, holding for `home`. */
async function app(home: KraftverkApi, database: SqlDatabase = testDatabase(), bus = new FakeBus()): Promise<{ holding: Holding; bus: FakeBus; database: SqlDatabase }> {
  if (!bus.lamps.size) bus.lamps.set('lamp-1', { serial: 'LAMP-1', model: 'L1', on: false, answers: true });
  const installed = installedFrom(
    { types: [{ type: lampType }], protocols: [lampProtocol], transports: [{ definition: { ...busDefinition, platforms: ['web'], discovery: { web: 'list' } }, create: () => bus }] },
    { platform: 'web', context: { env: {}, log: () => {}, audit: () => {} } }
  );
  const holding = createHolding({ home, database, secrets: plainSecrets, installed, app: { name: 'Chrome on a test', platform: 'web' }, readOnly: () => false, http: NO_NETWORK, sendEveryMs: 60_000, log: () => {} });
  await holding.start();
  running.push(holding);
  return { holding, bus, database };
}

/** Waits for what a test expects to come true, a little at a time. */
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Never: ${what}`);
}

/** A lamp added with the app's own way, through the holding's interface, as the add flow does it. */
async function addLamp(api: KraftverkApi, bus: FakeBus): Promise<DeviceView> {
  bus.announce();
  const draft = await api.setup.start({ typeId: 'test.lamp', methodId: 'bus', holder: 'this-app' });
  await api.setup.choose(draft.id, { address: 'lamp-1' });
  await api.setup.update(draft.id, { connection: { pin: '4321' } });
  expect((await api.setup.check(draft.id)).outcome).toBe('new');
  return api.setup.save(draft.id, { name: 'Desk lamp' });
}

test('the ways this app can hold are offered beside the server’s, for a type it has installed', async () => {
  const { home } = await server();
  const { holding } = await app(home);
  const lamp = (await holding.api.deviceTypes()).types.find((type) => type.id === 'test.lamp')!;
  // The server cannot reach the bus at all, so it offers only the simulator; this app offers the bus itself.
  expect(lamp.ways.filter((way) => way.holder === 'home')).toEqual([{ method: 'simulated', holder: 'home', availability: { ok: true } }]);
  expect(lamp.ways).toContainEqual({ method: 'bus', holder: 'this-app', availability: { ok: true } });
  // A simulator reaches nothing for this app to hold: with a server, the server holds it.
  expect(lamp.ways.some((way) => way.holder === 'this-app' && way.method === 'simulated')).toBe(false);
  expect((await holding.api.transports.list()).transports).toContainEqual(expect.objectContaining({ id: 'bus', holder: 'this-app', running: true }));
  // Who this app is, the server knows: it said so as it started.
  expect((await home.apps.list()).map((each) => [each.id, each.name, each.transports])).toEqual([[holding.appId!, 'Chrome on a test', ['bus']]]);
});

test('a way this app holds: set up here, judged and kept by the server, held here — its secret never sent — and what it says sent up', async () => {
  const { hub, home } = await server();
  const { holding, bus } = await app(home);
  const api = holding.api;

  const saved = await addLamp(api, bus);
  const way = saved.connections[0]!;
  expect(way.heldBy).toEqual({ kind: 'this-app', id: holding.appId!, name: 'Chrome on a test' });
  expect(way.secrets).toEqual(['pin']);
  // The server keeps the device and knows which app holds its way — and never had the PIN.
  const there = await home.devices.get(saved.id);
  expect(there.connections[0]!.heldBy).toEqual({ kind: 'client', id: holding.appId!, name: 'Chrome on a test' });
  expect(there.connections[0]!.secrets).toEqual([]);
  expect(hub.connections.secretFields(way.id)).toEqual([]);

  // Held here: this app's own session reads it, and the view says so first-hand.
  await until(async () => (await api.devices.get(saved.id)).readings.length > 0, 'the lamp read by this app');
  expect((await api.devices.get(saved.id)).health.status).toBe('connected');

  // The live stream says what this app hears from it, first-hand.
  const heard: unknown[] = [];
  const stream = api.live((update) => heard.push(update));

  // A command to it goes through this app's gateway: checked, sent, verified here.
  const result = await api.devices.command(saved.id, 'main', 'switch', 'set', { args: { on: true } });
  await until(() => heard.some((update) => JSON.stringify(update).includes('"type":"readings"') && JSON.stringify(update).includes(saved.id)), 'the stream carrying the lamp');
  stream.close();
  expect(result).toMatchObject({ outcome: 'verified' });
  expect(bus.lamps.get('lamp-1')!.on).toBe(true);

  // Sent up: the server has its readings, and its timeline has the command, from this app.
  await holding.send();
  expect(holding.queue.count()).toBe(0);
  await until(async () => (await home.devices.get(saved.id)).readings.some((reading) => reading.key === 'on' && reading.value === true), 'the server hearing the lamp is on');
  const timeline = await home.timeline({ limit: 20 });
  expect(timeline.find((entry) => entry.kind === 'command.intent')).toMatchObject({ actor: 'olof', resource: saved.id, detail: { from: { client: holding.appId, name: 'Chrome on a test' } } });

  // Its secret changes here, and stays here.
  const changed = await api.connections.setSecrets(saved.id, way.id, { pin: '9999' });
  expect(changed.connections[0]!.secrets).toEqual(['pin']);
  expect(holding.connections.secret(way.id, 'pin')).toBe('9999');
  expect(hub.connections.secretFields(way.id)).toEqual([]);
});

test('with the server away, what this app holds it still reaches, and what it says waits to be sent', async () => {
  const { home } = await server();
  const first = await app(home);
  const saved = await addLamp(first.holding.api, first.bus);
  await first.holding.stop();
  running = running.filter((each) => each !== first.holding);

  // The same app started again, its database as it left it, and the server not answering.
  const away = new Proxy({} as KraftverkApi, {
    get: () =>
      new Proxy(() => {}, {
        get: () => () => Promise.reject(new ApiError('unavailable', 'Can’t reach the server')),
        apply: () => Promise.reject(new ApiError('unavailable', 'Can’t reach the server')),
      }),
  });
  const again = await app(away, first.database, first.bus);
  await until(() => again.holding.sessions.get(saved.id) !== null, 'the lamp opened with no server');
  await until(() => (again.holding.sessions.get(saved.id)?.readings().length ?? 0) > 0, 'the lamp read with no server');
  await again.holding.send();
  expect(again.holding.queue.count()).toBeGreaterThan(0);
});

/** A server that can be made to stop answering, as one does when the app leaves home: every call refused as out of reach. */
function switchable(home: KraftverkApi): { api: KraftverkApi; away: (away: boolean) => void } {
  let gone = false;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(on, key) {
        const value = Reflect.get(on, key) as unknown;
        if (typeof value === 'function') return (...args: unknown[]) => (gone ? Promise.reject(new ApiError('unavailable', 'Can’t reach the server')) : (value as (...a: unknown[]) => unknown).apply(on, args));
        return value && typeof value === 'object' ? wrap(value) : value;
      },
    });
  return { api: wrap(home), away: (away) => (gone = away) };
}

test('with the server away, its home is shown as it last said it — offline, and nothing changed through it — and what this app holds goes on', async () => {
  const { home } = await server();
  const reach = switchable(home);
  const { holding, bus } = await app(reach.api);
  const api = holding.api;
  const lamp = await addLamp(api, bus);
  // One the server holds itself: its simulator.
  const draft = await api.setup.start({ typeId: 'test.lamp', methodId: 'simulated' });
  expect((await api.setup.check(draft.id)).outcome).toBe('new');
  const theirs = await api.setup.save(draft.id, { name: 'Server lamp' });
  await api.policy.set('loadWatts', 40);
  await until(async () => (await api.devices.get(lamp.id)).readings.length > 0, 'this app reading its lamp');
  expect((await api.devices.list()).map((device) => device.name).sort()).toEqual(['Desk lamp', 'Server lamp']);

  reach.away(true);
  const list = await api.devices.list();
  expect(list.map((device) => device.name).sort()).toEqual(['Desk lamp', 'Server lamp']);
  // The server's own, as it last said it — and saying it cannot be reached.
  expect(list.find((device) => device.id === theirs.id)!.health).toMatchObject({ status: 'offline', detail: 'Your server cannot be reached: this is what it last said' });
  expect((await api.devices.get(theirs.id)).health.status).toBe('offline');
  // This app's own, as it is now.
  expect(list.find((device) => device.id === lamp.id)!.health.status).toBe('connected');
  expect((await api.policy.list()).find((value) => value.name === 'loadWatts')?.value).toBe(40);
  // Nothing changes through a server that is not there…
  expect((await refusedKind(api.devices.update(theirs.id, { name: 'Renamed' })))).toBe('unavailable');
  expect((await refusedKind(api.devices.command(theirs.id, 'main', 'switch', 'set', { args: { on: false } })))).toBe('unavailable');
  // …but what this app reaches itself, it still switches.
  expect(await api.devices.command(lamp.id, 'main', 'switch', 'set', { args: { on: true } })).toMatchObject({ outcome: 'verified' });

  // Back: what it says is what is shown again.
  reach.away(false);
  expect((await api.devices.get(theirs.id)).health.status).not.toBe('offline');
});

/** What a call was refused with: its kind. */
async function refusedKind(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'answered';
  } catch (error) {
    return error instanceof ApiError ? error.kind : 'thrown';
  }
}

test('this app holds its way only while nothing above it reaches the device, and lets go when something does', async () => {
  const { home } = await server();
  const { holding } = await app(home);
  const me = await holding.register();
  const id = savedDeviceId('d-00000000ab01');
  const way = (overrides: Partial<ConnectionView>): ConnectionView => ({
    id: connectionId('c-00000000ab01'),
    method: 'bus',
    methodLabel: 'Bus',
    transport: 'bus',
    heldBy: { kind: 'client', id: me, name: 'Chrome on a test' },
    address: 'lamp-1',
    priority: 1,
    reachable: null,
    inUse: false,
    lastConnectedAt: null,
    secrets: [],
    secretsExportable: false,
    config: {},
    ...overrides,
  });
  const lamp = (serverWayReachable: boolean): DeviceView => ({
      id,
      key: 'hall-lamp',
      typeId: 'test.lamp',
      installed: true,
      name: 'Hall lamp',
      identity: null,
      addedAt: '2026-10-01T00:00:00.000Z',
      removedAt: null,
      kind: 'hardware' as const,
      meta: { name: 'Lamp', icon: 'lightbulb', support: 'experimental' as const, category: 'light' },
      description: lampType.describe({}),
      descriptionSource: 'type',
      capabilities: [],
      info: null,
      config: {},
      connections: [way({ id: connectionId('c-00000000ab00'), heldBy: { kind: 'home' }, priority: 0, reachable: serverWayReachable }), way({})],
      links: [],
      tools: [],
      readings: [],
    health: { status: 'connected', detail: 'Connected', lastReadingAt: null, owner: 'server', transport: 'bus' },
    picture: 'type:0',
  });

  // The server's own way reaches it: this app keeps its way, and holds nothing.
  await holding.hold([lamp(true)]);
  expect(holding.holds(id)).toBe(false);
  expect(holding.owns('c-00000000ab01')).toBe(true);
  // The server's way is down: this app's takes over.
  await holding.hold([lamp(false)]);
  expect(holding.holds(id)).toBe(true);
  // Gone from the server: let go of, with what was kept for it.
  await holding.hold([]);
  expect(holding.holds(id)).toBe(false);
  expect(holding.owns('c-00000000ab01')).toBe(false);
});
