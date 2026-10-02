import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiError, type KraftverkApi, type LiveUpdate } from '@kraftverk/api-contract';
import { httpApi } from '@kraftverk/api-client/http';
import { savedDeviceId } from '@kraftverk/device-sdk';
import { createHub, DeviceTypeRegistry, ProtocolRegistry, TransportHost, type Hub } from '@kraftverk/hub';
import { busDefinition, FakeBus, lampProtocol, lampType } from '@kraftverk/hub/testing';

import { createApp } from './app.ts';
import { SESSION_COOKIE } from './auth/routes.ts';
import { createFirstUser } from './auth/store.ts';
import { ProxyDirectory } from './auth/trust.ts';
import { loadConfig } from './config.ts';
import { auditLog, closeDb, db } from './platform/database.ts';
import { serverSealing } from './platform/sealing.ts';
import { serverSecrets } from './platform/secrets.ts';

/*
  One interface, two ways to reach it (docs/PLAN-SHARED-CORE.md, principle
  4): the same questions asked of a home in the process (`hub.as(caller)`)
  and over HTTP (`httpApi`, through the server's routes), and the same
  answers — refusals included, as the same ApiError. What one says and the
  other does not is a route that is not an adapter, or a client that is not
  the interface.

  The live socket is the one thing not asked here: an upgrade needs a server
  listening, and the route tests open one (app.test.ts).
*/

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-api-'));
const PASSWORD = 'correct horse battery staple';
const HOST = '192.0.2.40:3333';

let hub: Hub;
let app: ReturnType<typeof createApp>['app'];
const bus = new FakeBus();
let account = '';
let cookie = '';

beforeAll(async () => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol);
  const transports = new TransportHost({ platform: 'server', context: { env: {}, log: () => {}, audit: () => {} } });
  transports.install(busDefinition, { create: () => bus });
  const types = new DeviceTypeRegistry();
  types.install(lampType);
  await transports.startAll(['bus']);
  hub = createHub({
    database: db(),
    audit: auditLog(),
    secrets: serverSecrets,
    sealing: serverSealing,
    installed: { types, protocols, transports },
    readOnly: () => false,
    http: () => Promise.reject(new Error('no network in these tests')),
    gateway: { verifyTimeoutMs: 300 },
  });
  const proxies = new ProxyDirectory('');
  app = createApp({ hub, config: loadConfig({ NODE_ENV: 'test' }, []), proxies, serverLog: { dir: null, recent: () => [] }, startedAt: new Date() }).app;
});

afterAll(async () => {
  await hub.stop();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db().exec('DELETE FROM device; DELETE FROM sample; DELETE FROM client; DELETE FROM users; DELETE FROM sessions; DELETE FROM app_state; DELETE FROM audit; DELETE FROM automation;');
  await hub.sessions.sync([]);
  bus.lamps.clear();
  account = (await createFirstUser('olof', PASSWORD)).id;
  const response = await app.fetch(
    new Request(`http://${HOST}/api/auth/login`, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json', 'x-kraftverk-client': 'test' }, body: JSON.stringify({ username: 'olof', password: PASSWORD }) }),
    { requestIP: () => ({ address: '192.168.1.58' }) }
  );
  cookie = /kraftverk_session=([^;]*)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? '';
});

/** The home, each way: the same person asking. */
const WAYS: { name: string; api: () => KraftverkApi }[] = [
  { name: 'in the process', api: () => hub.as({ kind: 'person', name: 'olof', account }) },
  {
    name: 'over HTTP',
    api: () =>
      httpApi({
        baseUrl: `http://${HOST}/api`,
        headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
        fetch: async (url, init) => app.fetch(new Request(url, { ...init, headers: { host: HOST, ...(init.headers as Record<string, string>) } }), { requestIP: () => ({ address: '192.168.1.58' }) }),
      }),
  },
];

/** A lamp on the bus, answering, added through setup as a person would. */
async function addLamp(home: KraftverkApi, name: string, address: string) {
  bus.lamps.set(address, { serial: address.toUpperCase(), model: 'L1', on: true, answers: true });
  bus.announce();
  const draft = await home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
  await home.setup.choose(draft.id, { address });
  expect((await home.setup.check(draft.id)).outcome).toBe('new');
  return home.setup.save(draft.id, { name });
}

/** What a call refused with: its kind and its words. */
const refused = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return { kind: (error as ApiError).kind, message: (error as ApiError).message };
  }
  throw new Error('It was not refused');
};

