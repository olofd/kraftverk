import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LiveUpdate } from '@kraftverk/api-contract';

import type { SessionManager } from '@kraftverk/holder';
import { createHub, DeviceTypeRegistry, passphraseSealing, ProtocolRegistry, TransportHost, type Attention } from '@kraftverk/hub';

import { CORS_METHODS, corsOrigin, createApp } from './app.ts';
import { CLIENT_HEADER } from '@kraftverk/api-contract';
import { SESSION_COOKIE } from './auth/routes.ts';
import { Accounts } from './auth/accounts.ts';
import { CLIENT_IP_HEADER, EXPOSURE_HEADER, ProxyDirectory } from './auth/trust.ts';
import { loadConfig } from './config.ts';
import { busDefinition, FakeBus, lampProtocol, lampType, MACHINE_NODE, TEST_INTEGRATION, TEST_SOURCE } from '@kraftverk/hub/testing';
import { openDatabase } from './platform/database.ts';
import { MCP_BATCH_MAX } from './routes/assistant.ts';
import { originAllowed } from './routes/live.ts';
import { serverSecrets } from './platform/secrets.ts';
import { RESET_SECRET_MIN } from './platform/reset-secret.ts';
import { AuditLog, type SqlDatabase } from '@kraftverk/store';

/**
 * The server's own, over HTTP, as the app and an attacker reach it: every
 * route behind a session, a refusal as its status and one shape, a body that
 * does not hold, the MCP endpoint, the live socket, its own routes, browsers
 * from elsewhere and the sign-in state. What the home does behind the routes
 * is the hub's, and tested there (packages/hub/test); that the routes answer
 * as the home does, api.test.ts.
 *
 * A server built the way `index.ts` builds one, holding lamps on a pretend
 * bus (`@kraftverk/hub/testing`), so the paths that touch a device run for
 * real and nothing reaches hardware or the network.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-app-'));
const PASSWORD = 'correct horse battery staple';
const PROXY = '172.20.0.9';
/** Where this server looks for the passphrase that lets the home be erased: nowhere, until a test writes it. */
const RESET_SECRET_FILE = join(dir, 'reset-secret');

type Server = {
  app: ReturnType<typeof createApp>['app'];
  websocket: ReturnType<typeof createApp>['websocket'];
  attention: Attention;
  sessions: SessionManager;
  bus: FakeBus;
  /** Its own database, and the accounts in it. */
  database: SqlDatabase;
  accounts: Accounts;
  close(): Promise<void>;
};

async function build(options: { readOnly?: boolean; file: string }): Promise<Server> {
  const { database } = openDatabase(options.file);
  const accounts = new Accounts(database);
  const config = loadConfig({ NODE_ENV: 'test', READ_ONLY: options.readOnly ? '1' : '0', KRAFTVERK_RESET_SECRET_FILE: RESET_SECRET_FILE }, []);
  const bus = new FakeBus();
  const protocols = new ProtocolRegistry();
  const transports = new TransportHost({ platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } });
  const types = new DeviceTypeRegistry();
  protocols.install(lampProtocol, 'test');
  transports.install(busDefinition, { create: () => bus });
  types.installIntegration(TEST_INTEGRATION);
  types.install(lampType, TEST_SOURCE);
  await transports.startAll(['bus']);

  // As index.ts builds a home — but not started: only the bus runs, and nothing reaches a radio or the network.
  const hub = createHub({
    database,
    audit: new AuditLog(database),
    secrets: serverSecrets(null),
    sealing: passphraseSealing,
    installed: { types, protocols, transports },
    readOnly: () => config.readOnly,
    http: () => Promise.reject(new Error('no network in these tests')),
    node: MACHINE_NODE,
    gateway: { verifyTimeoutMs: 300 },
  });
  const proxies = new ProxyDirectory(PROXY);
  await proxies.refresh();
  const { app, websocket } = createApp({ hub, accounts, config, proxies, serverLog: { dir: null, recent: () => [] }, startedAt: new Date() });
  return {
    app,
    websocket,
    attention: hub.attention,
    sessions: hub.sessions,
    bus,
    database,
    accounts,
    close: async () => {
      await hub.stop();
      database.close();
    },
  };
}

let server: Server;

