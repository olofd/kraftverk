import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSchema, KraftverkPlugin, PluginManifest, SetupActionResult, StationId } from '@kraftverk/device-sdk';
import { readHoldingRegisters, toHex, writeRegister, type ParsedFrame } from '@kraftverk/protocol';

import { ActionGateway, CONFIRMATION_PHRASE } from './actions/gateway.ts';
import { corsOrigin, createApp } from './app.ts';
import { createFirstUser } from './auth/store.ts';
import type { Binding } from './binding.ts';
import { CLIENT_HEADER, SESSION_COOKIE } from './auth/routes.ts';
import { CLIENT_IP_HEADER, EXPOSURE_HEADER, ProxyDirectory } from './auth/trust.ts';
import { loadConfig } from './config.ts';
import { ConnectionManager } from './connections/manager.ts';
import { DeviceCatalog } from './devices/catalog.ts';
import { LegacyStationImport } from './devices/legacy.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { relayStation } from './devices/relay-pairing.ts';
import { SimulatorDriver } from './drivers/simulator.ts';
import { closeDb, db, openSecret } from './history/db.ts';
import { Sampler } from './history/sampler.ts';
import { PluginHost } from './plugins/host.ts';
import type { TransportHost } from './transport/types.ts';

/**
 * The server's routes, over HTTP, as the app and an attacker reach them.
 *
 * Until `createApp` existed none of these could be tested: importing the
 * server started radios and a broker. The route-level bugs the audit found —
 * unvalidated devices, a double-decoded id, a 500 for a mistyped plugin
 * setting, a relay switch acting on the wrong plug, a secret sent back to the
 * browser — all lived in the untested half. They are pinned here.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-app-'));
const PASSWORD = 'correct horse battery staple';
const PROXY = '172.20.0.9';

/** A second grid relay, to show which plug a switch acts on. */
function relayPlugin(id: string): KraftverkPlugin {
  let on = true;
  const manifest: PluginManifest = {
    id,
    name: 'Test relay',
    description: 'A relay for these tests',
    version: '0.0.0',
    apiVersion: '1',
    kind: 'grid-relay',
    capabilities: ['gridRelay.read', 'gridRelay.switch'],
    configSchema: { fields: {} },
    ui: { icon: 'power' },
  };
  const state = () => ({ relayOn: on, reachable: true, updatedAt: new Date().toISOString() });
  return {
    manifest,
    validateConfig: (config: unknown) => ({ ok: true, value: (config ?? {}) as Record<string, never> }),
    async start(context: { registerCapability: (name: string, impl: unknown) => void }) {
      context.registerCapability('gridRelay.read', this as never);
      context.registerCapability('gridRelay.switch', this as never);
    },
    async stop() {},
    health: () => ({ status: 'healthy' }),
    devices: () => [
      {
        id: `${id}:plug`,
        name: 'Test plug',
        category: 'smart-plug',
        icon: 'power',
        measurements: [{ key: 'relay', label: 'Relay', unit: '', kind: 'state' }],
        controls: [{ id: 'relay', label: 'Relay', kind: 'switch', capability: 'switch', measurementKey: 'relay' }],
      },
    ],
    readDevice: async () => [{ key: 'relay', value: on, at: new Date().toISOString() }],
    ...{
      bootBehaviour: 'last',
      read: async () => state(),
      getState: async () => state(),
      setRelay: async (next: boolean) => {
        on = next;
        return { accepted: true, readback: state(), tookMs: 0 };
      },
    },
  } as unknown as KraftverkPlugin;
}

