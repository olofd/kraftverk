import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import type { Caller } from '@kraftverk/api-contract';
import { checkChain, keyId, newSecret, recoveryKey, softwareKey, type SigningKey } from '@kraftverk/identity';
import { createSchema, PERSONAL_SCHEMA, PersonalStore, prepareDatabase, type SqlDatabase } from '@kraftverk/store';

import { personalApi, type DeviceKeys } from '../src/personal/personal.ts';
import { aHome, refusal, type TestHome } from './a-home.ts';

/*
  Accounts on a device, and people in a family (docs/PLAN-WORLD-MODEL.md
  §10.6, §8.2, §8.3): an account made with no server — its key, its
  recovery words, its chain — and the family it founds, as its admin.
*/

/** A device's keys, in memory: what a phone's secure store and a browser's IndexedDB keep. */
function memoryKeys(): DeviceKeys & { held: Map<string, SigningKey> } {
  const held = new Map<string, SigningKey>();
  return {
    held,
    make: async (id) => {
      const key = softwareKey(newSecret());
      held.set(id, key);
      return key;
    },
    get: async (id) => held.get(id) ?? null,
    forget: async (id) => void held.delete(id),
  };
}

function aDevice() {
  const db = new Database(':memory:') as unknown as SqlDatabase;
  prepareDatabase(db);
  createSchema(db, 'test', PERSONAL_SCHEMA);
  const keys = memoryKeys();
  return { keys, personal: personalApi({ store: new PersonalStore(db), keys }) };
}

describe('an account on a device, with no server', () => {
  test('made as a local account: a person, this device’s key, twelve recovery words that are their recovery key — opened as', async () => {
    const { keys, personal } = aDevice();
    const { account, recoveryWords } = await personal.create({ name: ' Anna Example ', deviceName: 'Anna’s iPhone' });
    expect(account).toMatchObject({ name: 'Anna Example', deviceName: 'Anna’s iPhone', active: false, recoveryConfirmed: false, linked: [], families: [] });
    expect(recoveryWords).toHaveLength(12);
    const checked = checkChain(await personal.chain(account.personId));
    if (!checked.ok) throw new Error(checked.problem);
    expect(checked.person.keys.map((key) => key.id)).toEqual([keyId(keys.held.get(account.personId)!.publicJwk), keyId(recoveryKey(recoveryWords).publicJwk)]);
    expect((await personal.confirmRecovery(account.personId)).recoveryConfirmed).toBe(true);
  });

  test('made with a sign-in provider: the identity there linked in their chain', async () => {
    const { personal } = aDevice();
    const { account } = await personal.create({ name: 'Anna', deviceName: 'Phone', linked: { provider: 'example-id', subject: '001234.abc', email: 'anna@example.com' } });
    expect(account.linked).toEqual([{ provider: 'example-id', subject: '001234.abc', email: 'anna@example.com' }]);
  });

  test('two on one device: one opened as at a time; signed out, the key kept; removed, it is gone', async () => {
    const { keys, personal } = aDevice();
    const anna = (await personal.create({ name: 'Anna', deviceName: 'Tablet' })).account;
    const bo = (await personal.create({ name: 'Bo', deviceName: 'Tablet' })).account;
    await personal.activate(anna.personId);
    await personal.activate(bo.personId);
    expect((await personal.accounts()).map((each) => [each.name, each.active])).toEqual([
      ['Anna', false],
      ['Bo', true],
    ]);
    await personal.activate(null);
    expect((await personal.accounts()).some((each) => each.active)).toBe(false);
    expect(keys.held.size).toBe(2);
    await personal.activate(anna.personId);
    await personal.remove(bo.personId);
    expect(keys.held.has(bo.personId)).toBe(false);
    expect((await personal.accounts()).map((each) => each.name)).toEqual(['Anna']);
    // What they say is signed by this device's key; a device that lost the key says so.
    expect((await personal.say(anna.personId, { kind: 'profile', profile: { name: 'Anna', shortName: 'Mum', locale: null, pictureId: null } })).shortName).toBe('Mum');
    keys.held.delete(anna.personId);
    expect((await refusal(personal.say(anna.personId, { kind: 'profile', profile: { name: 'Anna', shortName: null, locale: null, pictureId: null } }))).message).toContain('recovery words');
    expect((await refusal(personal.create({ name: '  ', deviceName: 'Tablet' }))).kind).toBe('invalid');
  });
});

