import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { SIMULATED_ADDRESS, SIMULATED_METHOD_ID, SIMULATED_TRANSPORT, type NodeId, type SavedDeviceId } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';
import { SessionManager } from '@kraftverk/holder';
import { ConnectionStore, DeviceCatalog, deviceStore, holding, NodeStore, plainSecrets, type SqlDatabase } from '@kraftverk/store';

import { DeviceTypeRegistry, ProtocolRegistry, TransportHost } from '../src/index.ts';
import { APP_NODE, LAMP, lampProtocol, MACHINE_NODE, makeHubType, relayedLampType, relayProtocol, TEST_INTEGRATION, TEST_SOURCE, type HubWatch } from '../src/testing.ts';
import { testDatabase } from './home.ts';

/*
  A bridge and its members (docs/PLAN-INTEGRATIONS.md §4.3), as the nodes of
  a home hold them: a member is reached through its bridge's open session,
  held wherever the bridge is, closed with it, and follows it to another node.
  The hub here is simulated; its lamps' sessions are real, over the channels
  the hub opens for them.
*/

let db: SqlDatabase;
let catalog: DeviceCatalog;
let connections: ConnectionStore;
let watch: HubWatch;
let managers: SessionManager[] = [];

const build = (node: { id: NodeId; name: string }) => {
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol, 'test');
  protocols.install(relayProtocol, 'test');
  const transports = new TransportHost({ platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } });
  const types = new DeviceTypeRegistry();
  const hub = makeHubType();
  watch = hub.watch;
  types.installIntegration(TEST_INTEGRATION);
  expect(types.install(hub.type, TEST_SOURCE)).toEqual([]);
  expect(types.install(relayedLampType, TEST_SOURCE)).toEqual([]);
  const manager = new SessionManager({
    platform: 'system',
    node,
    types,
    protocols,
    transports,
    ...holding(connections, node.id),
    store: (deviceId) => deviceStore(db, deviceId),
    readOnly: () => false,
    allowRawFrames: false,
  });
  managers.push(manager);
  return manager;
};

beforeAll(() => {
  db = testDatabase();
  catalog = new DeviceCatalog(db);
  connections = new ConnectionStore(db, plainSecrets);
  const nodes = new NodeStore(db);
  nodes.declareSelf({ ...MACHINE_NODE, platform: 'system', transports: [] });
  nodes.join({ ...APP_NODE, platform: 'web', transports: [] }, null);
});

afterAll(() => db.close());

beforeEach(async () => {
  await Promise.all(managers.map((manager) => manager.closeAll()));
  managers = [];
  db.exec('DELETE FROM device');
});

/** The hub, simulated and held by `node`, and the two lamps behind it, each reached through it. */
const addHub = (node: NodeId = MACHINE_NODE.id) => {
  const hub = catalog.add({ description: { parts: [], attributes: [] }, typeId: 'test.hub', name: 'Hub', config: {}, identity: null });
  connections.add({ deviceId: hub.id, method: SIMULATED_METHOD_ID, transport: SIMULATED_TRANSPORT, heldBy: node, address: SIMULATED_ADDRESS });
  const lamps = ['lamp-a', 'lamp-b'].map((key) => {
    const lamp = catalog.add({ description: LAMP, typeId: 'test.relayed-lamp', name: key, config: {}, identity: null });
    connections.add({ deviceId: lamp.id, method: 'hub', transport: 'bridge', through: hub.id, address: key });
    return lamp.id;
  });
  return { hub: hub.id, lamps: lamps as [SavedDeviceId, SavedDeviceId] };
};

const eventually = async (check: () => boolean, ms = 1000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  return check();
};

const on = (manager: SessionManager, id: SavedDeviceId) => manager.get(id)?.readings().find((reading) => reading.key === 'on')?.value ?? null;

