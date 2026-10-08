import { beforeEach, describe, expect, test } from 'bun:test';

import type { DeviceView } from '@kraftverk/api-contract';
import { savedDeviceId } from '@kraftverk/device-sdk';
import type { LiveListener } from '@kraftverk/holder';
import { DevicePeopleStore, PeopleStore, PlaceStore, PresenceStore, type SqlDatabase } from '@kraftverk/store';

import { presenceApi } from '../src/api/presence.ts';
import type { Hub } from '../src/node/hub.ts';
import { Presence } from '../src/presence/presence.ts';
import { LEAVE_AFTER_MS } from '../src/presence/rules.ts';
import { testDatabase } from './home.ts';

/*
  Presence kept: a member carrying a phone, its positions heard as a
  device's readings, on a clock the test moves — stays opened and closed,
  answered as far as the person shares, and let go after their days.
  Made-up places near Greenwich.
*/

const ANNA = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AA';
const PHONE = savedDeviceId('d-phone');
const T = Date.parse('2026-10-08T12:00:00Z');

let db: SqlDatabase;
let people: PeopleStore;
let places: PlaceStore;
let devicePeople: DevicePeopleStore;
let stays: PresenceStore;
let presence: Presence;
let heard: LiveListener | null;
/** Where the phone says it is, and when. */
let position: { latitude: number; at: number } | null;
let now = T;

beforeEach(() => {
  db = testDatabase();
  db.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES ('d-phone', 'phone', 'test.phone', 'Anna’s phone', '{\"parts\":[],\"attributes\":[]}', '2026-06-01T00:00:00Z')").run();
  people = new PeopleStore(db);
  places = new PlaceStore(db);
  devicePeople = new DevicePeopleStore(db);
  stays = new PresenceStore(db);
  people.ensureKeyless(ANNA, 'Anna', new Date(T).toISOString());
  people.addMember(ANNA, { role: 'member', invitedBy: null, at: new Date(T).toISOString() });
  places.addHome({ key: 'home', name: 'Home', type: 'house', timeZone: 'Europe/London', location: { latitude: 51.48, longitude: 0, radius: 150 } });
  places.addZone({ key: 'work', name: 'Work', location: { latitude: 51.5, longitude: 0, radius: 200 } });
  devicePeople.set(PHONE, 'carries', [ANNA], new Date(T).toISOString());
  position = null;
  heard = null;
  now = T;
  const phone = () => ({ readings: position ? [{ key: 'position', value: { latitude: position.latitude, longitude: 0, accuracy: 10 }, at: new Date(position.at).toISOString() }] : [] }) as unknown as DeviceView;
  presence = new Presence({
    people,
    devicePeople,
    places,
    stays,
    views: { find: (id) => (id === PHONE ? phone() : null) },
    bus: { subscribe: (listener) => ((heard = listener), () => (heard = null)) },
    clock: { now: () => now, setTimeout: () => ({ clock: 'timer' }), setInterval: () => ({ clock: 'timer' }), clear: () => {}, rate: 1 },
  });
});

/** The phone says it is somewhere: heard as its readings, as the bus carries them. */
const at = (latitude: number, when: number) => {
  position = { latitude, at: when };
  now = when;
  heard?.({ kind: 'readings', deviceId: PHONE, readings: [{ key: 'position', value: { latitude, longitude: 0, accuracy: 10 }, at: new Date(when).toISOString() }] });
};
const answered = () => presenceApi({ people, places, stays } as unknown as Hub, { kind: 'person', id: ANNA, name: 'Anna' }).presence.list();

describe('presence kept', () => {
  test('home, then work: each stay opened as the phone says, the home left only after its minutes, and answered as far as Anna shares', async () => {
    presence.start();
    at(51.48, T);
    expect((await answered())[0]).toMatchObject({ sharing: 'places', home: true, places: [{ kind: 'home', name: 'Home' }] });

    // Out of the door: still home until the minutes are out.
    at(51.49, T + 60_000);
    expect((await answered())[0]!.home).toBe(true);
    at(51.49, T + 60_000 + LEAVE_AFTER_MS);
    expect((await answered())[0]).toMatchObject({ home: false, places: [] });
    expect(stays.since(ANNA, new Date(0).toISOString())[0]).toMatchObject({ kind: 'home', until: new Date(T + 60_000).toISOString(), deviceId: PHONE });

    // At work: "at work", never coordinates.
    at(51.5, T + 3_600_000);
    const atWork = (await answered())[0]!;
    expect(atWork).toEqual({ personId: ANNA, sharing: 'places', home: false, places: [{ id: places.zoneByKey('work')!.id, kind: 'zone', name: 'Work', since: new Date(T + 3_600_000).toISOString() }] });
    expect(JSON.stringify(atWork)).not.toContain('51.5');

    // Home or away only: the zone ends, and the answer says only that.
    people.setSharing(ANNA, { level: 'home-away' }, ANNA, new Date(now).toISOString());
    presence.lookAt(ANNA);
    expect((await answered())[0]).toEqual({ personId: ANNA, sharing: 'home-away', home: false, places: [] });
    expect(stays.open(ANNA)).toEqual([]);

    // Nothing: nothing to say, and nothing kept from then.
    people.setSharing(ANNA, { level: 'off' }, ANNA, new Date(now).toISOString());
    at(51.48, T + 7_200_000);
    expect((await answered())[0]).toEqual({ personId: ANNA, sharing: 'off', home: null, places: [] });
    expect(stays.open(ANNA)).toEqual([]);
    presence.stop();
  });

  test('stays are kept as long as the person says, and no longer', () => {
    presence.start();
    at(51.48, T);
    at(51.49, T + 60_000);
    at(51.49, T + 60_000 + LEAVE_AFTER_MS);
    expect(stays.since(ANNA, new Date(0).toISOString())).toHaveLength(1);
    people.setSharing(ANNA, { keepDays: 7 }, ANNA, new Date(now).toISOString());
    presence.prune(T + 6 * 86_400_000);
    expect(stays.since(ANNA, new Date(0).toISOString())).toHaveLength(1);
    presence.prune(T + 8 * 86_400_000);
    expect(stays.since(ANNA, new Date(0).toISOString())).toHaveLength(0);
    presence.stop();
  });

  test('a device nobody carries places nobody; one carried by someone who left places them nowhere', () => {
    devicePeople.set(PHONE, 'carries', [], new Date(T + 1).toISOString());
    presence.start();
    at(51.48, T + 2);
    expect(stays.open(ANNA)).toEqual([]);
    devicePeople.set(PHONE, 'carries', [ANNA], new Date(T + 3).toISOString());
    at(51.48, T + 4);
    expect(stays.open(ANNA)).toHaveLength(1);
    people.leave(ANNA, new Date(T + 5).toISOString());
    presence.lookAt(ANNA, T + 6);
    expect(stays.open(ANNA)).toEqual([]);
    presence.stop();
  });
});
