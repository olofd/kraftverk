import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { nodeId } from '@kraftverk/device-sdk';

import { LAMP, MACHINE_NODE } from '../src/testing.ts';
import { aHome, type TestHome } from './a-home.ts';

/**
 * Every device described the same way: what it is, how it is reached, how it
 * fits the house, and what it is doing. The app draws every card, detail
 * screen and connection list from this one shape, so what it says — and what
 * it must never say, a secret — is pinned down here, on a home made as every
 * hub test makes one.
 */

let t: TestHome;
beforeAll(async () => {
  t = await aHome();
});
afterAll(() => t.stop());

describe('a device, described', () => {
  test('joins what it is, how it is reached and how it fits the house', async () => {
    const { catalog, connections, links, sessions, views } = t.hub;
    t.lampAt('lamp-1', { serial: 'LAMP-1' });
    const hall = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Hall', config: { room: 'Hall' } });
    const porch = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Porch', config: { room: 'Porch' } });
    const connection = connections.add({ deviceId: hall.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-1' });
    connections.setSecrets(connection.id, { pin: '1234' });
    links.add({ kind: 'feeds', source: { device: hall.id, part: 'main' }, target: { device: porch.id, part: 'main' } });
    await sessions.sync(catalog.list());

    const view = views.find(hall.id)!;
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
    expect(views.find(porch.id)!.links).toEqual([expect.objectContaining({ role: 'target', other: { id: hall.id, name: 'Hall', part: 'main', partLabel: '' } })]);
    // One device's view is the same as the whole home's says it.
    expect(views.all().find((each) => each.id === hall.id)).toEqual(view);
  });

  test('a device of a type nobody installed is still listed, and says so', () => {
    const mystery = t.hub.catalog.add({ description: { attributes: [] }, typeId: 'nobody.knows', name: 'Mystery' });
    expect(t.hub.views.find(mystery.id)).toMatchObject({ installed: false, meta: { name: 'nobody.knows', category: 'unknown' }, capabilities: [], readings: [] });
  });

  test('a removed device is listed apart, with its history kept and no session', async () => {
    const { catalog, sessions, views } = t.hub;
    const gone = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Gone' });
    catalog.remove(gone.id);
    await sessions.sync(catalog.list());

    expect(views.all().map((device) => device.id)).not.toContain(gone.id);
    const removed = views.removed().find((device) => device.id === gone.id)!;
    expect(removed.removedAt).not.toBeNull();
    expect(removed.health.detail).toContain('history is kept');
  });

  test('a connection another node holds names that node', () => {
    const { catalog, connections, nodes, views } = t.hub;
    const phone = nodes.join({ id: nodeId('n-000000000000c0de'), name: 'Olof’s iPhone', platform: 'native', transports: ['ble'], alwaysOn: false, reachable: false, trusted: false }, 'u-reg');
    const pocket = catalog.add({ description: LAMP, typeId: 'test.lamp', name: 'Pocket' });
    connections.add({ deviceId: pocket.id, method: 'bus', transport: 'bus', heldBy: phone.id, address: 'lamp-7' });

    expect(views.find(pocket.id)!.connections[0]!.heldBy).toEqual({ kind: 'node', id: phone.id, name: 'Olof’s iPhone' });
  });
});