describe('a family founded by its first person', () => {
  let t: TestHome;
  beforeEach(async () => {
    t = await aHome();
  });
  afterEach(async () => {
    await t.stop();
  });

  test('its admin, its name and kind, its first home — and once only', async () => {
    const { personal } = aDevice();
    const { account } = await personal.create({ name: 'Anna Example', deviceName: 'Anna’s iPhone' });
    const chain = await personal.chain(account.personId);
    const anna: Caller = { kind: 'person', id: account.personId, name: 'Anna Example' };
    const founder = await t.as(anna).people.found({ chain, name: 'The Examples', kind: 'household', home: { name: 'Lake house', type: 'cabin', timeZone: 'Europe/Stockholm' } });
    expect(founder).toMatchObject({ id: account.personId, name: 'Anna Example', member: { role: 'admin' } });
    expect(await t.as(anna).family()).toMatchObject({ name: 'The Examples', kind: 'household' });
    expect((await t.home.homes.list())[0]).toMatchObject({ name: 'Lake house', type: 'cabin' });
    expect((await t.as(anna).people.me())?.id).toBe(account.personId);
    // On the timeline as the person, by their id.
    const founded = (await t.home.timeline()).find((entry) => entry.kind === 'family.founded')!;
    expect(founded.actor).toEqual({ kind: 'person', id: account.personId, name: 'Anna Example' });
    expect((await refusal(t.as(anna).people.found({ chain, name: 'Again', kind: 'family', home: { name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' } }))).kind).toBe('conflict');
  });

  test('refused: someone else’s chain, a chain that does not check; and only an admin changes a member', async () => {
    const { personal } = aDevice();
    const anna = (await personal.create({ name: 'Anna', deviceName: 'Phone' })).account;
    const bo = (await personal.create({ name: 'Bo', deviceName: 'Phone' })).account;
    const asBo: Caller = { kind: 'person', id: bo.personId, name: 'Bo' };
    const home = { name: 'Home', type: 'house' as const, timeZone: 'Europe/Stockholm' };
    expect((await refusal(t.as(asBo).people.found({ chain: await personal.chain(anna.personId), name: 'X', kind: 'family', home }))).kind).toBe('forbidden');
    const forged = (await personal.chain(anna.personId)).map((each, index) => (index === 0 ? { ...each, at: '2020-01-01T00:00:00.000Z' } : each));
    expect((await refusal(t.as(asBo).people.found({ chain: forged, name: 'X', kind: 'family', home }))).kind).toBe('invalid');

    const asAnna: Caller = { kind: 'person', id: anna.personId, name: 'Anna' };
    await t.as(asAnna).people.found({ chain: await personal.chain(anna.personId), name: 'The Examples', kind: 'family', home });
    expect((await refusal(t.as(asBo).people.update(anna.personId, { nickname: 'Boss' }))).kind).toBe('forbidden');
    expect((await t.as(asAnna).people.update(anna.personId, { nickname: 'Mum' })).shownAs).toBe('Mum');
    expect((await refusal(t.as(asAnna).people.update(anna.personId, { role: 'member' }))).message).toContain('at least one admin');
    // Named on the timeline as the family calls her now.
    await t.as(asAnna).labels.add({ name: 'Heating' });
    expect((await t.home.timeline()).find((entry) => entry.kind === 'label.added')?.actor.name).toBe('Mum');
  });
});