beforeAll(async () => {
  server = await build({ file: join(dir, 'app.db') });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

type Call = { method?: string; body?: unknown; raw?: string; cookie?: string; from?: string; headers?: Record<string, string>; host?: string; on?: Server };

async function call(path: string, { method = 'GET', body, raw, cookie, from = '192.168.1.58', headers = {}, host: hostHeader = '192.168.1.140:3333', on = server }: Call = {}) {
  const response = await on.app.fetch(
    new Request(`http://${hostHeader}/api${path}`, {
      method,
      headers: {
        host: hostHeader,
        ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { [CLIENT_HEADER]: 'test' } : {}),
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
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

/** Signed in as olof, on each server. */
let session: string;
const sessions = new Map<Server, string>();

const login = async (username: string, on = server) => (await call('/auth/login', { method: 'POST', body: { username, password: PASSWORD }, on })).token!;

beforeEach(async () => {
  server.database.exec('DELETE FROM device; DELETE FROM sample; DELETE FROM node WHERE self = 0; DELETE FROM users; DELETE FROM login_session; DELETE FROM home_setting; DELETE FROM audit; DELETE FROM automation;');
  await server.sessions.sync([]);
  await server.accounts.createFirstUser('olof', PASSWORD);
  session = await login('olof');
  sessions.set(server, session);
  server.bus.lamps.clear();
});

const as = (path: string, options: Call = {}) => call(path, { cookie: sessions.get(options.on ?? server), ...options });
const enc = encodeURIComponent;

/** A lamp on the bus, answering. */
const lampAt = (address: string, on = server) => {
  on.bus.lamps.set(address, { serial: address.toUpperCase(), model: 'L1', on: true, answers: true });
  on.bus.announce();
};

/** A lamp added through setup's routes, as the app adds one: over the bus, or simulated. */
async function added(name: string, options: { methodId?: string; address?: string; on?: Server } = {}) {
  const on = options.on ?? server;
  const started = await as('/setup', { method: 'POST', body: { typeId: 'test.lamp', methodId: options.methodId ?? 'bus' }, on });
  expect(started.status).toBe(200);
  const id = started.body.id as string;
  // A simulated device has nothing to choose: there is only its simulator.
  if (started.body.plan.some((step: { kind: string }) => step.kind === 'choose')) {
    expect((await as(`/setup/${id}/choose`, { method: 'POST', body: { address: options.address ?? 'lamp-1' }, on })).status).toBe(200);
  }
  expect((await as(`/setup/${id}/check`, { method: 'POST', on })).status).toBe(200);
  const saved = await as(`/setup/${id}/save`, { method: 'POST', body: { name }, on });
  expect(saved.status).toBe(200);
  return saved.body as { id: string; key: string; name: string; connections: { id: string }[] };
}

const lampOnRule = {
  roles: { lamp: { label: 'Lamp', description: 'Lamp', capabilities: ['switch'] } },
  params: { fields: {} },
  when: [],
  then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
};

describe('configuration', () => {
  test('its JSON Schema is open to an editor, which cannot log in; what you have is the vocabulary’s, behind the gate', async () => {
    const schema = await call('/config/schema.json');
    expect(schema.status).toBe(200);
    expect(schema.body.$defs.device.properties.type.enum).toContain('test.lamp');
    expect((await call('/config/vocabulary')).status).toBe(401);
    expect((await as('/config/vocabulary')).status).toBe(200);
  });

  test('an export names its schema at the address it was asked at', async () => {
    const exported = await as('/config/export', { method: 'POST', body: {} });
    expect(exported.status).toBe(200);
    expect(exported.body.text).toContain('# yaml-language-server: $schema=http://192.168.1.140:3333/api/config/schema.json');
  });

  test('a secret leaves only for your password: a session alone — a borrowed laptop — carries off no key', async () => {
    const sealed = { secrets: 'sealed', passphrase: 'a passphrase long enough' };
    expect((await as('/config/export', { method: 'POST', body: sealed })).status).toBe(403);
    expect((await as('/config/export', { method: 'POST', body: { ...sealed, yourPassword: 'not it at all' } })).status).toBe(403);
    expect((await as('/config/export', { method: 'POST', body: { ...sealed, yourPassword: PASSWORD } })).status).toBe(200);
    expect((await as('/config/export', { method: 'POST', body: { secrets: 'plain' } })).status).toBe(403);
    // Left out, nothing is asked.
    expect((await as('/config/export', { method: 'POST', body: { secrets: 'none' } })).status).toBe(200);

    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const exportable = (secretsExportable: boolean, yourPassword?: string) =>
      as(`/devices/${enc(lamp.id)}/connections/${enc(lamp.connections[0]!.id)}`, { method: 'PATCH', body: { secretsExportable, ...(yourPassword ? { yourPassword } : {}) } });
    expect((await exportable(true)).status).toBe(403);
    expect((await exportable(true, PASSWORD)).status).toBe(200);
    // Turned off, nothing is asked.
    expect((await exportable(false)).status).toBe(200);
  });

  test('the copy a restore was made from is imported again only when there was a restore; a file’s text, or it — not both', async () => {
    expect((await as('/config/plan', { method: 'POST', body: { restored: true } })).status).toBe(404);
    expect((await as('/config/plan', { method: 'POST', body: { restored: true, text: 'kraftverk: 4\n' } })).status).toBe(400);
  });
});

describe('everything needs a session', () => {
  test('every route answers 401 without one', async () => {
    for (const path of ['/devices', '/devices/removed', '/device-types', '/transports', '/found', '/audit', '/version', '/diagnostics/log', '/nodes', '/automations', '/world', '/policy']) {
      expect((await call(path)).status).toBe(401);
    }
    expect((await call('/setup', { method: 'POST', body: { typeId: 'test.lamp' } })).status).toBe(401);
  });
});

describe('a refusal over HTTP', () => {
  test('is its kind’s status, in one shape: its words, and the token a yes is sent back with', async () => {
    lampAt('lamp-1');
    lampAt('lamp-2');
    const hall = await added('Hall lamp');
    const porch = await added('Porch lamp', { address: 'lamp-2' });

    // Not there: 404.
    expect(await as('/devices/d-000000000000')).toMatchObject({ status: 404, body: { error: 'No such device' } });
    // Taken: 409, in words.
    expect(await as(`/devices/${porch.id}`, { method: 'PATCH', body: { key: hall.key } })).toMatchObject({ status: 409, body: { error: `Another device is known by "${hall.key}"` } });
    // Not a key: 400.
    expect((await as(`/devices/${porch.id}`, { method: 'PATCH', body: { key: 'Not A Key' } })).status).toBe(400);
    // A tool that writes, asked as a read: 405.
    expect((await as(`/devices/${hall.id}/tools/blink`)).status).toBe(405);
    expect((await as(`/devices/${hall.id}/tools/ping`)).body).toEqual({ pong: true, room: 'Hall' });

    // A yes wanted: 409, with the token to send it back with.
    const automation = await as('/automations', { method: 'POST', body: { name: 'Lamp on', rule: lampOnRule, roles: { lamp: { device: hall.id, part: 'main' } }, groups: {}, starts: {}, timeZone: 'Europe/Stockholm' } });
    expect(automation.status).toBe(200);
    const asked = await as(`/automations/${automation.body.id}`, { method: 'PATCH', body: { mode: 'act' } });
    expect(asked.status).toBe(409);
    expect(asked.body).toEqual({ error: expect.any(String), kind: 'needs-yes', needsConfirmation: expect.any(String) });
    const acting = await as(`/automations/${automation.body.id}`, { method: 'PATCH', body: { mode: 'act', confirmation: asked.body.needsConfirmation } });
    expect([acting.status, acting.body.mode]).toEqual([200, 'act']);
  });

  test('a command or a setting the gateway refuses is its verdict, with 409', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    await new Promise((resolve) => setTimeout(resolve, 30)); // its first reading
    const commands = `/devices/${enc(lamp.id)}/parts/main/commands`;
    const switched = await as(`${commands}/switch/set`, { method: 'POST', body: { args: { on: false } } });
    expect([switched.status, switched.body.outcome]).toEqual([200, 'verified']);
    expect(await as(`${commands}/switch/explode`, { method: 'POST', body: { args: { on: true } } })).toMatchObject({ status: 409, body: { outcome: 'refused' } });
    expect((await as(`${commands}/teleport/set`, { method: 'POST', body: { args: { on: true } } })).status).toBe(404);
    expect(await as(`/devices/${enc(lamp.id)}/attributes`, { method: 'PATCH', body: { patch: { turbo: true } } })).toMatchObject({ status: 409, body: { outcome: 'refused', detail: 'It has no settings to change' } });
  });

  test('a JSON body that does not hold is a 400, each problem said', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const path = `/devices/${enc(lamp.id)}`;
    // What a device is is its type, which no route changes.
    const typed = await as(path, { method: 'PATCH', body: { typeId: 'test.other' } });
    expect(typed.status).toBe(400);
    expect(typed.body).toEqual({ error: expect.any(String), kind: 'invalid', problems: [expect.any(String)] });
    expect((await as(`${path}/picture`, { method: 'PUT', body: { picture: 2 } })).status).toBe(400);
    const automation = await as('/automations', { method: 'POST', body: { name: 'Lamp on', rule: lampOnRule, roles: { lamp: { device: lamp.id, part: 'main' } }, groups: {}, starts: {}, timeZone: 'Europe/Stockholm' } });
    expect((await as(`/automations/${automation.body.id}`, { method: 'PATCH', body: { recheckMinutes: 0 } })).status).toBe(400);
    // An entry about an id with no kind could not be filtered by, and is refused.
    const node = await as('/nodes', { method: 'POST', body: { id: 'n-000000000000aa01', name: 'Olof’s laptop', platform: 'web', transports: ['bus'], alwaysOn: false, reachable: false, trusted: false } });
    const half = await as(`/nodes/${node.body.id}/audit`, { method: 'POST', body: { entries: [{ at: new Date().toISOString(), kind: 'command.verified', resource: lamp.id, summary: 'Half an entry' }] } });
    expect(half.status).toBe(400);
    expect(half.body.problems).toEqual(['entries.0: What an entry is about is a kind and an id together, or nothing']);
    // Not JSON at all.
    expect(await as(path, { method: 'PATCH', raw: '{ name: Shed' })).toMatchObject({ status: 400, body: { error: 'Expected a JSON body' } });
  });

  test('an app speaking for a connection it does not hold is refused with 403', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const node = await as('/nodes', { method: 'POST', body: { id: 'n-000000000000aa01', name: 'Olof’s laptop', platform: 'web', transports: ['bus'], alwaysOn: false, reachable: false, trusted: false } });
    const said = await as(`/devices/${enc(lamp.id)}/readings`, { method: 'POST', body: { nodeId: node.body.id, connectionId: lamp.connections[0]!.id, readings: [{ key: 'on', value: true, at: new Date().toISOString() }] } });
    expect(said).toMatchObject({ status: 403, body: { error: 'That node does not hold a connection to this device' } });
  });

  test('an id with a percent sign is a 404, not a 500', async () => {
    expect((await as('/devices/abc%25def')).status).toBe(404);
    expect((await as('/devices/abc%25def/history?key=soc')).status).toBe(404);
  });

  test('the recipes are not taken for an automation’s id', async () => {
    expect((await as('/automations/recipes')).body.recipes.length).toBeGreaterThan(0);
    expect((await as('/automations/a-000000000000')).status).toBe(404);
  });

  test('one thing’s automations and timeline are asked for in the query', async () => {
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    const automation = await as('/automations', { method: 'POST', body: { name: 'Lamp on', rule: lampOnRule, roles: { lamp: { device: lamp.id, part: 'main' } }, groups: {}, starts: {}, timeZone: 'Europe/Stockholm' } });
    expect((await as(`/automations?device=${enc(lamp.id)}`)).body.automations.map((one: { id: string }) => one.id)).toEqual([automation.body.id]);
    expect((await as('/automations?device=d-000000000000')).body.automations).toEqual([]);
    const its = (await as(`/audit?resourceKind=device&resource=${enc(lamp.id)}`)).body as { resource: string }[];
    expect(its.length).toBeGreaterThan(0);
    expect(its.every((line) => line.resource === lamp.id)).toBe(true);
    expect((await as('/audit?resourceKind=nothing')).status).toBe(400);
  });

  test('a read-only server refuses a tool that writes to hardware with 423', async () => {
    const readOnly = await build({ readOnly: true, file: join(dir, 'read-only.db') });
    await readOnly.accounts.createFirstUser('olof', PASSWORD);
    sessions.set(readOnly, await login('olof', readOnly));
    try {
      lampAt('lamp-1', readOnly);
      const real = await added('Real lamp', { on: readOnly });
      expect((await as(`/devices/${enc(real.id)}/tools/blink`, { method: 'POST', body: {}, on: readOnly })).status).toBe(423);
      expect((await as('/version', { on: readOnly })).body.readOnly).toBe(true);
    } finally {
      await readOnly.close();
    }
  });
});

describe('an assistant, over HTTP', () => {
  const mcp = (body: unknown, cookie: string | null = session) => call('/mcp', { method: 'POST', body, ...(cookie ? { cookie } : {}) });

  test('reads the world as text, for a context window', async () => {
    const lamp = await added('Pretend lamp', { methodId: 'simulated' });
    const world = await as('/world?format=text');
    expect(world.headers.get('content-type')).toStartWith('text/plain');
    expect(world.text).toContain(`Pretend lamp [${lamp.id}] Test lamp: connected`);
    expect((await as('/world')).body.devices).toEqual([expect.objectContaining({ id: lamp.id })]);
  });

  test('speaks MCP behind the same sign-in: the handshake, a notification heard and not answered, a batch, and nothing without a session', async () => {
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status).toBe(401);
    const hello = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(hello.body.result).toMatchObject({ serverInfo: { name: 'kraftverk' }, capabilities: { tools: {} } });
    // A notification is heard, and not answered.
    expect((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })).status).toBe(202);
    // A batch is answered as one, a reply for each that wants one.
    const batch = await mcp([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(batch.body.map((reply: { id: number }) => reply.id)).toEqual([1, 2]);
    expect(batch.body[1].result.tools.map((listed: { name: string }) => listed.name)).toContain('command');
    // As an agent for whoever is signed in: on the timeline as such.
    lampAt('lamp-1');
    const lamp = await added('Hall lamp');
    await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'command', arguments: { device: lamp.id, part: 'main', capability: 'switch', command: 'set', args: { on: true }, reason: 'asked to' } } });
    expect(((await as('/audit')).body as { actor: string }[]).some((entry) => entry.actor === 'assistant for olof')).toBe(true);
    // Not JSON: a parse error, as JSON-RPC says.
    expect(await call('/mcp', { method: 'POST', raw: 'nope', cookie: session })).toMatchObject({ status: 400, body: { error: { code: -32700 } } });
    // A batch is bounded, and each of it a message: not a thousand commands at once, nor a crash on a null.
    const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
    expect(await mcp(Array.from({ length: MCP_BATCH_MAX + 1 }, (_, index) => ping(index)))).toMatchObject({ status: 400, body: { error: { code: -32600 } } });
    expect((await mcp(Array.from({ length: MCP_BATCH_MAX }, (_, index) => ping(index)))).status).toBe(200);
    expect(await mcp([ping(1), null])).toMatchObject({ status: 400, body: { error: { code: -32600 } } });
  });
});

