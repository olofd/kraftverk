import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import type { Caller } from '@kraftverk/api-contract';
import { base64url, checkChain, fromBase64url, keyId, newSecret, recoveryKey, softwareKey, type SigningKey } from '@kraftverk/identity';
import { createSchema, PERSONAL_SCHEMA, PersonalStore, prepareDatabase, type SqlDatabase } from '@kraftverk/store';

import { changesConfiguration } from '../src/configuration/configuration.ts';
import { acceptInvitation } from '../src/people/join.ts';
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
    make: async () => {
      const key = softwareKey(newSecret());
      held.set(keyId(key.publicJwk), key);
      return { id: keyId(key.publicJwk), key };
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
    expect(checked.person.keys.map((key): string => key.id)).toEqual([[...keys.held.keys()][0]!, keyId(recoveryKey(recoveryWords).publicJwk)]);
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
    expect(keys.held.size).toBe(1);
    expect((await personal.accounts()).map((each) => each.name)).toEqual(['Anna']);
    // What they say is signed by this device's key; a device that lost the key says so.
    expect((await personal.say(anna.personId, { kind: 'profile', profile: { name: 'Anna', shortName: 'Mum', locale: null, pictureId: null } })).shortName).toBe('Mum');
    keys.held.clear();
    expect((await refusal(personal.say(anna.personId, { kind: 'profile', profile: { name: 'Anna', shortName: null, locale: null, pictureId: null } }))).message).toContain('recovery words');
    expect((await refusal(personal.create({ name: '  ', deviceName: 'Tablet' }))).kind).toBe('invalid');
  });
});

