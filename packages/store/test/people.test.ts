import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { nodeId } from '@kraftverk/device-sdk';
import { addKey, createPerson, keyId, newRecoveryWords, newSecret, recoveryKey, say, softwareKey, type Profile, type SigningKey } from '@kraftverk/identity';

import { FamilyStore, NodeStore, PeopleStore, PERSONAL_SCHEMA, PersonalStore, schemaFingerprint, SCHEMA, type SqlDatabase } from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

/*
  People in a family's database (docs/PLAN-WORLD-MODEL.md §8.2, §8.3), and
  the accounts a device keeps (§10.6) — on every driver a place opens
  SQLite with.
*/

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 8, 12) + n++ * 60_000).toISOString();
const personId = (letter: string) => `p-01JA8ZK3Q4R7T9V2W5X6Y8Z0${letter}${letter}`;
const profile = (name: string): Profile => ({ name, shortName: null, locale: null, pictureId: null });

async function someone(letter: string, name: string): Promise<{ key: SigningKey; chain: Awaited<ReturnType<typeof createPerson>> }> {
  const key = softwareKey(newSecret());
  let chain = await createPerson({ id: personId(letter), key, deviceName: `${name}’s phone`, profile: profile(name), at: at() });
  chain = await addKey(chain, { signer: key, key: recoveryKey(newRecoveryWords()), keyKind: 'recovery', deviceName: null, at: at() });
  return { key, chain };
}

