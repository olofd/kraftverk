import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LiveUpdate } from '@kraftverk/api-contract';
import { savedDeviceId } from '@kraftverk/device-sdk';

import { ActionGateway } from '@kraftverk/gateway';
import { LiveBus } from '@kraftverk/holder';
import { corsOrigin, createApp } from './app.ts';
import { AutomationEngine, serverDevices } from './automations/engine.ts';
import { AutomationStore } from './automations/store.ts';
import { CLIENT_HEADER, SESSION_COOKIE } from './auth/routes.ts';
import { createFirstUser, createUser } from './auth/store.ts';
import { CLIENT_IP_HEADER, EXPOSURE_HEADER, ProxyDirectory } from './auth/trust.ts';
import { loadConfig } from './config.ts';
import { DeviceCatalog } from './devices/catalog.ts';
import { ClientStore } from './devices/clients.ts';
import { ConnectionStore } from './devices/connections.ts';
import { LinkStore } from './devices/links.ts';
import { Nearby } from './devices/nearby.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { RemoteReadings } from './devices/remote.ts';
import { DeviceSessionManager } from './devices/sessions.ts';
import { SetupService } from './devices/setup.ts';
import { EventStore } from './devices/events.ts';
import { busDefinition, FakeBus, lampProtocol, lampType } from './devices/testing.ts';
import { DeviceTypeRegistry } from './devices/types.ts';
import { audit, closeDb, db, openSecret } from './history/db.ts';
import { Sampler } from './history/sampler.ts';
import { originAllowed } from './routes/live.ts';
import { ProtocolRegistry } from './runtime/protocols.ts';
import { TransportHost } from './runtime/transports.ts';

/**
 * The server's routes, over HTTP, as the app and an attacker reach them.
 *
 * Two servers, built the way `index.ts` builds one. The *simulated* one has
 * every installed package — the P280, the plugs, the weather — and each device
 * is added to it the simulated way, so nothing reaches hardware or the network.
 * The *bus* one holds lamps on a pretend bus (`devices/testing.ts`), so the
 * paths that touch a device — finding it, checking who it is, claiming its
 * address, switching it — run for real.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-app-'));
const PASSWORD = 'correct horse battery staple';
const PROXY = '172.20.0.9';

type Server = {
  app: ReturnType<typeof createApp>['app'];
  websocket: ReturnType<typeof createApp>['websocket'];
  live: LiveBus;
  sessions: DeviceSessionManager;
  setup: SetupService;
  bus: FakeBus;
  close(): Promise<void>;
};

async function build(options: { installed: boolean; readOnly?: boolean }): Promise<Server> {
  const config = loadConfig({ NODE_ENV: 'test', READ_ONLY: options.readOnly ? '1' : '0' }, []);
  const bus = new FakeBus();
  const protocols = new ProtocolRegistry();
  const transports = new TransportHost({ context: { env: {}, log: () => {}, audit: () => {} } });
  const types = new DeviceTypeRegistry();
  if (options.installed) {
    await protocols.discover();
    await transports.discover();
    await types.discover();
  }
  protocols.install(lampProtocol);
  transports.install(busDefinition, { create: () => bus });
  types.install(lampType);
  // Only the bus: the installed transports would reach real radios and the network.
  await transports.startAll(['bus']);

  const catalog = new DeviceCatalog();
  const connections = new ConnectionStore();
  const links = new LinkStore();
  const clients = new ClientStore();
  const events = new EventStore();
  const live = new LiveBus();
  const sessions = new DeviceSessionManager({
    types,
    protocols,
    transports,
    connections,
    readOnly: config.readOnly,
    allowRawFrames: false,
    clientName: (id) => clients.get(id)?.name ?? null,
    // As the server wires it: what a device is and raises is kept.
    onDescribed: (deviceId, description, info) => catalog.describe(deviceId, description, info),
    onEvent: (deviceId, event) => events.record(deviceId, event),
    bus: live,
  });
  const remote = new RemoteReadings();
  const registry = new DeviceRegistry({ catalog, types, sessions, connections, links, clients, transports, remote });
  const setup = new SetupService({
    types,
    protocols,
    transports,
    catalog,
    connections,
    links,
    sessions,
    http: () => Promise.reject(new Error('no network in these tests')),
  });
  const nearby = new Nearby({ types, protocols, transports, connections });
  const gateway = new ActionGateway({
    device: (id) => {
      const record = catalog.active(id);
      return record ? { name: record.name, session: sessions.get(id), description: sessions.description(record), offline: sessions.health(record).detail } : null;
    },
    feeds: (id) => links.targetOf('feeds', id),
    isReadOnly: (id) => config.readOnly && !sessions.simulated(id),
    record: audit,
    policy: { verifyTimeoutMs: 300 },
  });
  const proxies = new ProxyDirectory(PROXY);
  await proxies.refresh();
  const automations = new AutomationStore();
  const engine = new AutomationEngine({ store: automations, device: serverDevices(catalog, sessions), gateway, record: audit });

  const { app, websocket } = createApp({
    config,
    catalog,
    connections,
    links,
    clients,
    types,
    protocols,
    transports,
    sessions,
    registry,
    setup,
    nearby,
    remote,
    gateway,
    events,
    bus: live,
    automations,
    engine,
    sampler: new Sampler(registry),
    proxies,
    serverLog: { dir: null, recent: () => [] },
    startedAt: new Date(),
  });
  return {
    app,
    websocket,
    live,
    sessions,
    setup,
    bus,
    close: async () => {
      setup.stop();
      nearby.stop();
      await sessions.closeAll();
      await transports.stopAll();
    },
  };
}

let simulated: Server;
let onBus: Server;

beforeAll(async () => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  simulated = await build({ installed: true });
  onBus = await build({ installed: false });
});

afterAll(async () => {
  await simulated.close();
  await onBus.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

type Call = { method?: string; body?: unknown; cookie?: string; from?: string; headers?: Record<string, string>; host?: string; server?: Server };

async function call(
  path: string,
  { method = 'GET', body, cookie, from = '192.168.1.58', headers = {}, host: hostHeader = '192.168.1.140:3333', server = simulated }: Call = {}
) {
  const response = await server.app.fetch(
    new Request(`http://${hostHeader}/api${path}`, {
      method,
      headers: {
        host: hostHeader,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { [CLIENT_HEADER]: 'test' } : {}),
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    { requestIP: () => ({ address: from }) }
  );
  const setCookie = response.headers.get('set-cookie') ?? '';
  const token = /kraftverk_session=([^;]*)/.exec(setCookie)?.[1] || undefined;
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body: json, text, headers: response.headers, token };
}

let session: string;

const login = async (username: string, server = simulated) =>
  (await call('/auth/login', { method: 'POST', body: { username, password: PASSWORD }, server })).token!;

beforeEach(async () => {
  db().exec('DELETE FROM device; DELETE FROM sample; DELETE FROM client; DELETE FROM users; DELETE FROM sessions; DELETE FROM app_state; DELETE FROM audit; DELETE FROM automation;');
  await simulated.sessions.sync([]);
  await onBus.sessions.sync([]);
  onBus.bus.lamps.clear();
  await createFirstUser('olof', PASSWORD);
  session = await login('olof');
});

const as = (path: string, options: Call = {}) => call(path, { cookie: session, ...options });
const onBusAs = (path: string, options: Call = {}) => as(path, { server: onBus, ...options });
const enc = encodeURIComponent;

/** A lamp on the bus, answering. */
const lampAt = (address: string, lamp: Partial<{ serial: string; model: string; on: boolean; answers: boolean }> = {}) => {
  onBus.bus.lamps.set(address, { serial: address.toUpperCase(), model: 'L1', on: true, answers: true, ...lamp });
  onBus.bus.announce();
};

