import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { nodeId } from '@kraftverk/device-sdk';
import { SessionManager } from '@kraftverk/holder';
import { ConnectionStore, DeviceCatalog, deviceStore, HistoryStore, holding, LinkStore, NodeStore, plainSecrets } from '@kraftverk/store';

import { DeviceRegistry } from '../src/devices/registry.ts';
import { RemoteReadings } from '../src/devices/remote.ts';
import { ProtocolRegistry } from '../src/installed/protocols.ts';
import { TransportHost } from '../src/installed/transports.ts';
import { DeviceTypeRegistry } from '../src/installed/types.ts';
import { busDefinition, FakeBus, LAMP, lampProtocol, lampType, MACHINE_NODE } from '../src/testing.ts';
import { testDatabase } from './home.ts';

/**
 * Every device described the same way: what it is, how it is reached, how it
 * fits the house, and what it is doing. The app draws every card, detail
 * screen and connection list from this one shape, so what it says — and what
 * it must never say, a secret — is pinned down here.
 */

const db = testDatabase();
let catalog: DeviceCatalog;
let connections: ConnectionStore;
let links: LinkStore;
let nodes: NodeStore;
let sessions: SessionManager;
let registry: DeviceRegistry;
const bus = new FakeBus();

beforeAll(() => {
  catalog = new DeviceCatalog(db);
  connections = new ConnectionStore(db, plainSecrets);
  links = new LinkStore(db);
  nodes = new NodeStore(db);
  // This node, the home's master.
  nodes.declareSelf({ ...MACHINE_NODE, platform: 'system', transports: ['bus'] });
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol);
  const transports = new TransportHost({ platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } });
  transports.install(busDefinition, { create: () => bus });
  const types = new DeviceTypeRegistry();
  types.install(lampType);
  sessions = new SessionManager({
    platform: 'system',
    node: { id: MACHINE_NODE.id, name: MACHINE_NODE.name },
    types,
    protocols,
    transports,
    ...holding(connections, MACHINE_NODE.id),
    store: (id) => deviceStore(db, id),
    readOnly: () => false,
    allowRawFrames: false,
    nodeName: (id) => nodes.get(id)?.name ?? null,
  });
  registry = new DeviceRegistry({ catalog, types, sessions, connections, links, nodes, transports, remote: new RemoteReadings(new HistoryStore(db)), self: MACHINE_NODE.id, master: () => MACHINE_NODE.id, readOnly: () => false });
});

afterAll(async () => {
  await sessions.closeAll();
});

describe('a device, described', () => {
  test('joins what it is, how it is reached and how it fits the house', async () => {
    bus.lamps.set('lamp-1', { serial: 'LAMP-1', model: 'L1', on: true, answers: true });
    const hall = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Hall', config: { room: 'Hall' } });
    const porch = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Porch', config: { room: 'Porch' } });
    const connection = connections.add({ deviceId: hall.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-1' });
    connections.setSecrets(connection.id, { pin: '1234' });
    links.add({ kind: 'feeds', source: { device: hall.id, part: 'main' }, target: { device: porch.id, part: 'main' } });
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
      links: [{ kind: 'feeds', role: 'source', part: 'main', other: { id: porch.id, name: 'Porch', part: 'main', partLabel: '' } }],
    });
    expect(view.tools.map((tool) => [tool.name, tool.writes, tool.answer.type])).toEqual([
      ['ping', false, 'object'],
      ['blink', true, 'object'],
    ]);
    expect(view.connections).toEqual([
      expect.objectContaining({ method: 'bus', methodLabel: 'Test bus', transport: 'bus', heldBy: { kind: 'master', id: MACHINE_NODE.id, name: 'Test machine' }, address: 'lamp-1', inUse: true, secrets: ['pin'] }),
    ]);
    // Which secrets, never their values.
    expect(JSON.stringify(view)).not.toContain('1234');
    expect(registry.find(porch.id)!.links).toEqual([expect.objectContaining({ role: 'target', other: { id: hall.id, name: 'Hall', part: 'main', partLabel: '' } })]);
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

  test('a connection another node holds names that node', () => {
    const phone = nodes.join({ id: nodeId('n-00000000c0de'), name: 'Olof’s iPhone', platform: 'native', transports: ['ble'], alwaysOn: false, reachable: false, trusted: false }, 'u-reg');
    const pocket = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Pocket' });
    connections.add({ deviceId: pocket.id, method: 'bus', transport: 'bus', heldBy: phone.id, address: 'lamp-7' });

    expect(registry.find(pocket.id)!.connections[0]!.heldBy).toEqual({ kind: 'node', id: phone.id, name: 'Olof’s iPhone' });
  });
});