describe('the live stream', () => {
  /** The app, served for real — a socket cannot be opened through `app.fetch` alone. */
  const serve = (on: Server) => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request, bun) => on.app.fetch(request, bun), websocket: on.websocket as never });

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
    const http = serve(server);
    try {
      const { socket, updates } = await open(http.port!, { cookie: `${SESSION_COOKIE}=${session}` });
      const lamp = await added('Pretend lamp', { methodId: 'simulated' });
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

  test('hears what the app’s screen shows, and who is signed in on it; forgets it when the socket closes; reads nothing else it says', async () => {
    const http = serve(server);
    try {
      const { socket } = await open(http.port!, { cookie: `${SESSION_COOKIE}=${session}` });
      const plug = { kind: 'device', id: 'd-somewhere' } as const;
      socket.send('not json');
      socket.send(JSON.stringify({ type: 'view', screen: 'device', showing: [{ kind: 'nonsense', id: 'x' }] }));
      socket.send(JSON.stringify({ type: 'view', screen: 'device', showing: [plug] }));
      await until(() => server.attention.watched(plug as never));
      expect(server.attention.viewers()).toEqual([expect.objectContaining({ person: 'olof', screen: 'device', showing: [plug] })]);
      socket.close();
      await until(() => server.attention.viewers().length === 0);
      expect(server.attention.watched(plug as never)).toBe(false);
    } finally {
      http.stop(true);
    }
  });

  test('is refused without a session, and to a page on another website', async () => {
    const http = serve(server);
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
    // The name, at another port: another site there shares your cookie, not this server's page.
    expect(originAllowed('https://home.example.test:5001', 'kraftverk:3333', deps, cors)).toBe(false);
    expect(originAllowed('http://192.0.2.10:5000', '192.0.2.10:8080', deps, cors)).toBe(false);
    expect(originAllowed('not a url', '192.0.2.10:8080', deps, cors)).toBe(false);
  });
});