/** A plugin whose setup action finds a secret, as fetching a Tuya key does. */
function keysPlugin(): KraftverkPlugin {
  const configSchema: ConfigSchema = {
    fields: {
      name: { type: 'string', title: 'Name', required: true },
      apiKey: { type: 'secret', title: 'Key', required: true },
      note: { type: 'secret', title: 'An optional secret' },
    },
  };
  return {
    manifest: {
      id: 'test.keys',
      name: 'Keys',
      description: 'Finds a key',
      version: '0.0.0',
      apiVersion: '1',
      kind: 'home-automation',
      capabilities: [],
      configSchema,
      setupActions: [{ id: 'fetch', title: 'Fetch the key' }],
      ui: { icon: 'key' },
    },
    validateConfig: (config: unknown) => {
      const values = (config ?? {}) as Record<string, unknown>;
      const missing = ['name', 'apiKey'].filter((field) => !values[field]);
      return missing.length
        ? { ok: false, issues: missing.map((field) => ({ field, message: 'Required' })) }
        : { ok: true, value: values };
    },
    async start() {},
    async stop() {},
    health: () => ({ status: 'healthy' }),
    runSetupAction: async (): Promise<SetupActionResult> => ({
      ok: true,
      detail: 'Found one',
      choices: [{ id: 'a', label: 'The one', config: { name: 'kitchen', apiKey: 'the-real-secret-value' } }],
    }),
  } as unknown as KraftverkPlugin;
}

let app: ReturnType<typeof createApp>['app'];
let connections: ConnectionManager;
let host: PluginHost;
/** A station bound before the catalog existed, for the tests that offer one. */
let legacyBinding: Binding | null = null;

beforeAll(async () => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();

  const config = loadConfig({ NODE_ENV: 'test', KRAFTVERK_BASELINE_FILE: join(dir, 'baseline.json') }, []);
  const catalog = new DeviceCatalog();
  connections = new ConnectionManager({
    transports: [],
    simulate: true,
    readOnly: false,
    host: () => {
      throw new Error('no radios in these tests');
    },
    simulator: () => new SimulatorDriver({ settingsFile: join(dir, 'sim-settings.json') }),
    onBound: () => {},
  });
  host = new PluginHost();
  await host.discover();
  host.install(relayPlugin('test.second-relay'));
  host.install(keysPlugin());
  const registry = new DeviceRegistry(catalog, host, connections);
  const gateway = new ActionGateway({ host, readStation: () => relayStation(connections), isReadOnly: () => false });
  const proxies = new ProxyDirectory(PROXY);
  await proxies.refresh();

  ({ app } = createApp({
    config,
    catalog,
    connections,
    host,
    registry,
    gateway,
    sampler: new Sampler(registry),
    legacyStation: new LegacyStationImport({
      catalog,
      transport: () => ['ble'],
      stationName: () => 'Power station',
      binding: async () => legacyBinding,
    }),
    proxies,
    serverLog: { dir: null, recent: () => [] },
    broker: null,
    startedAt: new Date(),
  }));
});

afterAll(async () => {
  await connections.closeAll();
  await host.stopAll();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

type Call = { method?: string; body?: unknown; cookie?: string; from?: string; headers?: Record<string, string>; host?: string };

async function call(path: string, { method = 'GET', body, cookie, from = '192.168.50.58', headers = {}, host: hostHeader = '192.168.50.140:3333' }: Call = {}) {
  const response = await app.fetch(
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
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { status: response.status, body: json, text, headers: response.headers, token };
}

let session: string;

beforeEach(async () => {
  db().exec('DELETE FROM device; DELETE FROM sample; DELETE FROM users; DELETE FROM sessions; DELETE FROM app_state; DELETE FROM plugin_config; DELETE FROM plugin_secret; DELETE FROM audit;');
  legacyBinding = null;
  await connections.sync([]);
  await createFirstUser('olof', PASSWORD);
  session = (await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } })).token!;
});

const as = (path: string, options: Call = {}) => call(path, { cookie: session, ...options });
const addStation = async () =>
  (await as('/devices', { method: 'POST', body: { type: 'power-station', driver: 'core.station', name: 'Station', model: 'aferiy-p280' } })).body as {
    id: string;
  };

describe('everything needs a session', () => {
  test('devices, plugins, the grid and the audit log answer 401 without one', async () => {
    for (const path of ['/devices', '/plugins', '/grid', '/audit', '/diagnostics/link', '/version']) {
      expect((await call(path)).status).toBe(401);
    }
  });
});

