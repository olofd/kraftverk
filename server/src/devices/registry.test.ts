import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, db } from '../history/db.ts';
import { ProtocolRegistry } from '../runtime/protocols.ts';
import { TransportHost } from '../runtime/transports.ts';
import { DeviceCatalog } from './catalog.ts';
import { ClientStore } from './clients.ts';
import { ConnectionStore } from './connections.ts';
import { LinkStore } from './links.ts';
import { DeviceRegistry } from './registry.ts';
import { RemoteReadings } from './remote.ts';
import { DeviceSessionManager } from './sessions.ts';
import { busDefinition, FakeBus, LAMP, lampProtocol, lampType } from './testing.ts';
import { DeviceTypeRegistry } from './types.ts';

/**
 * Every device described the same way: what it is, how it is reached, how it
 * fits the house, and what it is doing. The app draws every card, detail
 * screen and connection list from this one shape, so what it says — and what
 * it must never say, a secret — is pinned down here.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-registry-'));
let catalog: DeviceCatalog;
let connections: ConnectionStore;
let links: LinkStore;
let clients: ClientStore;
let sessions: DeviceSessionManager;
let registry: DeviceRegistry;
const bus = new FakeBus();

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  catalog = new DeviceCatalog();
  connections = new ConnectionStore();
  links = new LinkStore();
  clients = new ClientStore();
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol);
  const transports = new TransportHost({ enabled: () => ({ ok: true }), context: { env: {}, log: () => {}, audit: () => {} } });
  transports.install(busDefinition, { create: () => bus });
  const types = new DeviceTypeRegistry();
  types.install(lampType);
  sessions = new DeviceSessionManager({ types, protocols, transports, connections, simulate: false, readOnly: false, allowRawFrames: false, clientName: (id) => clients.get(id)?.name ?? null });
  registry = new DeviceRegistry({ catalog, types, sessions, connections, links, clients, transports, remote: new RemoteReadings() });
});

afterAll(async () => {
  await sessions.closeAll();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('a device, described', () => {
  test('joins what it is, how it is reached and how it fits the house', async () => {
    bus.lamps.set('lamp-1', { serial: 'LAMP-1', model: 'L1', on: true, answers: true });
    const hall = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Hall', config: { room: 'Hall' } });
    const porch = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Porch', config: { room: 'Porch' } });
    const connection = connections.add({ deviceId: hall.id, method: 'bus', transport: 'bus', heldBy: null, address: 'lamp-1' });
    connections.setSecrets(connection.id, { pin: '1234' });
    links.add({ kind: 'feeds', sourceId: hall.id, targetId: porch.id });
    await sessions.sync(catalog.list());

    const view = registry.find(hall.id)!;
    expect(view).toMatchObject({
      id: hall.id,
      typeId: 'test.lamp',
      installed: true,
      name: 'Hall',
      kind: 'hardware',
      meta: { name: 'Test lamp', category: 'smart-plug' },
      capabilities: ['switch'],
      config: { room: 'Hall' },
      links: [{ kind: 'feeds', role: 'source', other: { id: porch.id, name: 'Porch' } }],
      advanced: [
        { name: 'ping', writes: false },
        { name: 'blink', writes: true },
      ],
    });
    expect(view.connections).toEqual([
      expect.objectContaining({ method: 'bus', methodLabel: 'Test bus', transport: 'bus', heldBy: { kind: 'server' }, address: 'lamp-1', inUse: true, secrets: ['pin'] }),
    ]);
    // Which secrets, never their values.
    expect(JSON.stringify(view)).not.toContain('1234');
    expect(registry.find(porch.id)!.links).toEqual([expect.objectContaining({ role: 'target', other: { id: hall.id, name: 'Hall' } })]);
  });

  test('a device of a type nobody installed is still listed, and says so', () => {
    const mystery = catalog.add({ description: { attributes: [] }, typeId: 'nobody.knows', name: 'Mystery' });
    expect(registry.find(mystery.id)).toMatchObject({ installed: false, meta: { name: 'nobody.knows', category: 'unknown' }, capabilities: [], readings: [] });
  });

  test('a removed device is listed apart, with its history kept and no session', async () => {
    const gone = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Gone' });
    catalog.remove(gone.id);
    await sessions.sync(catalog.list());

    expect(registry.all().map((device) => device.id)).not.toContain(gone.id);
    const removed = registry.removed().find((device) => device.id === gone.id)!;
    expect(removed.removedAt).not.toBeNull();
    expect(removed.health.detail).toContain('history is kept');
  });

  test('a connection held by a phone names the phone', () => {
    db().exec("INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES ('u-reg', 'registry', 'x', '2026-01-01', '2026-01-01')");
    const phone = clients.register({ userId: 'u-reg', name: 'Olof’s iPhone', platform: 'native', transports: ['ble'] });
    const pocket = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Pocket' });
    connections.add({ deviceId: pocket.id, method: 'bus', transport: 'bus', heldBy: phone.id, address: 'lamp-7' });

    expect(registry.find(pocket.id)!.connections[0]!.heldBy).toEqual({ kind: 'client', id: phone.id, name: 'Olof’s iPhone' });
  });
});