/** Walks setup to the check step, and returns the draft and what the check found. */
async function checked(options: { typeId?: string; methodId?: string; address?: string; server?: Server } = {}) {
  const server = options.server ?? onBus;
  const methodId = options.methodId ?? (server === simulated ? 'simulated' : 'bus');
  const started = await as('/setup', { method: 'POST', body: { typeId: options.typeId ?? 'test.lamp', methodId }, server });
  expect(started.status).toBe(200);
  const id = started.body.id as string;
  // A simulated device has nothing to choose: there is only its simulator.
  if (started.body.plan.some((step: { kind: string }) => step.kind === 'choose')) {
    expect((await as(`/setup/${id}/choose`, { method: 'POST', body: { address: options.address ?? 'lamp-1' }, server })).status).toBe(200);
  }
  const check = await as(`/setup/${id}/check`, { method: 'POST', server });
  return { id, check: check.body };
}

async function added(name: string, options: Parameters<typeof checked>[0] = {}) {
  const server = options.server ?? onBus;
  const { id } = await checked(options);
  const saved = await as(`/setup/${id}/save`, { method: 'POST', body: { name }, server });
  expect(saved.status).toBe(200);
  return saved.body as { id: string; name: string; identity: string | null };
}

describe('everything needs a session', () => {
  test('every route answers 401 without one', async () => {
    for (const path of ['/devices', '/devices/removed', '/device-types', '/transports', '/found', '/audit', '/version', '/diagnostics/log', '/clients']) {
      expect((await call(path)).status).toBe(401);
    }
    expect((await call('/setup', { method: 'POST', body: { typeId: 'test.lamp' } })).status).toBe(401);
  });
});

describe('what can be added', () => {
  test('every installed type, by category, with how it can be reached and whether this server can', async () => {
    const { body } = await as('/device-types');
    expect(Object.keys(body.categories)).toEqual(['power-station', 'smart-plug', 'weather']);
    const p280 = body.types.find((type: { id: string }) => type.id === 'aferiy.p280');
    expect(p280.meta.category).toBe('power-station');
    // Its own ways, and simulated — which every type has, and a server can always hold.
    expect(p280.connections.map((method: { id: string }) => method.id)).toEqual(['wifi', 'bluetooth', 'simulated']);
    expect(p280.availability.simulated.server).toEqual({ ok: true });
    for (const id of ['tuya.plug', 'atorch.s1w', 'open-meteo.weather']) expect(body.types.map((type: { id: string }) => type.id)).toContain(id);
    // Declarations only: every function stays on the server.
    expect(JSON.stringify(body)).not.toContain('=>');
    expect(body.refused).toEqual({ types: [], protocols: [], transports: [] });
  });

  test('a method whose transport this server cannot use says why', async () => {
    const { body } = await onBusAs('/device-types');
    const lamp = body.types.find((type: { id: string }) => type.id === 'test.lamp');
    expect(lamp.availability.bus.server).toEqual({ ok: true });
  });
});

