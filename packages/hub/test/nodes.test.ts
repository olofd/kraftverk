import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { NodeJoin, NodeView } from '@kraftverk/api-contract';
import { nodeId } from '@kraftverk/device-sdk';

import { MACHINE_NODE } from '../src/testing.ts';
import { aHome, GUEST, refusal, type TestHome } from './a-home.ts';

/*
  The home and its nodes (docs/DATA-MODEL.md §3), asked of the home: its
  master, and the nodes that join it — each by its own id, for the account
  it joins from, and forgotten only by its person.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

describe('the home and its nodes', () => {
  test('the home names its master: this machine, a node of its own', async () => {
    expect(await t.home.home()).toMatchObject({ name: 'Home', master: MACHINE_NODE.id });
  });

  test('a node joins by its own id, for the account it joins from; the home lists every node; only its person forgets it', async () => {
    const phone: NodeJoin = { id: nodeId('n-0000000000000000000000AA02'), name: 'Olof’s iPhone', platform: 'native', transports: ['ble'], alwaysOn: false, reachable: false, trusted: false };
    expect(await t.home.nodes.join(phone)).toMatchObject({ id: phone.id, master: false, yours: true });
    const names = (nodes: NodeView[]) => nodes.map((node) => [node.name, node.master]);
    expect(names(await t.home.nodes.list())).toEqual([[MACHINE_NODE.name, true], ['Olof’s iPhone', false]]);
    // Said again at the next start, it is the same node.
    expect((await t.home.nodes.join({ ...phone, transports: ['ble', 'https'] })).transports).toEqual(['ble', 'https']);

    // Another account can neither take this phone's id nor forget it.
    const guest = t.as(GUEST);
    expect((await refusal(guest.nodes.join({ ...phone, name: 'Mine now' }))).kind).toBe('conflict');
    expect((await refusal(guest.nodes.forget(phone.id))).kind).toBe('not-found');
    // Nor is the master forgotten.
    expect((await refusal(t.home.nodes.forget(MACHINE_NODE.id))).kind).toBe('not-found');
    // An assistant joins nothing: it has no account.
    expect((await refusal(t.as({ kind: 'agent', for: 'olof' }).nodes.join(phone))).kind).toBe('forbidden');

    await t.home.nodes.forget(phone.id);
    expect(names(await t.home.nodes.list())).toEqual([[MACHINE_NODE.name, true]]);
  });
});
