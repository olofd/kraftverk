import { afterEach, expect, test } from 'bun:test';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { nodeId, SIMULATED_METHOD_ID } from '@kraftverk/device-sdk';
import type { Hub } from '@kraftverk/hub';
import { fromSqliteWasm, sealedWithKey, type SqliteWasmDatabase } from '@kraftverk/store';

import { appHub, OWNER, readyDatabase } from './hub';

/*
  The app's own home as both places make it — every installed package from
  the generated registry, SQLite's WebAssembly build, the app's cipher —
  in memory here: a simulated plug added through setup, switched through
  the gateway, its automation made and run, and its timeline its owner's.
*/

let hub: Hub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

async function open() {
  const sqlite3 = await sqlite3InitModule();
  const database = readyDatabase(fromSqliteWasm(new sqlite3.oo1.DB(':memory:') as unknown as SqliteWasmDatabase), 'test');
  hub = appHub({ node: { id: nodeId('n-000000000000000000000000B2'), name: 'A test browser', alwaysOn: false, reachable: false, trusted: false }, database, secrets: sealedWithKey(crypto.getRandomValues(new Uint8Array(32))), platform: 'web', transport: () => null, readOnly: () => true });
  await hub.start();
  return hub.as(OWNER);
}

test('every installed type can be added, and a simulated plug is added, switched and automated — writes refused only to hardware', async () => {
  const home = await open();
  const listing = await home.deviceTypes();
  expect(listing.types.map((type) => type.id)).toContain('tuya.plug');

  const draft = await home.setup.start({ typeId: 'tuya.plug', methodId: SIMULATED_METHOD_ID });
  expect((await home.setup.check(draft.id)).outcome).toBe('new');
  const plug = await home.setup.save(draft.id, { name: 'Desk plug' });
  for (let tries = 0; !(await home.devices.get(plug.id)).readings.length && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 20));

  // A simulated device has no hardware: the app's read-only does not stand in its way, the gateway's rules do.
  const off = await home.devices.command(plug.id, 'main', 'switch', 'set', { args: { on: false } });
  expect(['refused', 'verified']).toContain(off.outcome);
  if (off.outcome === 'refused') expect(off.needsConfirmation).toBeTruthy();

  const automation = await home.automations.create({
    name: 'Desk plug on',
    rule: {
      roles: { plug: { label: 'Plug', description: 'The plug', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [],
      then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
    },
    roles: { plug: { device: plug.id, part: 'main' } },
    groups: {}, starts: {},
    timeZone: 'Europe/Stockholm',
  });
  await home.automations.start(automation.id);
  let runs = await home.automations.runs(automation.id);
  for (let tries = 0; !runs.some((run) => run.endedAt) && tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    runs = await home.automations.runs(automation.id);
  }
  expect(runs[0]).toMatchObject({ startedBy: { name: 'you' } });
  expect(runs[0]!.outcome).not.toBe('interrupted');
  expect((await home.timeline({ limit: 20 })).some((entry) => entry.actor.name === 'you')).toBe(true);
});
