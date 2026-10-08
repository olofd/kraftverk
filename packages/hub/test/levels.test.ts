import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Caller, KraftverkApi, LiveUpdate, SharingLevel } from '@kraftverk/api-contract';
import { savedDeviceId, type SavedDeviceId } from '@kraftverk/device-sdk';

import { aHome, settle, type TestHome } from './a-home.ts';
import { phoneAt } from './kinds.ts';

/*
  What a person shares, enforced (docs/PLAN-WORLD-MODEL.md §11.2): every
  route that can show where someone is — a device's view, the list, its
  trail, the live stream, the assistant's world, presence — asked as each
  kind of reader, at each level. Anna carries a phone that is at Work; Bo is
  another member; an assistant, and a server's account no person is behind,
  read as the family does. Only at \`precise\` does anyone but Anna see where
  the phone is; never does anyone see coordinates in presence; below
  \`precise\` nothing of where it has been is kept. Made-up places near
  Greenwich.
*/

const ANNA = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AA';
const BO = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB';
const WORK = { latitude: 51.5123, longitude: 0.0123 };

let t: TestHome;
let phone: SavedDeviceId;

beforeEach(async () => {
  t = await aHome();
  const at = new Date().toISOString();
  for (const [id, name] of [[ANNA, 'Anna'], [BO, 'Bo']] as const) {
    t.hub.people.ensureKeyless(id, name, at);
    t.hub.people.addMember(id, { role: 'member', invitedBy: null, at });
  }
  await t.home.zones.add({ name: 'Work', location: { ...WORK, radius: 200 } });
  Object.assign(phoneAt, WORK);
  phone = savedDeviceId((await t.added('Anna’s phone', { typeId: 'test.phone' })).id);
  await t.home.devices.setTrack(phone, 30);
  await t.home.devices.setPeople(phone, { carries: ANNA });
});

afterEach(async () => {
  await t.stop();
});

const READERS: Record<string, Caller> = {
  anna: { kind: 'person', id: ANNA, name: 'Anna' },
  bo: { kind: 'person', id: BO, name: 'Bo' },
  assistant: { kind: 'agent', for: 'olof' },
  'a server account': { kind: 'person', name: 'olof', account: 'u-olof' },
};

/** The test phone's latitude, as text: whether it shows anywhere in an answer. */
const SEEN = '51.5123';

/** Every route that can show where the phone is, as one reader: what each said. */
async function asked(api: KraftverkApi) {
  const live: LiveUpdate[] = [];
  const stream = api.live((update) => live.push(update));
  t.hub.bus.publish({ kind: 'readings', deviceId: phone, readings: [{ key: 'position', value: { ...WORK, accuracy: 10 }, at: new Date().toISOString() }] });
  await settle(300);
  stream.close();
  const presence = (await api.presence.list()).find((each) => each.personId === ANNA)!;
  return {
    list: JSON.stringify((await api.devices.list()).find((device) => device.id === phone)!.readings).includes(SEEN),
    get: JSON.stringify((await api.devices.get(phone)).readings).includes(SEEN),
    trail: (await api.devices.track(phone, new Date(0).toISOString())).length > 0,
    live: JSON.stringify(live).includes(SEEN),
    world: JSON.stringify(await api.world()).includes(SEEN),
    presence,
  };
}

describe('what a person shares, enforced', () => {
  for (const level of ['precise', 'places', 'home-away', 'off'] as const satisfies readonly SharingLevel[]) {
    test(`at ${level}: where Anna's phone is, to each reader — and presence never with coordinates`, async () => {
      await t.as(READERS.anna!).people.setSharing(ANNA, { level });
      t.hub.presence.lookAt(ANNA);
      t.hub.sampler.sample();

      for (const [who, caller] of Object.entries(READERS)) {
        const answers = await asked(t.as(caller));
        // Anna sees her own phone; others only at precise.
        const sees = level === 'precise' || who === 'anna';
        expect({ who, list: answers.list, get: answers.get, live: answers.live, world: answers.world }).toEqual({ who, list: sees, get: sees, live: sees, world: sees });
        // Where it has been is kept only at precise: below, there is none to see — not even for Anna.
        expect({ who, trail: answers.trail }).toEqual({ who, trail: level === 'precise' });
        // Presence: "at Work" at places and above; only home or away below; nothing at off — never coordinates.
        expect(JSON.stringify(answers.presence)).not.toContain(SEEN);
        if (level === 'off') expect(answers.presence).toMatchObject({ sharing: 'off', home: null, places: [] });
        else if (level === 'home-away') expect(answers.presence).toMatchObject({ sharing: 'home-away', home: false, places: [] });
        else expect(answers.presence).toMatchObject({ sharing: level, home: false, places: [{ kind: 'zone', name: 'Work' }] });
      }

      // Below precise, nothing of where it has been is kept.
      expect(t.hub.tracks.points(phone, new Date(0).toISOString()).length > 0).toBe(level === 'precise');
    });
  }

  test('a trail kept at precise is let go when Anna shares less', async () => {
    await t.as(READERS.anna!).people.setSharing(ANNA, { level: 'precise' });
    t.hub.sampler.sample();
    expect(t.hub.tracks.points(phone, new Date(0).toISOString()).length).toBeGreaterThan(0);
    await t.as(READERS.anna!).people.setSharing(ANNA, { level: 'places' });
    expect(t.hub.tracks.points(phone, new Date(0).toISOString())).toEqual([]);
  });
});