describe('the server', () => {
  test('says what it is running as, and what it has said lately', async () => {
    const version = (await as('/version')).body;
    expect(version).toMatchObject({ readOnly: false });
    // Which transports to use is not the server's setting: every installed one is available.
    expect(version.simulate).toBeUndefined();
    expect(version.transports).toBeUndefined();
    expect((await as('/health')).body).toEqual({ ok: true });
    expect((await as('/diagnostics/log?level=warn')).body).toEqual({ dir: null, lines: [] });
  });

  test('lists its transports, and what they can see that nothing you have is reached by', async () => {
    lampAt('lamp-1');
    lampAt('lamp-2');
    const transports = (await as('/transports')).body;
    expect(transports.transports).toEqual([expect.objectContaining({ id: 'bus', holder: 'master', running: true, availability: { ok: true } })]);

    await as('/found'); // starts watching
    const found = (await as('/found')).body.found;
    expect(found.map((entry: { address: string }) => entry.address).sort()).toEqual(['lamp-1', 'lamp-2']);
    // Each way it could be added as: the type, by each method that reaches it.
    expect(found[0].types.map((type: { methodId: string }) => type.methodId)).toEqual(['bus', 'backup']);

    await added('Hall lamp');
    expect((await as('/found')).body.found.map((entry: { address: string }) => entry.address)).toEqual(['lamp-2']);
  });

  test('erases the home only with the passphrase kept in a file on it — and keeps its accounts', async () => {
    lampAt('lamp-1');
    await added('Hall lamp');
    expect((await as('/admin/reset')).body).toEqual({ available: false, secretFile: RESET_SECRET_FILE });
    expect((await as('/admin/reset', { method: 'POST', body: { secret: 'anything at all, really' } })).status).toBe(404);

    const secret = 'a passphrase for these tests'.padEnd(RESET_SECRET_MIN, '.');
    writeFileSync(RESET_SECRET_FILE, `${secret}\n`);
    try {
      expect((await as('/admin/reset')).body.available).toBe(true);
      expect((await as('/admin/reset', { method: 'POST', body: { secret: 'not the passphrase at all' } })).status).toBe(403);
      const reset = await as('/admin/reset', { method: 'POST', body: { secret } });
      expect(reset.status).toBe(200);
      expect(reset.body.tables).toContain('device');
      expect((await as('/devices')).body.devices).toEqual([]);
      // Still signed in, as the same account: accounts are the server's, not the home's.
      expect((await as('/auth/state')).body.user.username).toBe('olof');
    } finally {
      rmSync(RESET_SECRET_FILE, { force: true });
    }
  });
});

describe('browsers from elsewhere', () => {
  const preflight = (origin: string) => call('/devices', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });

  test('another web app on the same box gets no credentialed access', async () => {
    for (const origin of ['http://192.168.1.140:5000', 'http://192.168.1.140', 'http://diskstation.local:5001', 'https://evil.example']) {
      expect((await preflight(origin)).headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('an allowed browser elsewhere may send every method a route answers to', () => {
    const used = new Set(server.app.routes.filter((route) => route.path.startsWith('/api/')).map((route) => route.method));
    used.delete('ALL');
    expect([...used].filter((method) => !(CORS_METHODS as readonly string[]).includes(method))).toEqual([]);
    expect(used.has('PUT')).toBe(true);
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
