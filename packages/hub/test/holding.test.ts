import { afterEach, expect, test } from 'bun:test';

import { ApiError, type Caller, type ConnectionView, type DeviceView, type KraftverkApi } from '@kraftverk/api-contract';
import { connectionId, savedDeviceId } from '@kraftverk/device-sdk';
import { plainSecrets, type SqlDatabase } from '@kraftverk/store';

import { createHolding, createHub, installedFrom, type Holding, type Hub } from '../src/index.ts';
import { APP_NODE, busDefinition, FakeBus, lampProtocol, lampType, MACHINE_NODE } from '../src/testing.ts';
import { testDatabase } from './home.ts';

/*
  An app holding a way for a server's home (docs/PLAN-SHARED-CORE.md, phase
  6): a server's hub in the process, asked as a person signed in on it, and
  an app beside it with a database of its own and a lamp on a bus only the
  app reaches — as a phone reaches a station over its own Bluetooth.
*/

const PERSON: Caller = { kind: 'person', name: 'olof', account: 'u-1' };
const NO_NETWORK = () => Promise.reject(new Error('no network here'));
/** One cipher the app and the server agree on, as the real ones do (`sealed:v1`): what one seals with a passphrase, the other opens with it. */
const sealing = {
  seal: async (passphrase: string, value: string) => `sealed:v1:${btoa(JSON.stringify([passphrase, value]))}`,
  open: async (passphrase: string, sealed: string) => {
    const [given, value] = JSON.parse(atob(sealed.slice('sealed:v1:'.length))) as [string, string];
    if (given !== passphrase) throw new Error('That passphrase does not open it');
    return value;
  },
};

/** What the app installs where it runs: the lamp, and a bus only it reaches. */
const appInstalled = (bus: FakeBus) =>
  installedFrom(
    { types: [{ type: lampType }], protocols: [lampProtocol], transports: [{ definition: { ...busDefinition, platforms: ['web'], discovery: { web: 'list' } }, create: () => bus }] },
    { platform: 'web', context: { env: {}, log: () => {}, audit: () => {} } }
  );

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
    { platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } }
  );
  const hub = createHub({ database, secrets: plainSecrets, sealing, installed, node: MACHINE_NODE, readOnly: () => false, http: NO_NETWORK });
  await hub.start();
  running.push(hub);
  return { hub, home: hub.as(PERSON) };
}

/** The app: its own database, its own bus with a lamp on it, holding for `home`. */
async function app(home: KraftverkApi, database: SqlDatabase = testDatabase(), bus = new FakeBus(), own?: SqlDatabase): Promise<{ holding: Holding; bus: FakeBus; database: SqlDatabase }> {
  if (!bus.lamps.size) bus.lamps.set('lamp-1', { serial: 'LAMP-1', model: 'L1', on: false, answers: true });
  const holding = createHolding({
    home,
    database,
    secrets: plainSecrets,
    installed: appInstalled(bus),
    node: APP_NODE,
    readOnly: () => false,
    http: NO_NETWORK,
    sendEveryMs: 60_000,
    log: () => {},
    ...(own ? { own: { database: own, sealing } } : {}),
  });
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
  const draft = await api.setup.start({ typeId: 'test.lamp', methodId: 'bus', holder: 'this-node' });
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
  expect(lamp.ways.filter((way) => way.holder === 'master')).toEqual([{ method: 'simulated', holder: 'master', fits: true, availability: { ok: true } }]);
  expect(lamp.ways).toContainEqual({ method: 'bus', holder: 'this-node', fits: true, availability: { ok: true } });
  // A simulator reaches nothing for this app to hold: with a server, the server holds it.
  expect(lamp.ways.some((way) => way.holder === 'this-node' && way.method === 'simulated')).toBe(false);
  expect((await holding.api.transports.list()).transports).toContainEqual(expect.objectContaining({ id: 'bus', holder: 'this-node', running: true }));
  // Who this app is, the server knows: it said so as it started.
  // The home's nodes: the machine, its master; this app, following it.
  expect((await home.nodes.list()).map((each) => [each.id, each.name, each.transports, each.master])).toEqual([
    [MACHINE_NODE.id, 'Test machine', [], true],
    [holding.nodeId, 'Chrome on a test', ['bus'], false],
  ]);
});

