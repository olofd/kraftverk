import { expect, test } from 'bun:test';

import type { Bridge, MemberLink } from './bridge.ts';
import { isBridgedMethod, linkOf, placementsOf, platformsOf, transportOf, type BridgedMethod, type ConnectionMethod } from './connection.ts';
import { defineDeviceType, type DeviceType } from './device-type.ts';
import { connectionProblems, validateDeviceType } from './validate.ts';

/*
  A way through a bridge (docs/PLAN-INTEGRATIONS.md §4.3): it names the bridge
  types it goes through and nothing of a transport's — no protocol, no
  transport, no fixed address — reads its bridge through a link of calls,
  and is held wherever its bridge can be.
*/

const member = (connection: Partial<BridgedMethod> = {}): DeviceType =>
  defineDeviceType({
    id: 'acme.member',
    kind: 'hardware',
    meta: { name: 'Member', category: 'smart-plug', support: 'experimental', icon: 'power' },
    config: { fields: {} },
    describe: () => ({ parts: [], attributes: [] }),
    connections: [{ id: 'through', label: 'Through the hub', through: ['acme.hub'], reach: 'local', updates: 'poll', ...connection }],
    identify: async () => ({ identity: null, model: null, summary: '' }),
    createSession: async () => {
      throw new Error('not here');
    },
    createSimulator: async () => {
      throw new Error('not here');
    },
  });

test('a way through a bridge names which bridges, and nothing of a transport', () => {
  expect(validateDeviceType(member())).toEqual([]);
  expect(validateDeviceType(member({ through: [] }))).toEqual(['connection method "through" goes through a bridge without naming which: "through" lists the bridge types']);
  expect(validateDeviceType(member({ through: ['Not a type'] }))).toEqual(['connection method "through" goes through "Not a type", which is not a type\'s id']);
  const withTransport = { ...member(), connections: [{ ...member().connections[0]!, transport: 'lan' } as unknown as ConnectionMethod] } as DeviceType;
  expect(validateDeviceType(withTransport)).toEqual(['connection method "through" goes through a bridge, so it has no transport of its own: it reads its bridge through a link']);
});

test('installed, what it goes through is an installed bridge', () => {
  const hub = { ...member(), id: 'acme.hub', bridge: {} } as DeviceType;
  const plain = { ...member(), id: 'acme.hub' } as DeviceType;
  const installed = (types: Record<string, DeviceType>) => ({ protocol: () => null, transport: () => null, type: (id: string) => types[id] ?? null });
  expect(connectionProblems(member(), installed({ 'acme.hub': hub }))).toEqual([]);
  expect(connectionProblems(member(), installed({}))).toEqual(['connection method "through" goes through "acme.hub", which is not installed']);
  expect(connectionProblems(member(), installed({ 'acme.hub': plain }))).toEqual(['connection method "through" goes through "acme.hub", which is not a bridge']);
});

test('a member is kept under the bridge, and held wherever its bridge is', () => {
  const way = member().connections[0]!;
  expect(isBridgedMethod(way)).toBe(true);
  expect(transportOf(way)).toBe('bridge');
  expect(platformsOf(way, null)).toEqual(['system', 'web', 'native']);
  expect(placementsOf(member(), () => null)).toEqual([{ method: 'through', platforms: ['system', 'web', 'native'], needs: {} }]);
});

test('where a member runs, said: where its bridge can be held, and what that needs of a node', () => {
  const account = { connections: [{ id: 'cloud', label: 'Cloud', protocol: 'acme-cloud', transport: 'https', reach: 'cloud', updates: 'poll', platforms: ['system', 'native'], needs: { trusted: 'the password stays home' } }] as ConnectionMethod[] };
  const https = { platforms: ['system', 'web', 'native'] as const };
  const placements = placementsOf(member(), (id) => (id === 'https' ? { platforms: [...https.platforms] } : null), (id) => (id === 'acme.hub' ? account : null));
  expect(placements).toEqual([{ method: 'through', platforms: ['system', 'native'], needs: { trusted: 'the password stays home' } }]);
});

test('a member reads its bridge through a link of plain calls, and lets go of it', async () => {
  type Lamp = MemberLink & { level(): number };
  let changed = () => {};
  let closed = 0;
  const bridge: Bridge<Lamp> = {
    members: () => [{ key: 'lamp-1', name: 'Hall', model: null, identity: null, typeId: null, about: null, joining: false }],
    link: async (key, onChange) => {
      if (key !== 'lamp-1') throw new Error('Not behind this hub');
      changed = onChange;
      return { level: () => 40, close: () => void (closed += 1) };
    },
  };
  let heard = 0;
  const connection = { kind: 'bridged', method: 'through', address: 'lamp-1', config: {}, platform: 'system', link: (onChange: () => void) => bridge.link('lamp-1', onChange) } as const;
  const lamp = await linkOf<Lamp>(connection, () => void (heard += 1), 'Through its hub');
  expect(lamp.level()).toBe(40);
  changed();
  expect(heard).toBe(1);
  lamp.close();
  expect(closed).toBe(1);
  await expect(linkOf(null, () => {}, 'Through its hub')).rejects.toThrow('Through its hub');
  await expect(bridge.link('lamp-9', () => {})).rejects.toThrow('Not behind this hub');
});