for (const way of WAYS) {
  describe(`the home, asked ${way.name}`, () => {
    test('says what can be added', async () => {
      const listing = await way.api().deviceTypes();
      const lamp = listing.types.find((type) => type.id === 'test.lamp')!;
      expect(lamp.availability.bus!.server).toEqual({ ok: true });
    });

    test('adds a device through setup, lists it, renames it, gives it a key — and refuses a key another has', async () => {
      const home = way.api();
      const hall = await addLamp(home, 'Hall', 'lamp-1');
      const porch = await addLamp(home, 'Porch', 'lamp-2');
      expect((await home.devices.list()).map((device) => device.name).sort()).toEqual(['Hall', 'Porch']);
      expect((await home.devices.update(hall.id, { name: 'Hall lamp', key: 'hall' })).key).toBe('hall');
      expect((await home.devices.get(hall.id)).name).toBe('Hall lamp');
      expect(await refused(home.devices.update(porch.id, { key: 'hall' }))).toEqual({ kind: 'conflict', message: 'Another device is known by "hall"' });
      expect(await refused(home.devices.get(savedDeviceId('d-nothing')))).toEqual({ kind: 'not-found', message: 'No such device' });
    });

    test('switches it through the gateway, and answers the verdict', async () => {
      const home = way.api();
      const lamp = await addLamp(home, 'Hall', 'lamp-1');
      const result = await home.devices.command(lamp.id, 'main', 'switch', 'set', { args: { on: false } });
      expect(['verified', 'unverified', 'refused']).toContain(result.outcome);
      // A part it does not have is the gateway's refusal, an answer; a capability it does not have is no such thing.
      expect((await home.devices.command(lamp.id, 'outlet.z', 'switch', 'set', { args: { on: true } })).outcome).toBe('refused');
      expect((await refused(home.devices.command(lamp.id, 'main', 'nothing.here', 'set', { args: {} }))).kind).toBe('not-found');
    });

    test('sets what the home decides, within its bounds — and puts it on the timeline', async () => {
      const home = way.api();
      expect((await home.policy.set('reserveSoc', 20)).find((value) => value.name === 'reserveSoc')!.value).toBe(20);
      expect((await refused(home.policy.set('reserveSoc', 1000))).kind).toBe('invalid');
      const [latest] = await home.timeline({ limit: 1 });
      expect(latest).toMatchObject({ kind: 'policy.changed', actor: 'olof' });
    });

    test('exports what it has, by key', async () => {
      const home = way.api();
      const lamp = await addLamp(home, 'Hall', 'lamp-1');
      await home.devices.update(lamp.id, { key: 'hall' });
      const exported = await home.configuration.export({ secrets: 'none' });
      expect(exported.text).toContain('hall:');
    });

    test('knows the apps of the account asking, and no other', async () => {
      const home = way.api();
      const app = await home.apps.register({ name: 'A test browser', platform: 'web', transports: [] });
      expect((await home.apps.list()).map((each) => each.id)).toEqual([app.id]);
      await home.apps.forget(app.id);
      expect(await refused(home.apps.forget(app.id))).toEqual({ kind: 'not-found', message: 'No such app' });
    });
  });
}

test('in the process, the live stream says hello first, then what moved', async () => {
  const heard: LiveUpdate[] = [];
  const home = hub.as({ kind: 'person', name: 'olof', account });
  const stream = home.live((update) => heard.push(update));
  await addLamp(home, 'Hall', 'lamp-1');
  await new Promise((resolve) => setTimeout(resolve, 400));
  stream.close();
  expect(heard[0]!.type).toBe('hello');
  expect(heard.some((update) => update.type === 'changed')).toBe(true);
});