test('a way this app holds: set up here, judged and kept by the server, held here — its secret never sent — and what it says sent up', async () => {
  const { hub, home } = await server();
  const { holding, bus } = await app(home);
  const api = holding.api;

  const saved = await addLamp(api, bus);
  const way = saved.connections[0]!;
  expect(way.heldBy).toEqual({ kind: 'this-node', id: holding.nodeId, name: 'Chrome on a test' });
  expect(way.secrets).toEqual(['pin']);
  // The server keeps the device and knows which app holds its way — and never had the PIN.
  const there = await home.devices.get(saved.id);
  expect(there.connections[0]!.heldBy).toEqual({ kind: 'node', id: holding.nodeId, name: 'Chrome on a test' });
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
  expect(timeline.find((entry) => entry.kind === 'command.intent')).toMatchObject({ actor: 'olof', resource: saved.id, detail: { from: { node: holding.nodeId, name: 'Chrome on a test' } } });

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
  const me = await holding.join();
  const id = savedDeviceId('d-00000000ab01');
  const way = (overrides: Partial<ConnectionView>): ConnectionView => ({
    id: connectionId('c-00000000ab01'),
    method: 'bus',
    methodLabel: 'Bus',
    transport: 'bus',
    heldBy: { kind: 'node', id: me, name: 'Chrome on a test' },
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
      connections: [way({ id: connectionId('c-00000000ab00'), heldBy: { kind: 'master', id: MACHINE_NODE.id, name: 'Test machine' }, priority: 0, reachable: serverWayReachable }), way({})],
      links: [],
      tools: [],
      readings: [],
    health: { status: 'connected', detail: 'Connected', lastReadingAt: null, node: MACHINE_NODE.id, transport: 'bus' },
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

/** A home the app keeps itself, on its own database: the lamp on its bus with a PIN, a simulated one, a value set. */
async function ownHome(bus: FakeBus, copy?: SqlDatabase): Promise<{ hub: Hub; database: SqlDatabase }> {
  const database = testDatabase();
  const hub = createHub({ database, secrets: plainSecrets, sealing, installed: appInstalled(bus), node: APP_NODE, readOnly: () => false, http: NO_NETWORK, ...(copy ? { copy } : {}) });
  await hub.start();
  running.push(hub);
  return { hub, database };
}

test('a home this app kept itself moves to its server: the server keeps all of it, and the way near the device stays with this app, its key here', async () => {
  const { hub: there, home } = await server();
  const bus = new FakeBus();
  bus.lamps.set('lamp-1', { serial: 'LAMP-1', model: 'L1', on: false, answers: true });

  // Before it had a server: a lamp it reaches itself, a simulated one, how much is a load.
  const own = await ownHome(bus);
  const mine = own.hub.as({ kind: 'person', name: 'you' });
  bus.announce();
  const draft = await mine.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
  await mine.setup.choose(draft.id, { address: 'lamp-1' });
  await mine.setup.update(draft.id, { connection: { pin: '4321' } });
  expect((await mine.setup.check(draft.id)).outcome).toBe('new');
  await mine.setup.save(draft.id, { name: 'Desk lamp' });
  const simulated = await mine.setup.start({ typeId: 'test.lamp', methodId: 'simulated' });
  await mine.setup.check(simulated.id);
  await mine.setup.save(simulated.id, { name: 'Sim lamp' });
  await mine.policy.set('loadWatts', 30);
  await own.hub.stop();
  running = running.filter((each) => each !== own.hub);

  // A server added: what this app holds for it, with its own home beside it, offered.
  const { holding } = await app(home, testDatabase(), bus, own.database);
  const api = holding.api;
  expect(await api.configuration.elsewhere()).toEqual({ from: 'this-node', devices: 2, automations: 0 });
  const plan = await api.configuration.plan({ from: 'this-node' });
  expect(plan.problems).toEqual([]);
  expect(plan.devices.map((device) => [device.name, device.action]).sort()).toEqual([
    ['Desk lamp', 'add'],
    ['Sim lamp', 'add'],
  ]);
  expect(plan.notes).toContain('Desk lamp: Test bus stays with Chrome on a test, near it — your server keeps the device');
  await api.configuration.apply({ plan: plan.id! });

  // The server keeps both, and the home's values; the simulated one it holds, the lamp this app holds for it — its PIN never there.
  const kept = await home.devices.list();
  const desk = kept.find((device) => device.name === 'Desk lamp')!;
  expect(desk.connections).toEqual([expect.objectContaining({ method: 'bus', heldBy: { kind: 'node', id: holding.nodeId, name: 'Chrome on a test' } })]);
  expect(there.connections.secretFields(desk.connections[0]!.id)).toEqual([]);
  expect(kept.find((device) => device.name === 'Sim lamp')!.connections).toEqual([expect.objectContaining({ method: 'simulated', heldBy: { kind: 'master', id: MACHINE_NODE.id, name: 'Test machine' } })]);
  expect((await home.policy.list()).find((value) => value.name === 'loadWatts')?.value).toBe(30);
  // Held here, its key with it, and reached.
  expect(holding.connections.secret(desk.connections[0]!.id, 'pin')).toBe('4321');
  await until(async () => (await api.devices.get(desk.id)).readings.length > 0, 'the moved lamp read by this app');
  // Moved: not offered again.
  expect(await api.configuration.elsewhere()).toBeNull();
});

test('a home this app kept that the server has already, as it is: nothing to move, and not offered again', async () => {
  const { home } = await server();
  const own = await ownHome(new FakeBus());
  const mine = own.hub.as({ kind: 'person', name: 'you' });
  const simulated = await mine.setup.start({ typeId: 'test.lamp', methodId: 'simulated' });
  await mine.setup.check(simulated.id);
  await mine.setup.save(simulated.id, { name: 'Sim lamp' });
  // The server has it already: imported from the same file.
  const { text } = await mine.configuration.export({ secrets: 'none' });
  const first = await home.configuration.plan({ text });
  await home.configuration.apply({ plan: first.id! });
  await own.hub.stop();
  running = running.filter((each) => each !== own.hub);

  const { holding } = await app(home, testDatabase(), new FakeBus(), own.database);
  expect(await holding.api.configuration.elsewhere()).toEqual({ from: 'this-node', devices: 1, automations: 0 });
  const plan = await holding.api.configuration.plan({ from: 'this-node' });
  expect(plan.devices.map((device) => device.action)).toEqual(['same']);
  expect(await holding.api.configuration.elsewhere()).toBeNull();
});

test('a server let go of: the copy this app kept of its home becomes the app’s own, the way it held coming with its key', async () => {
  const { home } = await server();
  const copy = testDatabase();
  const { holding, bus } = await app(home, copy);
  const lamp = await addLamp(holding.api, bus);
  const simulated = await holding.api.setup.start({ typeId: 'test.lamp', methodId: 'simulated' });
  await holding.api.setup.check(simulated.id);
  await holding.api.setup.save(simulated.id, { name: 'Server lamp' });
  // What the app last heard of the server's home, its configuration among it.
  await holding.refresh();
  await holding.stop();
  running = running.filter((each) => each !== holding);

  // The app on its own again, the copy beside its home.
  const own = await ownHome(bus, copy);
  const api = own.hub.as({ kind: 'person', name: 'you' });
  expect(await api.configuration.elsewhere()).toEqual({ from: 'copy', devices: 2, automations: 0 });
  const plan = await api.configuration.plan({ from: 'copy' });
  expect(plan.problems).toEqual([]);
  await api.configuration.apply({ plan: plan.id! });

  const now = await api.devices.list();
  const desk = now.find((device) => device.name === 'Desk lamp')!;
  expect(desk.key).toBe(lamp.key);
  // Held by this node, the app's own home's master now.
  expect(desk.connections).toEqual([expect.objectContaining({ method: 'bus', heldBy: { kind: 'master', id: APP_NODE.id, name: 'Chrome on a test' } })]);
  expect(own.hub.connections.secret(desk.connections[0]!.id, 'pin')).toBe('4321');
  expect(now.find((device) => device.name === 'Server lamp')!.connections).toEqual([expect.objectContaining({ method: 'simulated' })]);
  await until(async () => (await api.devices.get(desk.id)).readings.length > 0, 'the kept lamp reached by the app itself');
  expect(await api.configuration.elsewhere()).toBeNull();
});