describe('adding a device', () => {
  test('simulated: a P280 is added with no hardware, by its own steps only, and opened as its simulator', async () => {
    const started = await as('/setup', { method: 'POST', body: { typeId: 'aferiy.p280', methodId: 'simulated' } });
    expect(started.status).toBe(200);
    // No protocol and no transport: nothing to prepare, nothing to choose.
    expect(started.body.plan.map((step: { kind: string }) => step.kind)).toEqual(['check']);

    const id = started.body.id;
    expect((await as(`/setup/${id}/check`, { method: 'POST' })).body.outcome).toBe('new');

    const saved = await as(`/setup/${id}/save`, { method: 'POST', body: { name: 'Garage P280' } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'Garage P280', typeId: 'aferiy.p280', connections: [expect.objectContaining({ method: 'simulated', transport: 'sim' })] });
    expect(simulated.sessions.get(savedDeviceId(saved.body.id))).not.toBeNull();
    const view = (await as(`/devices/${enc(saved.body.id)}`)).body;
    expect(view.connections[0]).toMatchObject({ methodLabel: 'Simulated', reachable: true, inUse: true });

    // The draft is gone, and the timeline says who added what.
    expect((await as(`/setup/${id}`)).status).toBe(404);
    const entries = (await as('/audit')).body as { kind: string; actor: string }[];
    expect(entries.find((entry) => entry.kind === 'device.added')?.actor).toBe('olof');
  });

  test('a lamp found on the bus is checked, told apart by its identity, and saved with what the check learnt', async () => {
    lampAt('lamp-1');
    const started = await onBusAs('/setup', { method: 'POST', body: { typeId: 'test.lamp', methodId: 'bus' } });
    // The transport's values fill the instructions: where to connect it.
    expect(started.body.plan[0]).toMatchObject({ kind: 'instructions', body: 'Connect it to bus.test.' });
    expect((await onBusAs(`/setup/${started.body.id}/sightings`)).body.sightings).toEqual([
      expect.objectContaining({ address: 'lamp-1', name: 'Lamp lamp-1', claimedBy: null }),
    ]);

    const lamp = await added('Hall lamp');
    expect(lamp.identity).toBe('lampish:LAMP-1');
    const view = (await onBusAs(`/devices/${enc(lamp.id)}`)).body;
    expect(view.config).toEqual({ room: 'Hall' });
    expect(view.connections[0]).toMatchObject({ method: 'bus', address: 'lamp-1', heldBy: { kind: 'server' } });
  });

  test('the same lamp again is yours: its address is marked, and it is not added twice', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const { id, check } = await checked();
    expect(check).toMatchObject({ outcome: 'yours', device: { id: lamp.id, name: 'Hall lamp' } });
    expect((await onBusAs(`/setup/${id}/sightings`)).body.sightings[0].claimedBy).toEqual({ id: lamp.id, name: 'Hall lamp' });
    expect((await onBusAs(`/setup/${id}/save`, { method: 'POST', body: { name: 'Again' } })).status).toBe(409);
  });

  test('a removed lamp is offered back, with its history', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    db().query('INSERT INTO sample (device_id, key, at, value) VALUES (?, ?, ?, ?)').run(lamp.id, 'on', new Date().toISOString(), 1);
    expect((await onBusAs(`/devices/${enc(lamp.id)}`, { method: 'DELETE' })).status).toBe(200);

    const { id, check } = await checked();
    expect(check).toMatchObject({ outcome: 'removed', identity: 'lampish:LAMP-1', devices: [expect.objectContaining({ id: lamp.id, name: 'Hall lamp' })] });
    const back = await onBusAs(`/setup/${id}/save`, { method: 'POST', body: { name: 'Hall lamp', mode: 'restore', deviceId: lamp.id } });
    expect(back.status).toBe(200);
    expect(back.body.id).toBe(lamp.id);
    expect(back.body.removedAt).toBeNull();
    expect(db().query<{ n: number }, [string]>('SELECT COUNT(*) n FROM sample WHERE device_id = ?').get(lamp.id)!.n).toBe(1);
  });

  test('another way to reach a device must reach that device', async () => {
    lampAt('lamp-1');
    lampAt('lamp-1b', { serial: 'LAMP-1' });
    lampAt('lamp-2');
    const lamp = await added('Hall lamp');

    const other = await checked({ methodId: 'backup', address: 'lamp-2' });
    expect(other.check.outcome).toBe('new');
    const refused = await onBusAs(`/setup/${other.id}/save`, { method: 'POST', body: { name: '', mode: 'attach', deviceId: lamp.id } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('different device');

    const same = await checked({ methodId: 'backup', address: 'lamp-1b' });
    expect(same.check.outcome).toBe('yours');
    const attached = await onBusAs(`/setup/${same.id}/save`, { method: 'POST', body: { name: '', mode: 'attach', deviceId: lamp.id } });
    expect(attached.status).toBe(200);
    expect(attached.body.connections.map((connection: { method: string }) => connection.method)).toEqual(['bus', 'backup']);
  });

  test('a model this type does not cover cannot be saved as it', async () => {
    lampAt('lamp-1', { model: 'X9' });
    const { id, check } = await checked();
    expect(check).toMatchObject({ outcome: 'other-model', model: 'X9', type: null });
    expect((await onBusAs(`/setup/${id}/save`, { method: 'POST', body: { name: 'Odd' } })).status).toBe(409);
  });

  test('a lamp that does not answer is saved only when asked to, and without an identity', async () => {
    lampAt('lamp-1', { answers: false });
    const { id, check } = await checked();
    expect(check).toMatchObject({ outcome: 'no-answer', saveAnyway: lampType.setup!.saveAnyway });
    expect((await onBusAs(`/setup/${id}/save`, { method: 'POST', body: { name: 'Dark' } })).status).toBe(409);
    const saved = await onBusAs(`/setup/${id}/save`, { method: 'POST', body: { name: 'Dark', anyway: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.identity).toBeNull();
  });

  test('an address typed by hand is normalised by the protocol, or refused', async () => {
    const started = await onBusAs('/setup', { method: 'POST', body: { typeId: 'test.lamp', methodId: 'bus' } });
    expect((await onBusAs(`/setup/${started.body.id}/choose`, { method: 'POST', body: { manual: 'Lamp 5!' } })).status).toBe(400);
    const chosen = await onBusAs(`/setup/${started.body.id}/choose`, { method: 'POST', body: { manual: '  lamp-5 ' } });
    expect(chosen.body.address).toBe('lamp-5');
  });

  test('a secret a step finds never reaches the browser, is stored sealed, and a placeholder is only good for its draft', async () => {
    lampAt('lamp-1');
    const started = await onBusAs('/setup', { method: 'POST', body: { typeId: 'test.lamp', methodId: 'bus' } });
    const id = started.body.id;
    const found = await onBusAs(`/setup/${id}/steps/credentials/actions/fetch`, { method: 'POST', body: {} });
    expect(found.status).toBe(200);
    expect(found.text).not.toContain('the-real-secret-value');
    const pin = found.body.choices[0].config.pin as string;
    expect(pin).toStartWith('held:');

    expect((await onBusAs(`/setup/${id}`, { method: 'PATCH', body: { connection: { pin: 'held:0000000000000000' } } })).status).toBe(400);
    const updated = await onBusAs(`/setup/${id}`, { method: 'PATCH', body: { connection: { pin } } });
    expect(updated.body.secrets).toEqual(['pin']);
    expect(updated.text).not.toContain('the-real-secret-value');

    await onBusAs(`/setup/${id}/choose`, { method: 'POST', body: { address: 'lamp-1' } });
    await onBusAs(`/setup/${id}/check`, { method: 'POST' });
    const saved = await onBusAs(`/setup/${id}/save`, { method: 'POST', body: { name: 'Keyed' } });
    expect(saved.body.connections[0].secrets).toEqual(['pin']);
    expect(saved.text).not.toContain('the-real-secret-value');
    const row = db()
      .query<{ value: string; encrypted: number }, [string]>('SELECT value, encrypted FROM connection_secret WHERE connection_id = ?')
      .get(saved.body.connections[0].id)!;
    expect(openSecret(row.value, row.encrypted === 1)).toBe('the-real-secret-value');
  });

  test('a draft is only its own account’s, and nothing unknown is set up', async () => {
    await createUser('guest', PASSWORD, 'olof');
    const guest = await login('guest', onBus);
    const started = await onBusAs('/setup', { method: 'POST', body: { typeId: 'test.lamp', methodId: 'bus' } });
    expect((await call(`/setup/${started.body.id}`, { cookie: guest, server: onBus })).status).toBe(404);

    expect((await onBusAs('/setup', { method: 'POST', body: { typeId: 'nobody.knows' } })).status).toBe(404);
    expect((await onBusAs('/setup', { method: 'POST', body: { typeId: 'test.lamp', methodId: 'carrier-pigeon' } })).status).toBe(400);
    // Saving before the check says what is missing.
    expect((await onBusAs(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: 'x' } })).status).toBe(400);
  });
});

