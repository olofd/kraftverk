import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SYSTEM } from '@kraftverk/device-sdk';
import { NotificationStore, PeopleStore } from '@kraftverk/store';

import { notify, type PushSender } from '../src/notifications/notify.ts';
import { aHome, refusal, type TestHome } from './a-home.ts';
import { testDatabase } from './home.ts';

/*
  Telling a person something: in their inbox, and pushed to each app of
  theirs — an app whose push service says it is gone, forgotten. Their inbox
  is their own: read, one or all, and never another's.
*/

const ANNA = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AA';
const BO = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB';

describe('telling a person', () => {
  test('in their inbox, pushed to each app; one gone is forgotten, and it is delivered once one got it', async () => {
    const db = testDatabase();
    const at = new Date().toISOString();
    new PeopleStore(db).ensureKeyless(ANNA, 'Anna', at);
    const store = new NotificationStore(db);
    store.keepEndpoint({ nodeId: 'n-laptop', personId: ANNA, provider: 'webpush', token: '{}' }, at);
    store.keepEndpoint({ nodeId: 'n-old-phone', personId: ANNA, provider: 'webpush', token: '{}' }, at);
    const pushed: string[] = [];
    const push: PushSender = { publicKey: () => 'key', send: async (endpoint) => (pushed.push(endpoint.nodeId), endpoint.nodeId === 'n-old-phone' ? 'gone' : 'sent') };

    const said = await notify(store, push, ANNA, { title: 'The garage door is open', level: 'warning', from: SYSTEM });
    expect(pushed.sort()).toEqual(['n-laptop', 'n-old-phone']);
    expect(said).toMatchObject({ title: 'The garage door is open', level: 'warning', from: { kind: 'system', name: 'kraftverk' } });
    expect(said.deliveredAt).not.toBeNull();
    expect(store.endpointsOf(ANNA).map((endpoint) => endpoint.nodeId)).toEqual(['n-laptop']);

    // With no push at all — a family kept on a phone — the inbox is all there is.
    expect((await notify(store, null, ANNA, { title: 'Hello', from: SYSTEM })).deliveredAt).toBeNull();
    expect(store.inbox(ANNA).map((each) => each.title)).toEqual(['Hello', 'The garage door is open']);
  });
});

describe('a person’s own notifications', () => {
  let t: TestHome;
  beforeEach(async () => {
    t = await aHome();
    const at = new Date().toISOString();
    for (const [id, name] of [[ANNA, 'Anna'], [BO, 'Bo']] as const) {
      t.hub.people.ensureKeyless(id, name, at);
      t.hub.people.addMember(id, { role: 'member', invitedBy: null, at });
    }
  });
  afterEach(async () => {
    await t.stop();
  });

  test('a test in their own inbox; read one or all, never another’s; no push here, and none for an assistant', async () => {
    const anna = t.as({ kind: 'person', id: ANNA, name: 'Anna' });
    const bo = t.as({ kind: 'person', id: BO, name: 'Bo' });
    const sent = await anna.notifications.test();
    expect(sent).toMatchObject({ title: 'A test from kraftverk', readAt: null });
    expect((await anna.notifications.list()).map((each) => each.id)).toEqual([sent.id]);
    expect(await bo.notifications.list()).toEqual([]);
    expect((await refusal(bo.notifications.read(sent.id))).kind).toBe('not-found');
    await anna.notifications.read(sent.id);
    expect((await anna.notifications.list())[0]!.readAt).not.toBeNull();

    // This test home sends no push: no key, and no app to wake.
    expect(await anna.notifications.pushKey()).toBeNull();
    expect((await refusal(anna.notifications.keepPushEndpoint('n-1', { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }))).kind).toBe('unavailable');
    expect((await refusal(t.as({ kind: 'agent', for: 'olof' }).notifications.list())).kind).toBe('forbidden');
  });
});
