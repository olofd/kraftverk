import { expect, test } from 'bun:test';

import { BRIDGE_TRANSPORT, isBridged } from './bridge.ts';
import { placementsOf, platformsOf, type ConnectionMethod } from './connection.ts';
import { defineDeviceType, type DeviceType } from './device-type.ts';
import type { Protocol } from './protocol.ts';
import { connectionProblems, validateDeviceType } from './validate.ts';

/*
  A way through a bridge (docs/PLAN-INTEGRATIONS.md §4.3): it rides the
  bridge's own transport, names the bridge types it goes through, has no
  fixed address, and is held wherever its bridge can be.
*/

const member = (connection: Partial<ConnectionMethod>): DeviceType =>
  defineDeviceType({
    id: 'acme.member',
    kind: 'hardware',
    meta: { name: 'Member', category: 'smart-plug', support: 'experimental', icon: 'power' },
    config: { fields: {} },
    describe: () => ({ parts: [], attributes: [] }),
    connections: [{ id: 'through', label: 'Through the hub', protocol: 'acme-relay', transport: BRIDGE_TRANSPORT, through: ['acme.hub'], reach: 'local', ...connection }],
    identify: async () => ({ identity: null, model: null, summary: '' }),
    createSession: async () => {
      throw new Error('not here');
    },
    createSimulator: async () => {
      throw new Error('not here');
    },
  });

test('a way through a bridge names which bridges, and only such a way does', () => {
  expect(validateDeviceType(member({}))).toEqual([]);
  expect(validateDeviceType(member({ through: [] }))).toEqual(['connection method "through" goes through a bridge without naming which: "through" lists the bridge types']);
  expect(validateDeviceType(member({ transport: 'lan' }))).toEqual(['connection method "through" names bridges in "through", but goes over "lan", not "bridge"']);
  expect(validateDeviceType(member({ address: 'fixed' }))).toEqual(['connection method "through" goes through a bridge, so it has no fixed address: a member\'s is its key']);
  expect(validateDeviceType(member({ through: ['Not a type'] }))).toEqual(['connection method "through" goes through "Not a type", which is not a type\'s id']);
});

test('installed, its protocol rides the bridge, and what it goes through is an installed bridge', () => {
  const relay: Protocol = { id: 'acme-relay', label: 'Relay', bindings: { bridge: { open: () => ({}), recognise: () => null } } };
  const hub = { ...member({}), id: 'acme.hub', bridge: {} } as DeviceType;
  const plain = { ...member({}), id: 'acme.hub' } as DeviceType;
  const installed = (types: Record<string, DeviceType>, protocol: Protocol | null = relay) => ({ protocol: () => protocol, transport: () => null, type: (id: string) => types[id] ?? null });
  expect(connectionProblems(member({}), installed({ 'acme.hub': hub }))).toEqual([]);
  expect(connectionProblems(member({}), installed({}))).toEqual(['connection method "through" goes through "acme.hub", which is not installed']);
  expect(connectionProblems(member({}), installed({ 'acme.hub': plain }))).toEqual(['connection method "through" goes through "acme.hub", which is not a bridge']);
  expect(connectionProblems(member({}), installed({ 'acme.hub': hub }, { ...relay, bindings: {} }))).toEqual(['connection method "through": "acme-relay" has no binding for "bridge"']);
});

test('a member is held wherever its bridge is: every platform, and it needs nothing of a node itself', () => {
  const way = member({}).connections[0]!;
  expect(isBridged(way)).toBe(true);
  expect(platformsOf(way, null)).toEqual(['system', 'web', 'native']);
  expect(placementsOf(member({}), () => null)).toEqual([{ method: 'through', platforms: ['system', 'web', 'native'], needs: {} }]);
});

test('where a member runs, said: where its bridge can be held, and what that needs of a node', () => {
  const account = { connections: [{ id: 'cloud', label: 'Cloud', protocol: 'acme-cloud', transport: 'https', reach: 'cloud', platforms: ['system', 'native'], needs: { trusted: 'the password stays home' } }] as ConnectionMethod[] };
  const https = { platforms: ['system', 'web', 'native'] as const };
  const placements = placementsOf(member({}), (id) => (id === 'https' ? { platforms: [...https.platforms] } : null), (id) => (id === 'acme.hub' ? account : null));
  expect(placements).toEqual([{ method: 'through', platforms: ['system', 'native'], needs: { trusted: 'the password stays home' } }]);
});
