import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineDeviceType, type DeviceContext, type DeviceSession } from '@kraftverk/device-sdk';

import { closeDb, db } from '../history/db.ts';
import { DeviceCatalog } from './catalog.ts';
import { DeviceSessionManager } from './sessions.ts';
import { DeviceTypeRegistry } from './types.ts';

/**
 * One session per saved device, whatever it is.
 *
 * The manager knows no product, so these use a type of their own: a lamp with
 * an address. What is pinned down is the part that makes "a device type" more
 * than one global driver — each device gets its own config, its own store and
 * its own lifecycle — and that a device which cannot open says why.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-sessions-'));

type LampConfig = { host: string };

/** Every context the type was opened with, and whether each session was closed. */
const opened: { ctx: DeviceContext<LampConfig>; closed: boolean }[] = [];
let failOpen = false;

const lampSession = (ctx: DeviceContext<LampConfig>): DeviceSession => {
  const entry = { ctx, closed: false };
  opened.push(entry);
  const at = new Date().toISOString();
  return {
    health: () => ({ status: 'connected', detail: `Lamp at ${ctx.config.host}`, owner: 'server', transport: 'test', lastReadingAt: at }),
    readings: () => [{ key: 'on', value: true, at }],
    capability: () => null,
    close: async () => {
      entry.closed = true;
    },
  };
};

const lamp = defineDeviceType<LampConfig>({
  id: 'test.lamp',
  apiVersion: '2',
  kind: 'hardware',
  meta: { name: 'Test lamp', category: 'light', support: 'experimental', icon: 'sun' },
  protocols: [],
  capabilities: [],
  telemetry: [{ key: 'on', label: 'On', unit: '', kind: 'state' }],
  config: { fields: { host: { type: 'host', title: 'Address', required: true } } },
  setup: { steps: [{ id: 'check', kind: 'verify', title: 'Check', run: async () => ({ ok: true, detail: 'fine' }) }] },
  async createSession(ctx) {
    if (failOpen) throw new Error('The lamp refused the connection');
    return lampSession(ctx);
  },
  async createSimulator(ctx) {
    return lampSession(ctx);
  },
});

let catalog: DeviceCatalog;
let sessions: DeviceSessionManager;

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  catalog = new DeviceCatalog();
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sessions?.closeAll();
  db().exec('DELETE FROM device');
  opened.length = 0;
  failOpen = false;
  const types = new DeviceTypeRegistry();
  expect(types.install(lamp)).toEqual([]);
  sessions = new DeviceSessionManager({ types, simulate: false, readOnly: false, transports: { get: () => null } });
});

const addLamp = (name: string, config: Record<string, unknown>) =>
  catalog.add({ type: 'light', driver: 'test.lamp', name, config });

describe('one session per device', () => {
  test('two devices of one type run side by side, each with its own config', async () => {
    const hall = addLamp('Hall', { host: '192.0.2.1' });
    const porch = addLamp('Porch', { host: '192.0.2.2' });
    await sessions.sync(catalog.list());

    expect(sessions.get(hall.id)!.health().detail).toBe('Lamp at 192.0.2.1');
    expect(sessions.get(porch.id)!.health().detail).toBe('Lamp at 192.0.2.2');
  });

  test('each device has a store of its own', async () => {
    const hall = addLamp('Hall', { host: '192.0.2.1' });
    const porch = addLamp('Porch', { host: '192.0.2.2' });
    await sessions.sync(catalog.list());

    const [first, second] = opened.map((entry) => entry.ctx);
    first!.store.set('brightness', 80);
    expect(first!.store.get<number>('brightness')).toBe(80);
    expect(second!.store.get('brightness')).toBeNull();
    expect([hall.id, porch.id]).toContain(first!.deviceId);
  });

  test('forgetting a device closes its session, and its store goes with it', async () => {
    const hall = addLamp('Hall', { host: '192.0.2.1' });
    await sessions.sync(catalog.list());
    opened[0]!.ctx.store.set('brightness', 80);

    catalog.remove(hall.id);
    await sessions.sync(catalog.list());

    expect(sessions.get(hall.id)).toBeNull();
    expect(opened[0]!.closed).toBe(true);
    expect(db().query('SELECT COUNT(*) AS n FROM device_kv').get()).toEqual({ n: 0 });
  });

  test('a changed config reopens the device with the new one', async () => {
    const hall = addLamp('Hall', { host: '192.0.2.1' });
    await sessions.sync(catalog.list());
    catalog.update(hall.id, { config: { host: '192.0.2.9' } });
    await sessions.sync(catalog.list());

    expect(opened[0]!.closed).toBe(true);
    expect(sessions.get(hall.id)!.health().detail).toBe('Lamp at 192.0.2.9');
  });
});

describe('a device that cannot open is still a device, saying why', () => {
  test('a config its type rejects is "needs setting up", not an error', async () => {
    const record = addLamp('Hall', {});
    await sessions.sync(catalog.list());

    expect(sessions.get(record.id)).toBeNull();
    expect(sessions.health(record)).toMatchObject({ status: 'unconfigured' });
    expect(sessions.health(record).detail).toContain('Address is required');
  });

  test('a key its type no longer knows does not stop it opening', async () => {
    const record = addLamp('Hall', { host: '192.0.2.1', retiredField: 'from an older version' });
    await sessions.sync(catalog.list());

    expect(sessions.get(record.id)).not.toBeNull();
    expect(opened[0]!.ctx.config).toEqual({ host: '192.0.2.1' });
  });

  test('a session that fails to open is an error, with the reason', async () => {
    failOpen = true;
    const record = addLamp('Hall', { host: '192.0.2.1' });
    await sessions.sync(catalog.list());

    expect(sessions.health(record)).toMatchObject({ status: 'error', detail: 'The lamp refused the connection' });
  });

  test('a device no installed type claims gets no session at all', async () => {
    const record = catalog.add({ type: 'light', driver: 'nobody.knows', name: 'Mystery' });
    await sessions.sync(catalog.list());
    expect(sessions.typeOf(record)).toBeNull();
    expect(sessions.get(record.id)).toBeNull();
  });
});

test('simulated, every device is opened through its type’s simulator', async () => {
  const types = new DeviceTypeRegistry();
  types.install({ ...lamp, createSession: async () => { throw new Error('no hardware here'); } });
  const simulated = new DeviceSessionManager({ types, simulate: true, readOnly: false, transports: { get: () => null } });
  const record = addLamp('Hall', { host: '192.0.2.1' });
  await simulated.sync(catalog.list());
  expect(simulated.get(record.id)).not.toBeNull();
  await simulated.closeAll();
});