for (const driver of DRIVERS) {
  describe(driver.name, () => {
    let database: SqlDatabase;
    let people: PeopleStore;

    beforeAll(async () => {
      database = await driver.open();
      new NodeStore(database).declareSelf({ id: nodeId('n-000000000000000000000000A1'), name: 'Test machine', platform: 'system', transports: [], alwaysOn: true, reachable: true, trusted: true });
      new FamilyStore(database).ensure({ name: 'The Examples', masterId: nodeId('n-000000000000000000000000A1') });
      people = new PeopleStore(database);
    });
    afterAll(() => database.close());

    test('a person as their chain says: kept, with their keys and what they linked; a newer copy taken, an older or forked one refused', async () => {
      const anna = await someone('A', 'Anna');
      const kept = people.present(anna.chain);
      expect(kept).toMatchObject({ id: personId('A'), name: 'Anna', shownAs: 'Anna', member: null, managedBy: null });
      expect(kept.keys.map((key) => key.kind)).toEqual(['device', 'recovery']);
      expect(people.keyHolder(keyId(anna.key.publicJwk))?.personId).toBe(personId('A'));

      const newer = await say(anna.chain, { signer: anna.key, at: at(), said: { kind: 'linked', linked: { provider: 'example-id', subject: 'sub-1', email: 'anna@example.com' } } });
      expect(people.present(newer).linked).toEqual(['example-id']);
      expect(people.byIdentity('example-id', 'sub-1')).toBe(personId('A'));
      expect(() => people.present(anna.chain)).toThrow('older copy');
      const fork = await say(anna.chain, { signer: anna.key, at: at(), said: { kind: 'profile', profile: profile('Anna B') } });
      expect(() => people.present(fork)).toThrow('does not go on from');
      expect(() => people.present([{ ...anna.chain[0]!, signature: anna.chain[1]!.signature }])).toThrow('That is not who they say');
    });

    test('members: each a colour of their own; at least one admin, always', async () => {
      const bo = await someone('B', 'Bo');
      people.present(bo.chain);
      const anna = people.addMember(personId('A'), { role: 'admin', invitedBy: null, at: at() });
      const member = people.addMember(personId('B'), { role: 'member', invitedBy: personId('A'), at: at() });
      expect(anna.member!.color).not.toBe(member.member!.color);
      expect(people.members().map((each) => each.name)).toEqual(['Anna', 'Bo']);
      expect(() => people.updateMember(personId('A'), { role: 'member' })).toThrow('at least one admin');
      expect(() => people.updateMember(personId('B'), { color: anna.member!.color })).toThrow('Another member has that colour');
      expect(people.updateMember(personId('B'), { nickname: 'Bobo' }).shownAs).toBe('Bobo');
      expect(() => people.leave(personId('A'), at())).toThrow('at least one admin');
      people.updateMember(personId('B'), { role: 'admin' });
      people.leave(personId('A'), at());
      expect(people.members().map((each) => each.id)).toEqual([personId('B')]);
      expect(people.get(personId('A'))?.member).toBeNull();
    });

    test('claimed: everything that named the keyless person names who they are now — what told them, where they are; and leaving ends where they are', async () => {
      const keyless = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0KK';
      people.ensureKeyless(keyless, 'Kim', at());
      people.addMember(keyless, { role: 'member', invitedBy: personId('A'), at: at() });
      const home = database.query<{ id: string }, []>("SELECT id FROM place WHERE kind = 'home' LIMIT 1").get()?.id ?? null;
      database.query("INSERT INTO notification (id, person_id, home_id, level, title, body, actor_kind, actor_id, actor_name, at) VALUES ('nt-1', ?, NULL, 'info', 'Hello', NULL, 'system', NULL, 'kraftverk', ?)").run(keyless, at());
      if (home) database.query("INSERT INTO presence_stay (id, person_id, place_id, place_kind, space_id, since, until, device_id) VALUES ('st-1', ?, ?, 'home', NULL, ?, NULL, NULL)").run(keyless, home, at());
      const kim = await someone('J', 'Kim');
      const claimed = people.claim(keyless, kim.chain);
      expect(claimed.id).toBe(personId('J'));
      expect(database.query<{ person_id: string }, []>("SELECT person_id FROM notification WHERE id = 'nt-1'").get()?.person_id).toBe(personId('J'));
      if (home) {
        expect(database.query<{ person_id: string }, []>("SELECT person_id FROM presence_stay WHERE id = 'st-1'").get()?.person_id).toBe(personId('J'));
        people.leave(personId('J'), at());
        expect(database.query<{ until: string | null }, []>("SELECT until FROM presence_stay WHERE id = 'st-1'").get()?.until).not.toBeNull();
      }
      expect(people.get(keyless)).toBeNull();
    });

    test('a key a family vouched for: the person signs in by it here', () => {
      const laptop = softwareKey(newSecret());
      people.vouch(personId('B'), laptop.publicJwk, 'Borrowed laptop', 'provider:example-id', at());
      expect(people.keyHolder(keyId(laptop.publicJwk))).toEqual({ personId: personId('B'), publicJwk: laptop.publicJwk });
      expect(people.get(personId('B'))!.keys.find((key) => key.id === keyId(laptop.publicJwk))?.vouched).toBe('provider:example-id');
    });
  });

  describe(`${driver.name}: the personal store`, () => {
    test('the accounts on a device: one opened as at a time, its families, forgotten with them', async () => {
      const database = await driver.open(PERSONAL_SCHEMA);
      expect(schemaFingerprint(PERSONAL_SCHEMA)).not.toBe(schemaFingerprint(SCHEMA));
      const store = new PersonalStore(database);
      const anna = await someone('A', 'Anna');
      const bo = await someone('B', 'Bo');
      store.add({ personId: personId('A'), chain: anna.chain, keyId: keyId(anna.key.publicJwk), deviceName: 'Tablet', addedAt: at() });
      store.add({ personId: personId('B'), chain: bo.chain, keyId: keyId(bo.key.publicJwk), deviceName: 'Tablet', addedAt: at() });
      expect(store.active()).toBeNull();
      store.activate(personId('A'));
      store.activate(personId('B'));
      expect(store.accounts().map((account) => [account.personId, account.active])).toEqual([
        [personId('A'), false],
        [personId('B'), true],
      ]);
      store.keepFamily(personId('B'), { familyId: 'f-01JA8ZK3Q4R7T9V2W5X6Y8Z0FF', name: 'The Examples', master: 'here', serverUrl: null, joinedAt: at() });
      expect(store.families(personId('B'))).toHaveLength(1);
      expect(() => store.keepFamily(personId('B'), { familyId: 'f-01JA8ZK3Q4R7T9V2W5X6Y8Z0GG', name: 'Elsewhere', master: 'server', serverUrl: null, joinedAt: at() })).toThrow();
      store.confirmRecovery(personId('B'), at());
      expect(store.account(personId('B'))?.recoveryConfirmedAt).not.toBeNull();
      store.remove(personId('B'));
      expect(store.active()).toBeNull();
      expect(store.accounts().map((account) => account.personId)).toEqual([personId('A')]);
      database.close();
    });
  });
}