describe('a bridge and its members', () => {
  test('two members open through their bridge, each over a channel of its own, and are switched through it', async () => {
    const sessions = build(MACHINE_NODE);
    const { hub, lamps } = addHub();
    await sessions.sync(catalog.list());

    expect(sessions.get(hub)).not.toBeNull();
    for (const lamp of lamps) {
      expect(sessions.get(lamp)).not.toBeNull();
      expect(sessions.inUse(lamp)).toMatchObject({ transport: 'bridge', through: hub });
    }
    expect([...watch.opened].sort()).toEqual(['lamp-a', 'lamp-b']);
    expect(await eventually(() => on(sessions, lamps[0]) === false && on(sessions, lamps[1]) === true)).toBe(true);

    await sessions.get(lamps[0])!.command({ part: 'main', capability: 'switch', command: 'set', args: { on: true } });
    expect(watch.lamps.get('lamp-a')!.on).toBe(true);
    expect(await eventually(() => on(sessions, lamps[0]) === true)).toBe(true);
  });

  test('a bridge closing closes its members, which say why; opened again, they come back over it', async () => {
    const sessions = build(MACHINE_NODE);
    const { hub, lamps } = addHub();
    await sessions.sync(catalog.list());

    await sessions.close(hub);
    for (const lamp of lamps) {
      expect(sessions.get(lamp)).toBeNull();
      expect(sessions.health({ id: lamp }).detail).toBe('Reached through Hub, which closed');
    }
    expect([...watch.closed].sort()).toEqual(['lamp-a', 'lamp-b']);

    await sessions.sync(catalog.list());
    for (const lamp of lamps) expect(sessions.get(lamp)).not.toBeNull();
  });

  test('members are held wherever their bridge is, and follow it to another node', async () => {
    const machine = build(MACHINE_NODE);
    const app = build(APP_NODE);
    // The hub is held by the app: there, and only there, its lamps open.
    const { hub, lamps } = addHub(APP_NODE.id);
    await Promise.all([machine.sync(catalog.list()), app.sync(catalog.list())]);
    for (const lamp of lamps) {
      expect(app.get(lamp)).not.toBeNull();
      expect(machine.get(lamp)).toBeNull();
      expect(machine.health({ id: lamp }).detail).toBe('Reached through Hub, which is not open on Test machine');
    }

    // The hub moves to the machine: its lamps go with it.
    const [held] = connections.forDevice(hub);
    connections.remove(held!.id);
    connections.add({ deviceId: hub, method: SIMULATED_METHOD_ID, transport: SIMULATED_TRANSPORT, heldBy: MACHINE_NODE.id, address: SIMULATED_ADDRESS });
    await Promise.all([machine.sync(catalog.list()), app.sync(catalog.list())]);
    for (const lamp of lamps) {
      expect(machine.get(lamp)).not.toBeNull();
      expect(app.get(lamp)).toBeNull();
    }
  });

  test('a bridge keeps the contract: its simulator brings members and opens each; a member keeps it as any device does', async () => {
    const { type } = makeHubType();
    expect(await checkDeviceTypeContract(type)).toEqual([]);
    expect(await checkDeviceTypeContract(relayedLampType)).toEqual([]);
    // A session that offers members, of a type that does not say it is a bridge, breaks it.
    const { bridge: _bridge, ...notBridge } = type;
    expect(await checkDeviceTypeContract({ ...notBridge, id: 'test.not-a-hub' })).toContain('its session offers members (`bridge`), but its type does not say it is a bridge');
  });

  test('a way through a bridge is one row: held by no node, through one device, its key its address — never both', () => {
    const { hub, lamps } = addHub();
    expect(connections.forDevice(lamps[0])).toEqual([expect.objectContaining({ heldBy: null, through: hub, transport: 'bridge', address: 'lamp-a' })]);
    expect(connections.through(hub).map((connection) => connection.address).sort()).toEqual(['lamp-a', 'lamp-b']);
    expect(connections.member(hub, 'lamp-b')?.deviceId).toBe(lamps[1]);
    // The schema holds a row to one or the other.
    expect(() => db.query("INSERT INTO device_connection (id, device_id, method, transport, held_by, through, address, secrets_exportable, created_at) VALUES ('c-both', ?, 'hub', 'bridge', ?, ?, 'x', 0, 'now')").run(lamps[0], MACHINE_NODE.id, hub)).toThrow();
    expect(() => db.query("INSERT INTO device_connection (id, device_id, method, transport, held_by, through, address, secrets_exportable, created_at) VALUES ('c-none', ?, 'hub', 'bridge', NULL, NULL, 'x', 0, 'now')").run(lamps[0])).toThrow();
    expect(() => db.query("INSERT INTO device_connection (id, device_id, method, transport, held_by, through, address, secrets_exportable, created_at) VALUES ('c-self', ?, 'hub', 'bridge', NULL, ?, 'x', 0, 'now')").run(lamps[0], lamps[0])).toThrow();
  });
});