describe('devices', () => {
  test('a station is added, opened, paired with the relay, and forgotten', async () => {
    const station = await addStation();
    expect(connections.sessions).toHaveLength(1);
    expect((await as('/grid')).body?.stationDeviceId).toBe(station.id);

    const state = await as(`/devices/${encodeURIComponent(station.id)}/p280/state`);
    expect(state.status).toBe(200);
    expect(state.body?.status).toBeTruthy();

    expect((await as(`/devices/${encodeURIComponent(station.id)}`, { method: 'DELETE' })).status).toBe(200);
    expect(connections.sessions).toHaveLength(0);
    expect((await as('/grid')).body?.stationDeviceId).toBeNull();
  });

  test('a station imported from before the catalog is paired with the relay, as an added one is', async () => {
    legacyBinding = { kind: 'ble', id: 'AABBCCDDEEFF', boundAt: '2026-01-01T00:00:00.000Z' };
    expect((await as('/migration/station')).body?.state).toBe('offered');

    const imported = await as('/migration/station/import', { method: 'POST', body: {} });
    expect(imported.status).toBe(200);
    const id = (imported.body as { id: string }).id;

    // Otherwise every switch of the relay is refused, and the app offers no way to pair one.
    expect((await as('/grid')).body?.stationDeviceId).toBe(id);
    // Both entries name who did it, like every other change to the catalog.
    const entries = (await as('/audit')).body as unknown as { kind: string; actor: string }[];
    expect(entries.find((entry) => entry.kind === 'device.imported')?.actor).toBe('olof');
    expect(entries.find((entry) => entry.kind === 'relay.paired')?.actor).toBe('olof');
  });

  test('nothing is stored that no driver provides', async () => {
    const refused = [
      { type: 'power-station', driver: 'something-else', name: 'Ghost' },
      { type: 'power-station', driver: 'core.station', name: 'S', model: 'not-a-model' },
      { type: 'smart-plug', driver: 'not-installed', name: 'P' },
      { type: 'power-station', driver: 'core.station', name: 'S', config: { anything: 1 } },
    ];
    for (const body of refused) expect((await as('/devices', { method: 'POST', body })).status).toBe(400);
    expect((await as('/devices')).body?.devices).toEqual([]);
    expect(connections.sessions).toHaveLength(0);
  });

  test('a device is renamed, but its binding is not rewritten', async () => {
    const station = await addStation();
    const path = `/devices/${encodeURIComponent(station.id)}`;
    expect((await as(path, { method: 'PATCH', body: { config: { boundId: 'AABBCCDDEEFF' } } })).status).toBe(400);
    const renamed = await as(path, { method: 'PATCH', body: { name: 'Shed' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body?.name).toBe('Shed');
  });

  test('an id with a percent sign is a 404, not a 500', async () => {
    expect((await as('/devices/abc%25def')).status).toBe(404);
    expect((await as('/devices/abc%25def/history?key=soc')).status).toBe(404);
  });

  test('a station output is switched through its own session', async () => {
    const station = await addStation();
    const result = await as(`/devices/${encodeURIComponent(station.id)}/control/usb`, { method: 'POST', body: { value: false } });
    expect(result.status).toBe(200);
    const ports = (result.body as { ports: { id: string; enabled: boolean }[] }).ports;
    expect(ports.find((port) => port.id === 'usb')?.enabled).toBe(false);
  });
});

describe('the grid relay', () => {
  test("a plug's switch acts on that plug, or not at all", async () => {
    await addStation();
    const fake = 'dev.kraftverk.fake-grid-relay';
    await as(`/plugins/${fake}/config`, { method: 'PATCH', body: {} });
    await as(`/plugins/${fake}/enable`, { method: 'POST', body: { enabled: true } });
    await as(`/plugins/${fake}/grants`, { method: 'POST', body: { capability: 'gridRelay.switch', granted: true, confirmation: CONFIRMATION_PHRASE } });
    await as(`/plugins/${fake}/provider`, { method: 'POST' });

    const other = (await as('/devices', { method: 'POST', body: { type: 'smart-plug', driver: 'test.second-relay', name: 'Other plug' } })).body as { id: string };
    const refused = await as(`/devices/${encodeURIComponent(other.id)}/control/relay`, {
      method: 'POST',
      body: { value: false, confirmation: CONFIRMATION_PHRASE },
    });
    expect(refused.status).toBe(409);
    expect(String(refused.body?.error)).toContain('not the grid relay');
    // The relay that is the provider was not touched.
    expect(((await as('/grid')).body?.state as { relayOn: boolean }).relayOn).toBe(true);
  });
});

describe('plugins', () => {
  test('a configuration that does not fit says which field, as a 400', async () => {
    const result = await as('/plugins/test.keys/config', { method: 'PATCH', body: { name: '' } });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain('apiKey');
  });

  test('a secret found by a setup action never reaches the browser, and is stored when saved', async () => {
    const found = await as('/plugins/test.keys/setup/fetch', { method: 'POST', body: {} });
    expect(found.status).toBe(200);
    expect(found.text).not.toContain('the-real-secret-value');
    const config = (found.body?.choices as { config: Record<string, string> }[])[0]!.config;
    expect(config.name).toBe('kitchen');
    expect(config.apiKey).toStartWith('held:');

    const saved = await as('/plugins/test.keys/config', { method: 'PATCH', body: config });
    expect(saved.status).toBe(200);
    const stored = await as('/plugins/test.keys/config');
    expect(stored.body?.secretsSet).toContain('apiKey');
    expect(stored.text).not.toContain('the-real-secret-value');
    // Read back as the server reads it: sealed, where KRAFTVERK_SECRET_KEY is set.
    const row = db().query("SELECT value, encrypted FROM plugin_secret WHERE plugin_id = 'test.keys' AND field = 'apiKey'").get() as {
      value: string;
      encrypted: number;
    };
    expect(openSecret(row.value, row.encrypted === 1)).toBe('the-real-secret-value');

    // A placeholder is good once, and only for what it was issued for.
    expect((await as('/plugins/test.keys/config', { method: 'PATCH', body: config })).status).toBe(400);
    expect((await as('/plugins/test.keys/config', { method: 'PATCH', body: { apiKey: 'held:made-up' } })).status).toBe(400);
  });

  test('a stored secret can be cleared', async () => {
    await as('/plugins/test.keys/config', { method: 'PATCH', body: { name: 'x', apiKey: 'one', note: 'two' } });
    expect((await as('/plugins/test.keys/config')).body?.secretsSet).toContain('note');
    expect((await as('/plugins/test.keys/config', { method: 'PATCH', body: { note: null } })).status).toBe(200);
    const after = (await as('/plugins/test.keys/config')).body?.secretsSet as string[];
    expect(after).not.toContain('note');
    expect(after).toContain('apiKey');
  });
});

describe('browsers from elsewhere', () => {
  const preflight = (origin: string) =>
    call('/devices', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });

  test('another web app on the same box gets no credentialed access', async () => {
    for (const origin of ['http://192.168.50.140:5000', 'http://192.168.50.140', 'http://diskstation.local:5001', 'https://evil.example']) {
      expect((await preflight(origin)).headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('the Expo dev server is allowed in development, and nothing but named origins in production', () => {
    const development = corsOrigin({ allowedOrigins: [], development: true });
    expect(development('http://localhost:8081')).toBe('http://localhost:8081');
    expect(development('http://192.168.50.58:8081')).toBe('http://192.168.50.58:8081');
    expect(development('http://192.168.50.58:5000')).toBeNull();

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
    expect(String(home.body?.reason)).toContain('192.168.50.58');
  });
});

describe('raw frames', () => {
  /** One station's link, recording what reached it. */
  class RecordingLink {
    readonly kind = 'ble' as const;
    readonly connected = true;
    sent: string[] = [];
    constructor(readonly boundId: StationId) {}
    async send(frame: Uint8Array) {
      this.sent.push(toHex(frame));
    }
    async request(): Promise<ParsedFrame> {
      throw new Error('not answering');
    }
    onFrame() {
      return () => {};
    }
    async close() {}
  }

  let links: RecordingLink[];

  /** A server on real hardware, as protocol work runs it: raw frames on, writes off. */
  async function hardwareApp(readOnly: boolean) {
    links = [];
    const radio: TransportHost = {
      kind: 'ble',
      start: async () => {},
      stop: async () => {},
      discovered: () => [],
      onDiscovery: () => () => {},
      openIds: () => links.map((link) => link.boundId),
      open: async (station) => {
        const link = new RecordingLink(station);
        links.push(link);
        return link;
      },
    };
    const config = loadConfig(
      { NODE_ENV: 'test', STATION_DRIVER: 'ble', ALLOW_RAW_MODBUS: '1', READ_ONLY: readOnly ? '1' : '0', KRAFTVERK_BASELINE_FILE: join(dir, 'baseline.json') },
      []
    );
    const catalog = new DeviceCatalog();
    const hardware = new ConnectionManager({
      transports: config.transports,
      simulate: false,
      readOnly: config.readOnly,
      host: () => radio,
      simulator: () => new SimulatorDriver({ settingsFile: join(dir, 'sim-settings.json') }),
    });
    const record = catalog.add({ type: 'power-station', driver: 'core.station', name: 'Bench', config: { transport: 'ble', boundId: 'AABBCCDDEEFF' } });
    await hardware.sync(catalog.list());
    const registry = new DeviceRegistry(catalog, host, hardware);
    const { app: server } = createApp({
      config,
      catalog,
      connections: hardware,
      host,
      registry,
      gateway: new ActionGateway({ host, readStation: () => relayStation(hardware), isReadOnly: () => hardware.readOnly }),
      sampler: new Sampler(registry),
      legacyStation: new LegacyStationImport({ catalog, transport: () => [], stationName: () => 'Power station' }),
      proxies: new ProxyDirectory(PROXY),
      serverLog: { dir: null, recent: () => [] },
      broker: null,
      startedAt: new Date(),
    });
    const send = async (hex: string) => {
      const response = await server.fetch(
        new Request('http://192.168.50.140:3333/api/diagnostics/raw', {
          method: 'POST',
          headers: { host: '192.168.50.140:3333', 'content-type': 'application/json', [CLIENT_HEADER]: 'test', cookie: `${SESSION_COOKIE}=${session}` },
          body: JSON.stringify({ hex, deviceId: record.id }),
        }),
        { requestIP: () => ({ address: '192.168.50.58' }) }
      );
      return response.status;
    };
    return { send, close: () => hardware.closeAll() };
  }

  test('a read-only server sends no write, however the frame is spelled', async () => {
    const server = await hardwareApp(true);
    try {
      // AC output on: 0x06, and the same change as 0x10, 0x16 and 0x17.
      for (const hex of [toHex(writeRegister(26, 1)), '1110001a0001020001', '1116001a00000001', '11170000000a001a0001020001']) {
        expect(await server.send(hex)).toBe(423);
      }
      expect(links[0]!.sent).toEqual([]);

      // Reading changes nothing, so read-only is no reason to refuse it.
      expect(await server.send(toHex(readHoldingRegisters(0, 80)))).toBe(200);
      expect(links[0]!.sent).toEqual([toHex(readHoldingRegisters(0, 80))]);
    } finally {
      await server.close();
    }
  });

  test('with writes allowed, a raw write is sent', async () => {
    const server = await hardwareApp(false);
    try {
      expect(await server.send(toHex(writeRegister(26, 1)))).toBe(200);
      expect(links[0]!.sent).toEqual([toHex(writeRegister(26, 1))]);
    } finally {
      await server.close();
    }
  });
});