describe('another device of one’s own, and coming back', () => {
  test('a second device makes its key and shows a code; the first signs it in and answers with one; the second is the account too', async () => {
    const phone = aDevice();
    const { account } = await phone.personal.create({ name: 'Anna', deviceName: 'Phone' });
    await phone.personal.keepFamily(account.personId, { familyId: 'f-01JA8ZK3Q4R7T9V2W5X6Y8Z0FF', name: 'The Examples', master: 'server', serverUrl: 'https://home.example.net/api', joinedAt: '2026-10-08T12:00:00.000Z' });
    const laptop = aDevice();
    const { keyId: laptopKey, code } = await laptop.personal.linkCode('Laptop');
    expect((await refusal(phone.personal.addDevice(account.personId, 'not a code'))).kind).toBe('invalid');
    const { welcome, chain } = await phone.personal.addDevice(account.personId, code);
    expect(checkChain(chain).ok).toBe(true);
    const adopted = await laptop.personal.adopt(laptopKey, welcome);
    expect(adopted).toMatchObject({ personId: account.personId, name: 'Anna', deviceName: 'Laptop', recoveryConfirmed: true, families: [{ name: 'The Examples', master: 'server' }] });
    // The laptop signs as Anna with its own key: what it says is hers.
    expect((await laptop.personal.say(account.personId, { kind: 'profile', profile: { name: 'Anna', shortName: 'Mum', locale: null, pictureId: null } })).shortName).toBe('Mum');
    // A code made with a key it does not hold is refused.
    const stranger = aDevice();
    const { code: theirs } = await stranger.personal.linkCode('Stranger');
    const forged = JSON.parse(new TextDecoder().decode(fromBase64url(theirs)!)) as { p: string };
    const { code: mine } = await laptop.personal.linkCode('Tablet');
    const swapped = base64url(new TextEncoder().encode(JSON.stringify({ ...(JSON.parse(new TextDecoder().decode(fromBase64url(mine)!)) as object), p: forged.p })));
    expect((await refusal(phone.personal.addDevice(account.personId, swapped))).message).toContain('does not prove');
  });

  test('every device lost: the twelve words sign a new one in, as the same person', async () => {
    const phone = aDevice();
    const { account, recoveryWords } = await phone.personal.create({ name: 'Anna', deviceName: 'Phone' });
    const chain = await phone.personal.chain(account.personId);
    const fresh = aDevice();
    const back = await fresh.personal.recover({ words: recoveryWords, chain, deviceName: 'New phone', families: [] });
    expect(back.account).toMatchObject({ personId: account.personId, deviceName: 'New phone' });
    expect(checkChain(back.chain).ok).toBe(true);
    // Its answer to a node's challenge, by the words, names the same person.
    const challenge = { node: 'n-01JA8ZK3Q4R7T9V2W5X6Y8Z0NN', nonce: 'nonce-of-a-test', issuedAt: '2026-10-08T12:00:00.000Z' };
    expect((await fresh.personal.recoveryAnswer(recoveryWords, challenge, account.personId)).keyId).toBe(keyId(recoveryKey(recoveryWords).publicJwk));
    // Other words make another key, which this person never held.
    const other = aDevice();
    const { recoveryWords: wrong } = await other.personal.create({ name: 'Bo', deviceName: 'Phone' });
    expect((await refusal(aDevice().personal.recover({ words: wrong, chain, deviceName: 'X', families: [] }))).kind).toBe('invalid');
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

  test('invited: a secret answered once; taken by someone showing who they are — in, or waiting for an admin; never twice, never a wrong one', async () => {
    const { personal } = aDevice();
    const anna = (await personal.create({ name: 'Anna', deviceName: 'Phone' })).account;
    const asAnna: Caller = { kind: 'person', id: anna.personId, name: 'Anna' };
    await t.as(asAnna).people.found({ chain: await personal.chain(anna.personId), name: 'The Examples', kind: 'family', home: { name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' } });

    const { invitation, secret } = await t.as(asAnna).people.invite({ role: 'member', forName: 'Bo', needsApproval: false });
    expect(invitation).toMatchObject({ role: 'member', forName: 'Bo', status: 'open', madeBy: anna.personId });
    const bo = (await personal.create({ name: 'Bo', deviceName: 'Phone' })).account;
    const boChain = await personal.chain(bo.personId);
    expect(() => acceptInvitation(t.hub, { invitation: invitation.id, secret: `${secret}x`, chain: boChain })).toThrow('not open');
    expect(acceptInvitation(t.hub, { invitation: invitation.id, secret, chain: boChain })).toMatchObject({ status: 'joined', family: { name: 'The Examples' } });
    expect((await t.as(asAnna).people.list()).map((each) => [each.name, each.member?.role])).toEqual([
      ['Anna', 'admin'],
      ['Bo', 'member'],
    ]);
    expect(() => acceptInvitation(t.hub, { invitation: invitation.id, secret, chain: boChain })).toThrow('not open');

    // One that needs a yes: taken, then waiting, until an admin lets them in. Only an admin invites.
    const asBo: Caller = { kind: 'person', id: bo.personId, name: 'Bo' };
    expect((await refusal(t.as(asBo).people.invite({ role: 'member', needsApproval: false }))).kind).toBe('forbidden');
    const second = await t.as(asAnna).people.invite({ role: 'child', needsApproval: true, days: 1 });
    const sam = (await personal.create({ name: 'Sam', deviceName: 'Tablet' })).account;
    expect(acceptInvitation(t.hub, { invitation: second.invitation.id, secret: second.secret, chain: await personal.chain(sam.personId) }).status).toBe('waiting');
    expect((await t.as(asAnna).people.list()).map((each) => each.name)).toEqual(['Anna', 'Bo']);
    expect((await t.as(asAnna).people.invitations()).find((each) => each.id === second.invitation.id)?.status).toBe('waiting');
    expect((await t.as(asAnna).people.approve(second.invitation.id)).member?.role).toBe('child');
    expect((await t.as(asAnna).people.list()).map((each) => each.name)).toEqual(['Anna', 'Bo', 'Sam']);

    // Taken back: no one takes it.
    const third = await t.as(asAnna).people.invite({ role: 'member', needsApproval: false });
    expect((await t.as(asAnna).people.revokeInvitation(third.invitation.id)).status).toBe('revoked');
    const cleo = (await personal.create({ name: 'Cleo', deviceName: 'Phone' })).account;
    expect(() => acceptInvitation(t.hub, { invitation: third.invitation.id, secret: third.secret, chain: [] })).toThrow();
    const cleoChain = await personal.chain(cleo.personId);
    expect(() => acceptInvitation(t.hub, { invitation: third.invitation.id, secret: third.secret, chain: cleoChain })).toThrow('not open');
  });

  test('every change to what the file carries — rooms, places, labels, people — writes the kept file again', async () => {
    const { personal } = aDevice();
    const anna = (await personal.create({ name: 'Anna', deviceName: 'Phone' })).account;
    const asAnna = t.as({ kind: 'person', id: anna.personId, name: 'Anna' });
    const before = (await t.home.timeline({ limit: 1000 })).length;
    await asAnna.people.found({ chain: await personal.chain(anna.personId), name: 'The Examples', kind: 'family', home: { name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' } });
    await asAnna.people.update(anna.personId, { nickname: 'Mum' });
    const [home] = await asAnna.homes.list();
    const [site] = await asAnna.spaces.list(home!.id);
    const kitchen = await asAnna.spaces.add({ parentId: site!.id, kind: 'room', name: 'Kitchen' });
    await asAnna.spaces.update(kitchen.id, { name: 'The kitchen' });
    const door = await asAnna.openings.add({ fromId: kitchen.id, toId: null, kind: 'door' });
    await asAnna.openings.remove(door.id);
    const label = await asAnna.labels.add({ name: 'Heating' });
    await asAnna.labels.set({ space: kitchen.id }, [label.id]);
    await asAnna.labels.update(label.id, { name: 'Warmth' });
    const kinds = (await t.home.timeline({ limit: 1000 })).slice(0, -before || undefined).map((entry) => entry.kind);
    expect(kinds.length).toBeGreaterThan(8);
    expect(kinds.filter((kind) => !changesConfiguration(kind))).toEqual([]);
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

  test('what each shares of where they are: chosen founding and joining, their own to change — an admin’s for a child — paused, kept in the file', async () => {
    const { personal } = aDevice();
    const anna = (await personal.create({ name: 'Anna', deviceName: 'Phone' })).account;
    const bo = (await personal.create({ name: 'Bo', deviceName: 'Phone' })).account;
    const sam = (await personal.create({ name: 'Sam', deviceName: 'Tablet' })).account;
    const asAnna = t.as({ kind: 'person', id: anna.personId, name: 'Anna' });
    const asBo = t.as({ kind: 'person', id: bo.personId, name: 'Bo' });
    const asSam = t.as({ kind: 'person', id: sam.personId, name: 'Sam' });
    await asAnna.people.found({ chain: await personal.chain(anna.personId), name: 'The Examples', kind: 'family', home: { name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' }, sharing: 'precise' });
    const member = await asAnna.people.invite({ role: 'member', needsApproval: false });
    acceptInvitation(t.hub, { invitation: member.invitation.id, secret: member.secret, chain: await personal.chain(bo.personId), sharing: 'home-away' });
    const child = await asAnna.people.invite({ role: 'child', needsApproval: false });
    acceptInvitation(t.hub, { invitation: child.invitation.id, secret: child.secret, chain: await personal.chain(sam.personId) });

    const sharingOf = async (id: string) => (await asAnna.people.list()).find((each) => each.id === id)!.member!.sharing;
    expect(await sharingOf(anna.personId)).toMatchObject({ level: 'precise', now: 'precise', keepDays: 90, setBy: anna.personId });
    expect(await sharingOf(bo.personId)).toMatchObject({ level: 'home-away', setBy: bo.personId });
    // Never said: the family's default, places — and no one set it.
    expect(await sharingOf(sam.personId)).toMatchObject({ level: 'places', setBy: null });

    // Bo his own; Anna not his; Anna Sam's; Sam never his own.
    expect((await asBo.people.setSharing(bo.personId, { level: 'places', keepDays: 30 })).member!.sharing).toMatchObject({ level: 'places', keepDays: 30 });
    expect((await refusal(asAnna.people.setSharing(bo.personId, { level: 'precise' }))).kind).toBe('forbidden');
    expect((await asAnna.people.setSharing(sam.personId, { level: 'home-away' })).member!.sharing).toMatchObject({ level: 'home-away', setBy: anna.personId });
    expect((await refusal(asSam.people.setSharing(sam.personId, { level: 'off' }))).message).toBe('An admin sets what a child shares');
    expect((await refusal(asBo.people.setSharing(bo.personId, { keepDays: 400 }))).kind).toBe('invalid');
    // On the timeline in words, never a place; a change the kept file carries.
    expect((await t.home.timeline()).find((entry) => entry.kind === 'person.sharing')?.summary).toBe('Sam shares only whether they are home');
    expect(changesConfiguration('person.sharing')).toBe(true);

    // Paused for an hour: off until then, and places after.
    const paused = (await asBo.people.setSharing(bo.personId, { pausedUntil: new Date(Date.now() + 3_600_000).toISOString() })).member!.sharing;
    expect([paused.level, paused.now]).toEqual(['places', 'off']);

    // In the file once chosen, and back from it.
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    expect(text).toContain('    sharing:\n      level: precise\n      keep: 90 days\n');
    await asAnna.people.setSharing(anna.personId, { level: 'off' });
    const plan = await t.home.configuration.plan({ text });
    expect(plan.people.find((each) => each.name === 'Anna')?.changes).toContain('what they share');
    await t.home.configuration.apply({ plan: plan.id! });
    expect(await sharingOf(anna.personId)).toMatchObject({ level: 'precise' });
  });

  test('their own name and picture, said by them; and forgotten — by themselves or an admin — their id alone stays', async () => {
    const { personal } = aDevice();
    const anna = (await personal.create({ name: 'Anna', deviceName: 'Phone' })).account;
    const bo = (await personal.create({ name: 'Bo Example', deviceName: 'Phone' })).account;
    const asAnna: Caller = { kind: 'person', id: anna.personId, name: 'Anna' };
    const asBo: Caller = { kind: 'person', id: bo.personId, name: 'Bo Example' };
    await t.as(asAnna).people.found({ chain: await personal.chain(anna.personId), name: 'The Examples', kind: 'family', home: { name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' } });
    const { invitation, secret } = await t.as(asAnna).people.invite({ role: 'member', needsApproval: false });
    acceptInvitation(t.hub, { invitation: invitation.id, secret, chain: await personal.chain(bo.personId) });

    // Bo says what he goes by: the family hears it from him, and says so.
    await personal.say(bo.personId, { kind: 'profile', profile: { name: 'Bo Example', shortName: 'Bo', locale: null, pictureId: null } });
    expect((await t.as(asBo).people.present(await personal.chain(bo.personId))).shownAs).toBe('Bo');
    expect((await t.home.timeline()).find((entry) => entry.kind === 'person.changed')?.summary).toBe('Bo Example changed their profile');
    await t.as(asBo).labels.add({ name: 'Garden' });

    // Only an admin forgets someone else; Bo may forget himself.
    expect((await refusal(t.as(asBo).people.erase(anna.personId))).kind).toBe('forbidden');
    t.hub.shortcuts.set(bo.personId, []);
    await t.as(asBo).people.erase(bo.personId);
    expect((await t.as(asAnna).people.list()).map((each) => each.name)).toEqual(['Anna']);
    expect(t.hub.people.get(bo.personId)).toMatchObject({ name: 'Someone who left', shortName: null, keys: [], linked: [], member: null });
    expect(t.hub.people.chainOf(bo.personId)).toEqual([]);
    // The timeline names no one: what he did, and what was said of him.
    const lines = await t.home.timeline({ limit: 1000 });
    expect(lines.find((entry) => entry.kind === 'label.added')?.actor).toEqual({ kind: 'person', id: bo.personId, name: 'Someone who left' });
    expect(lines.filter((entry) => /\bBo\b/.test(entry.summary) || entry.actor.name.includes('Bo'))).toEqual([]);
    expect(lines[0]).toMatchObject({ kind: 'person.erased', summary: 'Someone who left the family, and asked to be forgotten' });
    expect(changesConfiguration('person.erased')).toBe(true);
    // The last admin is not forgotten: the family keeps one.
    expect((await refusal(t.as(asAnna).people.erase(anna.personId))).message).toContain('at least one admin');
  });
});
