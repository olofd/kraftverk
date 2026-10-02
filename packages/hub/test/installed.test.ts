import { afterEach, expect, test } from 'bun:test';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { createSchema, fromSqliteWasm, plainSecrets, prepareDatabase, type SqliteWasmDatabase } from '@kraftverk/store';

import { createHub, installedFrom, type Hub } from '../src/index.ts';
import { busDefinition, FakeBus, lampProtocol, lampType } from '../src/testing.ts';

/*
  A home made the way the app makes its own: what is installed from lists
  (its generated registry), the database SQLite's WebAssembly build — a
  browser's, in memory here — and nothing else the place does not give.
*/

let hub: Hub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

test('a home from lists, on the WebAssembly build: a lamp added through setup, switched through the gateway', async () => {
  const sqlite3 = await sqlite3InitModule();
  const database = fromSqliteWasm(new sqlite3.oo1.DB(':memory:') as unknown as SqliteWasmDatabase);
  prepareDatabase(database);
  createSchema(database, 'test');

  const bus = new FakeBus();
  bus.lamps.set('lamp-1', { serial: 'LAMP-1', model: 'L1', on: false, answers: true });
  const installed = installedFrom(
    { types: [{ type: lampType }], protocols: [lampProtocol], transports: [{ definition: { ...busDefinition, platforms: ['web'], discovery: { web: 'list' } }, create: () => bus }] },
    { platform: 'web', context: { env: {}, log: () => {}, audit: () => {} } }
  );
  hub = createHub({
    database,
    secrets: plainSecrets,
    sealing: { seal: async () => '', open: async () => '' },
    installed,
    readOnly: () => false,
    http: () => Promise.reject(new Error('no network here')),
    gateway: { verifyTimeoutMs: 300 },
  });
  await hub.start();

  const home = hub.as({ kind: 'person', name: 'you' });
  expect((await home.deviceTypes()).types.map((type) => type.id)).toEqual(['test.lamp']);
  bus.announce();
  const draft = await home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
  await home.setup.choose(draft.id, { address: 'lamp-1' });
  expect((await home.setup.check(draft.id)).outcome).toBe('new');
  const lamp = await home.setup.save(draft.id, { name: 'Hall' });

  // The gateway switches nothing blind: it waits, as a person would, for the lamp to say how it is.
  for (let tries = 0; !(await home.devices.get(lamp.id)).readings.length && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await home.devices.command(lamp.id, 'main', 'switch', 'set', { args: { on: true } });
  expect(result).toMatchObject({ outcome: 'verified' });
  expect(bus.lamps.get('lamp-1')!.on).toBe(true);
  expect((await home.timeline({ limit: 5 })).map((entry) => entry.actor)).toContain('you');
});

test("a device picked in the platform's chooser: chosen, checked and saved — and a dismissed chooser chooses nothing", async () => {
  const database = (await import('./home.ts')).testDatabase();
  const bus = new FakeBus();
  bus.lamps.set('lamp-7', { serial: 'LAMP-7', model: 'L1', on: false, answers: true });
  let shown: unknown = null;
  let picks: string | null = 'lamp-7';
  // A browser's picker: it shows what it is asked to, and hands back the one a person picks.
  const chooser = Object.assign(bus, {
    choose: async (filter: unknown) => {
      shown = filter;
      return picks ? bus.sightings().find((sighting) => sighting.address === picks)! : null;
    },
  });
  const installed = installedFrom(
    { types: [{ type: lampType }], protocols: [lampProtocol], transports: [{ definition: { ...busDefinition, platforms: ['web'], discovery: { web: 'chooser' } }, create: () => chooser }] },
    { platform: 'web', context: { env: {}, log: () => {}, audit: () => {} } }
  );
  hub = createHub({ database, secrets: plainSecrets, sealing: { seal: async () => '', open: async () => '' }, installed, readOnly: () => false, http: () => Promise.reject(new Error('no network here')) });
  await hub.start();
  const home = hub.as({ kind: 'person', name: 'you' });

  const draft = await home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
  picks = null;
  expect((await home.setup.choose(draft.id, { chooser: {} })).address).toBeNull();
  picks = 'lamp-7';
  expect((await home.setup.choose(draft.id, { chooser: { showAll: true } })).address).toBe('lamp-7');
  expect(shown).toEqual({});
  expect((await home.setup.check(draft.id)).outcome).toBe('new');
  expect((await home.setup.save(draft.id, { name: 'Picked lamp' })).name).toBe('Picked lamp');
});

test('a package that breaks the rules is refused with why, and the rest installed', () => {
  const installed = installedFrom(
    { types: [{ type: lampType }, { type: { ...lampType, id: 'Not An Id' } }], protocols: [lampProtocol], transports: [{ definition: busDefinition, create: null }] },
    { platform: 'native', context: { env: {}, log: () => {}, audit: () => {} } }
  );
  expect(installed.types.all().map((type) => type.id)).toEqual(['test.lamp']);
  expect(installed.types.refused).toHaveLength(1);
  expect(installed.transports.available('bus')).toMatchObject({ ok: false });
});