describe('a device you have', () => {
  test('is renamed, and nothing else about it is changed through that route', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const path = `/devices/${enc(lamp.id)}`;
    expect((await onBusAs(path, { method: 'PATCH', body: { typeId: 'aferiy.p280' } })).status).toBe(400);
    expect((await onBusAs(path, { method: 'PATCH', body: { name: 'Shed' } })).body.name).toBe('Shed');
  });

  test('an id with a percent sign is a 404, not a 500', async () => {
    expect((await as('/devices/abc%25def')).status).toBe(404);
    expect((await as('/devices/abc%25def/history?key=soc')).status).toBe(404);
  });

  test('removing keeps its history; deleting it takes the name typed back', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const path = `/devices/${enc(lamp.id)}`;
    expect((await onBusAs(`${path}/delete-history`, { method: 'POST', body: { name: 'Hall lamp' } })).status).toBe(409);
    await onBusAs(path, { method: 'DELETE' });

    expect((await onBusAs('/devices')).body.devices).toEqual([]);
    expect((await onBusAs('/devices/removed')).body.devices.map((device: { id: string }) => device.id)).toEqual([lamp.id]);
    expect((await onBusAs(`${path}/history?key=on`)).status).toBe(200);

    expect((await onBusAs(`${path}/delete-history`, { method: 'POST', body: { name: 'hall' } })).status).toBe(400);
    expect((await onBusAs(`${path}/delete-history`, { method: 'POST', body: { name: 'Hall lamp' } })).status).toBe(200);
    expect((await onBusAs(path)).status).toBe(404);
    const entries = (await onBusAs('/audit')).body as { kind: string }[];
    expect(entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['device.removed', 'device.history-deleted']));
  });

  test('a command to a part goes through the gateway, and switches the lamp', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    await new Promise((resolve) => setTimeout(resolve, 30)); // its first reading
    const commands = `/devices/${enc(lamp.id)}/parts/main/commands`;
    const result = await onBusAs(`${commands}/switch/set`, { method: 'POST', body: { args: { on: false } } });
    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe('verified');
    expect(onBus.bus.lamps.get('lamp-1')!.on).toBe(false);
    expect((await onBusAs(`${commands}/teleport/set`, { method: 'POST', body: { args: { on: true } } })).status).toBe(404);
    expect((await onBusAs(`${commands}/battery/set`, { method: 'POST', body: { args: { on: true } } })).status).toBe(409);
    expect((await onBusAs(`${commands}/switch/explode`, { method: 'POST', body: { args: { on: true } } })).status).toBe(409);
    expect((await onBusAs(`/devices/${enc(lamp.id)}/parts/outlet.z/commands/switch/set`, { method: 'POST', body: { args: { on: true } } })).status).toBe(409);
  });

  test('a device is served with its description, and what it offers comes from its parts', async () => {
    const station = await added('Garage P280', { server: simulated, typeId: 'aferiy.p280' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const view = (await as(`/devices/${enc(station.id)}`)).body;
    const parts = view.description.parts.map((part: { id: string }) => part.id);
    expect(parts).toEqual(expect.arrayContaining(['main', 'input.ac', 'outlet.ac', 'pack.1']));
    expect(view.capabilities).toEqual(expect.arrayContaining(['battery', 'acInput', 'switch', 'powerMeter']));
    expect(view.info).toMatchObject({ manufacturer: 'AFERIY' });
    // The pack the simulator reports is kept with the device, so its history keeps its name —
    // recorded on the holder's next check, which runs every little while.
    await simulated.sessions.check();
    const kept = db().query<{ key: string }, [string]>("SELECT key FROM device_attribute WHERE device_id = ? AND part = 'pack.1'").all(station.id);
    expect(kept.map((row) => row.key)).toEqual(['pack.1.soc']);
    expect((await as(`/devices/${enc(station.id)}/events`)).body).toEqual({ events: [] });
  });

  test('cutting mains to a station a plug feeds asks for confirmation, naming the station', async () => {
    const plug = await added('Heater plug', { server: simulated, typeId: 'atorch.s1w' });
    const station = await added('Garage P280', { server: simulated, typeId: 'aferiy.p280' });
    await as('/links', { method: 'POST', body: { kind: 'feeds', sourceId: plug.id, targetId: station.id } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refused = await as(`/devices/${enc(plug.id)}/parts/main/commands/switch/set`, { method: 'POST', body: { args: { on: false } } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ outcome: 'refused', needsConfirmation: true });
    expect(refused.body.detail).toContain('Garage P280');
  });

  test('its type’s tools: a read is a GET, a write is a POST and is audited, refusals too', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const base = `/devices/${enc(lamp.id)}/advanced`;
    expect((await onBusAs(`${base}/ping`)).body).toEqual({ pong: true, room: 'Hall' });
    expect((await onBusAs(`${base}/blink`)).status).toBe(405);
    expect((await onBusAs(`${base}/nothing`)).status).toBe(404);
    expect((await onBusAs(`${base}/blink`, { method: 'POST', body: { times: 2 } })).body).toEqual({ blinked: 2 });
    const refused = await onBusAs(`${base}/blink`, { method: 'POST', body: { times: 99 } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('overheat');
    const kinds = ((await onBusAs('/audit')).body as { kind: string; actor: string }[]).filter((entry) => entry.kind.startsWith('device.advanced'));
    expect(kinds.map((entry) => entry.kind).sort()).toEqual(['device.advanced', 'device.advanced-refused']);
    expect(kinds.every((entry) => entry.actor === 'olof')).toBe(true);
  });

  test('a read-only server refuses a tool that writes to hardware before it runs; a simulated device has none', async () => {
    const readOnly = await build({ installed: false, readOnly: true });
    try {
      readOnly.bus.lamps.set('lamp-1', { serial: 'LAMP-1', model: 'L1', on: true, answers: true });
      const real = await added('Real lamp', { server: readOnly, address: 'lamp-1' });
      expect((await as(`/devices/${enc(real.id)}/advanced/blink`, { method: 'POST', body: {}, server: readOnly })).status).toBe(423);
      expect((await as(`/devices/${enc(real.id)}/parts/main/commands/switch/set`, { method: 'POST', body: { args: { on: false } }, server: readOnly })).status).toBe(409);

      const pretend = await added('Pretend lamp', { server: readOnly, methodId: 'simulated' });
      expect((await as(`/devices/${enc(pretend.id)}/advanced/blink`, { method: 'POST', body: {}, server: readOnly })).status).toBe(200);
      expect((await as(`/devices/${enc(pretend.id)}/parts/main/commands/switch/set`, { method: 'POST', body: { args: { on: false } }, server: readOnly })).status).toBe(200);
    } finally {
      await readOnly.close();
    }
  });
});

describe('connections and links', () => {
  test('the last way to reach a device cannot be removed; another can, and can be preferred', async () => {
    lampAt('lamp-1');
    lampAt('lamp-1b', { serial: 'LAMP-1' });
    const lamp = await added('Hall lamp');
    const base = `/devices/${enc(lamp.id)}/connections`;
    const only = (await onBusAs(`/devices/${enc(lamp.id)}`)).body.connections[0].id;
    expect((await onBusAs(`${base}/${only}`, { method: 'DELETE' })).status).toBe(409);

    const second = await checked({ methodId: 'backup', address: 'lamp-1b' });
    await onBusAs(`/setup/${second.id}/save`, { method: 'POST', body: { name: '', mode: 'attach', deviceId: lamp.id } });
    const backup = (await onBusAs(`/devices/${enc(lamp.id)}`)).body.connections[1].id;
    const preferred = await onBusAs(`${base}/${backup}/prefer`, { method: 'POST' });
    expect(preferred.body.connections[0]).toMatchObject({ id: backup, inUse: true });
    expect((await onBusAs(`${base}/${only}`, { method: 'DELETE' })).body.connections.map((c: { id: string }) => c.id)).toEqual([backup]);
  });

  test('secrets are replaced write-only, and only fields that are secrets', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const connection = (await onBusAs(`/devices/${enc(lamp.id)}`)).body.connections[0].id;
    const path = `/devices/${enc(lamp.id)}/connections/${connection}/secrets`;
    expect((await onBusAs(path, { method: 'PUT', body: { room: 'x' } })).status).toBe(400);
    const changed = await onBusAs(path, { method: 'PUT', body: { pin: '4321' } });
    expect(changed.body.connections[0].secrets).toEqual(['pin']);
    expect(changed.text).not.toContain('4321');
  });

  test('a plug feeds a station, and not the other way round', async () => {
    const plug = await added('Heater plug', { server: simulated, typeId: 'atorch.s1w' });
    const station = await added('Garage P280', { server: simulated, typeId: 'aferiy.p280' });

    expect((await as('/links', { method: 'POST', body: { kind: 'feeds', sourceId: station.id, targetId: plug.id } })).status).toBe(400);
    const link = await as('/links', { method: 'POST', body: { kind: 'feeds', sourceId: plug.id, targetId: station.id } });
    expect(link.status).toBe(200);
    expect((await as(`/devices/${enc(station.id)}`)).body.links).toEqual([expect.objectContaining({ kind: 'feeds', role: 'target', other: { id: plug.id, name: 'Heater plug' } })]);
    expect((await as(`/links/${link.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await as(`/devices/${enc(station.id)}`)).body.links).toEqual([]);
  });
});

describe('a connection a browser holds', () => {
  const browser = async () =>
    (await onBusAs('/clients', { method: 'POST', body: { name: 'Olof’s laptop', platform: 'web', transports: ['bus'] } })).body as { id: string };

  const heldSetup = async (clientId: string, identified: unknown, extra: Record<string, unknown> = {}) =>
    onBusAs('/setup/app', {
      method: 'POST',
      body: { clientId, typeId: 'test.lamp', methodId: 'bus', address: 'browser-handle-1', identified, device: { room: 'Desk' }, ...extra },
    });

  test('is saved from what the app learnt, held by it, with no secret on the server', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'lampish:DESK', model: 'L1', summary: 'It is on.' }, { connection: { pin: 'never-here' } });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ heldBy: client.id, checked: { outcome: 'new', identity: 'lampish:DESK' } });

    const saved = await onBusAs(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: 'Desk lamp' } });
    expect(saved.status).toBe(200);
    expect(saved.body.connections).toEqual([expect.objectContaining({ heldBy: { kind: 'client', id: client.id, name: 'Olof’s laptop' }, secrets: [] })]);
    expect(saved.text).not.toContain('never-here');
    // The server does not hold it, and says who does.
    expect(saved.body.health.detail).toBe('Held by Olof’s laptop, not by this server');
  });

  test('sends its readings: live ones are the device’s state, queued ones become history', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'lampish:DESK', model: 'L1', summary: 'On.' });
    const device = (await onBusAs(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: 'Desk lamp' } })).body;
    const connectionId = device.connections[0].id;

    const past = new Date(Date.now() - 3_600_000).toISOString();
    const sent = await onBusAs(`/devices/${enc(device.id)}/readings`, {
      method: 'POST',
      body: { clientId: client.id, connectionId, readings: [{ key: 'on', value: true, at: new Date().toISOString() }, { key: 'on', value: false, at: past }] },
    });
    expect(sent.body).toEqual({ live: 1, history: 1, refused: 0 });

    const view = (await onBusAs(`/devices/${enc(device.id)}`)).body;
    expect(view.readings).toEqual([expect.objectContaining({ key: 'on', value: true })]);
    expect(view.health).toMatchObject({ status: 'connected', detail: 'Connected through Olof’s laptop', owner: 'client' });
    expect(view.connections[0].inUse).toBe(true);
    expect(db().query<{ n: number }, [string]>('SELECT COUNT(*) n FROM sample WHERE device_id = ?').get(device.id)!.n).toBe(1);
  });

  test('a device saved before it answered learns who it is from the app, and a different device adds nothing', async () => {
    const client = await browser();
    // A browser cannot always read an identity during setup: saved without one.
    const started = await heldSetup(client.id, { identity: null, model: 'L1', summary: 'On.' });
    const device = (await onBusAs(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: 'Desk lamp' } })).body;
    const connectionId = device.connections[0].id;
    const identity = () => db().query<{ identity: string | null }, [string]>('SELECT identity FROM device WHERE id = ?').get(device.id)!.identity;
    const send = (said: string) =>
      onBusAs(`/devices/${enc(device.id)}/readings`, {
        method: 'POST',
        body: { clientId: client.id, connectionId, identity: said, readings: [{ key: 'on', value: true, at: new Date().toISOString() }] },
      });
    expect(identity()).toBeNull();

    expect((await send('lampish:DESK')).status).toBe(200);
    expect(identity()).toBe('lampish:DESK');

    const other = await send('lampish:ELSEWHERE');
    expect(other.status).toBe(409);
    expect(identity()).toBe('lampish:DESK');
  });

  test('speaks only for its own connections, and only for its own account', async () => {
    const client = await browser();
    lampAt('lamp-1');
    const serverHeld = await added('Hall lamp');
    const connectionId = (await onBusAs(`/devices/${enc(serverHeld.id)}`)).body.connections[0].id;
    const reading = { key: 'on', value: true, at: new Date().toISOString() };

    // A connection this server holds is not the app's to report on.
    expect((await onBusAs(`/devices/${enc(serverHeld.id)}/readings`, { method: 'POST', body: { clientId: client.id, connectionId, readings: [reading] } })).status).toBe(403);

    await createUser('guest', PASSWORD, 'olof');
    const guest = await login('guest', onBus);
    const other = await call('/setup/app', {
      method: 'POST',
      cookie: guest,
      server: onBus,
      body: { clientId: client.id, typeId: 'test.lamp', methodId: 'bus', address: 'x', identified: null },
    });
    expect(other.status).toBe(404);
  });

  test('a browser that cannot tell which station it reached attaches on the person’s word', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const client = await browser();
    const started = await heldSetup(client.id, { identity: null, model: 'L1', summary: 'On.' }, { methodId: 'backup' });
    expect(started.body.checked).toMatchObject({ outcome: 'new', identity: null });
    const attached = await onBusAs(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: '', mode: 'attach', deviceId: lamp.id } });
    expect(attached.status).toBe(200);
    expect(attached.body.connections.map((connection: { heldBy: { kind: string } }) => connection.heldBy.kind)).toEqual(['server', 'client']);
  });

  test('the reachable connection highest in the list is in use: the app takes over while the server cannot reach it, and gives it back', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const client = await browser();
    const started = await heldSetup(client.id, { identity: null, model: 'L1', summary: 'On.' }, { methodId: 'backup' });
    const attached = (await onBusAs(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: '', mode: 'attach', deviceId: lamp.id } })).body;
    const [serverSide, appSide] = attached.connections as { id: string }[];
    const view = async () => (await onBusAs(`/devices/${enc(lamp.id)}`)).body as { readings: { key: string; value: unknown }[]; connections: { id: string; inUse: boolean; reachable: boolean | null }[] };
    const fromApp = () =>
      onBusAs(`/devices/${enc(lamp.id)}/readings`, {
        method: 'POST',
        body: { clientId: client.id, connectionId: appSide!.id, readings: [{ key: 'on', value: false, at: new Date().toISOString() }] },
      });
    const inUse = async () => (await view()).connections.find((connection) => connection.inUse)?.id;

    // Both reach it: the server's is higher in the list, so it is the one in use.
    await fromApp();
    expect(await inUse()).toBe(serverSide!.id);
    expect((await view()).connections.map((connection) => connection.reachable)).toEqual([true, true]);

    // The server loses it: the app's connection takes over, and its readings are the device's.
    const channel = onBus.bus.channels.at(-1)!;
    channel.setConnected(false);
    await fromApp();
    expect(await inUse()).toBe(appSide!.id);
    expect((await view()).readings).toEqual([expect.objectContaining({ key: 'on', value: false })]);

    // It comes back: the server's connection is in use again.
    channel.setConnected(true);
    expect(await inUse()).toBe(serverSide!.id);
  });

  test('keeps the device’s store on the server, and its audit entries under the account', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'lampish:DESK', model: 'L1', summary: 'On.' });
    const device = (await onBusAs(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: 'Desk lamp' } })).body;
    const connectionId = device.connections[0].id;

    await onBusAs(`/devices/${enc(device.id)}/store/brightness`, { method: 'PUT', body: { clientId: client.id, connectionId, value: 80 } });
    expect((await onBusAs(`/devices/${enc(device.id)}/store`)).body.values).toEqual({ brightness: 80 });

    const recorded = await onBusAs(`/clients/${client.id}/audit`, {
      method: 'POST',
      body: { entries: [{ at: new Date().toISOString(), kind: 'command.verified', resource: device.id, summary: 'Desk lamp: switched off' }] },
    });
    expect(recorded.body).toEqual({ recorded: 1 });
    const entry = ((await onBusAs('/audit')).body as { kind: string; actor: string; detail: { from: { name: string } } }[]).find((e) => e.kind === 'command.verified');
    expect(entry).toMatchObject({ actor: 'olof', detail: { from: { name: 'Olof’s laptop' } } });
  });
});

describe('phones and browsers', () => {
  test('register, are listed for their own account only, and can be forgotten', async () => {
    const registered = await as('/clients', { method: 'POST', body: { name: 'Olof’s iPhone', platform: 'native', transports: ['ble'] } });
    expect(registered.status).toBe(200);
    expect((await as('/clients')).body.clients.map((client: { name: string }) => client.name)).toEqual(['Olof’s iPhone']);

    await createUser('guest', PASSWORD, 'olof');
    const guest = await login('guest');
    expect((await call('/clients', { cookie: guest })).body.clients).toEqual([]);
    // Nor can another account claim this phone's id.
    const claimed = await call('/clients', { method: 'POST', cookie: guest, body: { id: registered.body.id, name: 'Mine now', platform: 'web', transports: [] } });
    expect(claimed.body.id).not.toBe(registered.body.id);
    expect((await call(`/clients/${registered.body.id}`, { method: 'DELETE', cookie: guest })).status).toBe(404);

    expect((await as(`/clients/${registered.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await as('/clients')).body.clients).toEqual([]);
  });
});

describe('settings, through the gateway', () => {
  test('a setting is written, read back and audited; one that can damage the hardware is confirmed first', async () => {
    const station = await added('Garage P280', { server: simulated, typeId: 'aferiy.p280' });
    const path = `/devices/${enc(station.id)}/attributes`;

    const led = await as(path, { method: 'PATCH', body: { patch: { ledMode: 'sos' } } });
    expect(led.status).toBe(200);
    expect(led.body).toMatchObject({ outcome: 'verified', values: expect.objectContaining({ ledMode: 'sos' }) });

    const unknown = await as(path, { method: 'PATCH', body: { patch: { turbo: true } } });
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ outcome: 'refused', detail: 'No such setting: turbo' });
    // What it reports is not something it can be told.
    expect((await as(path, { method: 'PATCH', body: { patch: { soc: 100 } } })).body).toMatchObject({ outcome: 'refused', detail: 'No such setting: soc' });

    const risky = await as(path, { method: 'PATCH', body: { patch: { sleepMinutes: '480' } } });
    expect(risky.status).toBe(409);
    expect(risky.body.needsConfirmation).toBe(true);
    const confirmed = await as(path, { method: 'PATCH', body: { patch: { sleepMinutes: '480' }, confirmation: 'confirm' } });
    expect(confirmed.body.outcome).toBe('verified');

    const kinds = ((await as('/audit')).body as { kind: string; actor: string }[]).map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(['settings.intent', 'settings.verified', 'settings.refused']));
  });
});

describe('automations', () => {
  /** A weather service and a plug, simulated: what "if tomorrow is sunny, turn the plug on" needs. */
  const weatherAndPlug = async () => {
    const started = await as('/setup', { method: 'POST', body: { typeId: 'open-meteo.weather', methodId: 'simulated' } });
    await as(`/setup/${started.body.id}`, { method: 'PATCH', body: { device: { place: 'Home', latitude: 59.3, longitude: 18.1 } } });
    await as(`/setup/${started.body.id}/check`, { method: 'POST' });
    const weather = (await as(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: 'Weather' } })).body as { id: string };
    const plug = await added('Heater plug', { server: simulated, typeId: 'atorch.s1w' });
    return { weather, plug };
  };
  const whole = (device: { id: string }) => ({ device: device.id, part: 'main' });
  const make = (roles: Record<string, { device: string; part: string }>) =>
    as('/automations', {
      method: 'POST',
      body: { name: 'Sunny heater', recipe: 'forecast-switch', roles, params: { day: 'tomorrow', at: '07:00' }, timeZone: 'Europe/Stockholm' },
    });

  test('lists its recipes, with the roles each needs', async () => {
    const { recipes } = (await as('/automations/recipes')).body;
    expect(recipes).toEqual([expect.objectContaining({ id: 'forecast-switch', roles: expect.objectContaining({ forecast: expect.objectContaining({ capabilities: ['weather.forecast'] }) }) })]);
  });

  test('a role takes only a device that fits it', async () => {
    const { weather, plug } = await weatherAndPlug();
    const wrong = await make({ forecast: whole(plug), switch: whole(weather) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('cannot do that');
  });

  test('is made observing, says what it does, and is armed only when confirmed', async () => {
    const { weather, plug } = await weatherAndPlug();
    const created = await make({ forecast: whole(weather), switch: whole(plug) });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ mode: 'observe', problems: [], sentence: 'At 07:00, if tomorrow looks sunny by Weather, turn Heater plug on.' });
    const path = `/automations/${created.body.id}`;

    const unconfirmed = await as(path, { method: 'PATCH', body: { mode: 'armed' } });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.needsConfirmation).toBe(true);
    expect((await as(path, { method: 'PATCH', body: { mode: 'armed', confirmation: 'confirm' } })).body.mode).toBe('armed');
    // Changing what an armed one does is confirmed again.
    expect((await as(path, { method: 'PATCH', body: { params: { day: 'today', at: '08:00' } } })).status).toBe(409);

    const audit = (await as('/audit')).body as { kind: string; actor: string }[];
    expect(audit.find((entry) => entry.kind === 'automation.armed')).toMatchObject({ actor: 'olof' });
  });

  test('checks what it would do now without doing it, and is deleted', async () => {
    const { weather, plug } = await weatherAndPlug();
    const created = (await make({ forecast: whole(weather), switch: whole(plug) })).body;
    const check = await as(`/automations/${created.id}/check`, { method: 'POST' });
    expect(check.status).toBe(200);
    expect(['would-act', 'idle']).toContain(check.body.outcome);
    expect((await as(`/automations/${created.id}`)).status).toBe(404); // no GET by id: the list is the view
    expect((await as(`/automations/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await as('/automations')).body.automations).toEqual([]);
  });

  test('one outlet of a station fills the switch role, and only a part it has that can switch', async () => {
    const started = await as('/setup', { method: 'POST', body: { typeId: 'open-meteo.weather', methodId: 'simulated' } });
    await as(`/setup/${started.body.id}`, { method: 'PATCH', body: { device: { place: 'Home', latitude: 59.3, longitude: 18.1 } } });
    await as(`/setup/${started.body.id}/check`, { method: 'POST' });
    const weather = (await as(`/setup/${started.body.id}/save`, { method: 'POST', body: { name: 'Weather' } })).body as { id: string };
    const station = await added('Garage P280', { server: simulated, typeId: 'aferiy.p280' });
    const make = (part: string) =>
      as('/automations', {
        method: 'POST',
        body: {
          name: 'Sunny lights',
          recipe: 'forecast-switch',
          roles: { forecast: { device: weather.id, part: 'main' }, switch: { device: station.id, part } },
          params: { day: 'today' },
          timeZone: 'Europe/Stockholm',
        },
      });

    expect((await make('main')).body.error).toContain('cannot do that');
    expect((await make('outlet.garage-door')).body.error).toContain('has no part');
    const made = await make('outlet.dc');
    expect(made.status).toBe(200);
    expect(made.body.sentence).toContain("Garage P280's 12V DC / car port");
  });

  test('says when a device it uses has been removed', async () => {
    const { weather, plug } = await weatherAndPlug();
    await make({ forecast: whole(weather), switch: whole(plug) });
    await as(`/devices/${enc(plug.id)}`, { method: 'DELETE' });
    const [automation] = (await as('/automations')).body.automations;
    expect(automation.problems).toEqual(['What to switch: Heater plug has been removed']);
  });
});

describe('the live stream', () => {
  /** The app, served for real — a socket cannot be opened through `app.fetch` alone. */
  const serve = (server: Server) =>
    Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request, bun) => server.app.fetch(request, bun), websocket: server.websocket as never });

  /** Opens `/api/live`, and collects what it says. Resolves once it has said hello, or rejects when refused. */
  const open = (port: number, headers: Record<string, string>) =>
    new Promise<{ socket: WebSocket; updates: LiveUpdate[] }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers } as never);
      const updates: LiveUpdate[] = [];
      socket.onmessage = (message) => {
        const update = JSON.parse(String(message.data)) as LiveUpdate;
        updates.push(update);
        if (update.type === 'hello') resolve({ socket, updates });
      };
      socket.onerror = () => reject(new Error('refused'));
      socket.onclose = () => reject(new Error('closed'));
    });

  const until = async (check: () => boolean, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  test('says hello, then what changed: a device added, and its readings as they move', async () => {
    const http = serve(simulated);
    try {
      const { socket, updates } = await open(http.port!, { cookie: `${SESSION_COOKIE}=${session}` });
      const lamp = await added('Pretend lamp', { server: simulated, methodId: 'simulated' });
      await until(() => updates.some((update) => update.type === 'changed'));
      await until(() => updates.some((update) => update.type === 'readings' && update.deviceId === lamp.id));
      const readings = updates.find((update) => update.type === 'readings' && update.deviceId === lamp.id);
      expect(readings).toMatchObject({ readings: [expect.objectContaining({ key: 'on', value: true })] });
      await until(() => updates.some((update) => update.type === 'health' && update.deviceId === lamp.id));

      // Switched through the gateway: the stream says so; no list to read again for it.
      const before = updates.length;
      expect((await as(`/devices/${enc(lamp.id)}/parts/main/commands/switch/set`, { method: 'POST', body: { args: { on: false } } })).status).toBe(200);
      await until(() => updates.slice(before).some((update) => update.type === 'readings' && update.deviceId === lamp.id && update.readings[0]?.value === false));
      expect(updates.slice(before).some((update) => update.type === 'changed')).toBe(false);
      socket.close();
    } finally {
      http.stop(true);
    }
  });

  test('is refused without a session, and to a page on another website', async () => {
    const http = serve(simulated);
    try {
      await expect(open(http.port!, {})).rejects.toThrow();
      await expect(open(http.port!, { cookie: `${SESSION_COOKIE}=${session}`, origin: 'https://evil.example' })).rejects.toThrow();
      // This server's own app, and the native app (no Origin), are let in.
      const own = await open(http.port!, { cookie: `${SESSION_COOKIE}=${session}`, origin: `http://127.0.0.1:${http.port}` });
      own.socket.close();
    } finally {
      http.stop(true);
    }
  });

  test('a browser page may open it from this server’s own names only', () => {
    const cors = corsOrigin({ allowedOrigins: ['https://app.example.test'], development: false });
    const deps = { config: { allowedHosts: new Set(['home.example.test']) } } as never;
    expect(originAllowed(undefined, '192.0.2.10:8080', deps, cors)).toBe(true);
    expect(originAllowed('http://192.0.2.10:8080', '192.0.2.10:8080', deps, cors)).toBe(true);
    expect(originAllowed('https://home.example.test', 'kraftverk:3333', deps, cors)).toBe(true);
    expect(originAllowed('https://app.example.test', 'kraftverk:3333', deps, cors)).toBe(true);
    expect(originAllowed('https://evil.example', '192.0.2.10:8080', deps, cors)).toBe(false);
    expect(originAllowed('not a url', '192.0.2.10:8080', deps, cors)).toBe(false);
  });
});

describe('the server', () => {
  test('says what it is running as', async () => {
    const version = (await as('/version')).body;
    expect(version).toMatchObject({ readOnly: false });
    // Which transports to use is not the server's setting: every installed one is available.
    expect(version.simulate).toBeUndefined();
    expect(version.transports).toBeUndefined();
  });

  test('lists its transports, and what they can see that nothing you have is reached by', async () => {
    lampAt('lamp-1');
    lampAt('lamp-2');
    const transports = (await onBusAs('/transports')).body;
    expect(transports.transports).toEqual([expect.objectContaining({ id: 'bus', running: true, availability: { ok: true } })]);

    await onBusAs('/found'); // starts watching
    const found = (await onBusAs('/found')).body.found;
    expect(found.map((entry: { address: string }) => entry.address).sort()).toEqual(['lamp-1', 'lamp-2']);
    // Each way it could be added as: the type, by each method that reaches it.
    expect(found[0].types.map((type: { methodId: string }) => type.methodId)).toEqual(['bus', 'backup']);

    await added('Hall lamp');
    expect((await onBusAs('/found')).body.found.map((entry: { address: string }) => entry.address)).toEqual(['lamp-2']);
  });
});

describe('browsers from elsewhere', () => {
  const preflight = (origin: string) => call('/devices', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });

  test('another web app on the same box gets no credentialed access', async () => {
    for (const origin of ['http://192.168.1.140:5000', 'http://192.168.1.140', 'http://diskstation.local:5001', 'https://evil.example']) {
      expect((await preflight(origin)).headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('the Expo dev server is allowed in development, and nothing but named origins in production', () => {
    const development = corsOrigin({ allowedOrigins: [], development: true });
    expect(development('http://localhost:8081')).toBe('http://localhost:8081');
    expect(development('http://192.168.1.58:8081')).toBe('http://192.168.1.58:8081');
    expect(development('http://192.168.1.58:5000')).toBeNull();

    const production = corsOrigin({ allowedOrigins: ['https://app.example.test'], development: false });
    expect(production('http://localhost:8081')).toBeNull();
    expect(production('https://app.example.test')).toBe('https://app.example.test');
  });
});

describe('the sign-in state', () => {
  test('tells a stranger it is not the home network, and nothing about the setup', async () => {
    const outside = await call('/auth/state', { from: PROXY, headers: { [EXPOSURE_HEADER]: 'public', [CLIENT_IP_HEADER]: '203.0.113.5' } });
    expect(outside.body).toMatchObject({ onHomeNetwork: false, reason: 'Not on the home network' });
    const home = await call('/auth/state');
    expect(String(home.body?.reason)).toContain('192.168.1.58');
  });
});
