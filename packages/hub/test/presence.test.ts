import { beforeEach, describe, expect, test } from 'bun:test';

import type { DeviceView } from '@kraftverk/api-contract';
import { savedDeviceId, SPOT_SHAPE } from '@kraftverk/device-sdk';
import type { LiveListener, LiveMessage } from '@kraftverk/holder';
import { DevicePeopleStore, PeopleStore, PlaceStore, PresenceStore, SpaceStore, type SqlDatabase } from '@kraftverk/store';

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
const WATCH = savedDeviceId('d-watch');
const T = Date.parse('2026-10-08T12:00:00Z');

let db: SqlDatabase;
let people: PeopleStore;
let places: PlaceStore;
let devicePeople: DevicePeopleStore;
let stays: PresenceStore;
let spaces: SpaceStore;
/** Where the watch's beacons say it is, on their map of the house, and when. */
let spot: { x: number; y: number; at: number } | null;
let rooms: Record<string, string>;
let presence: Presence;
let heard: LiveListener | null;
/** What presence said on the bus. */
let said: LiveMessage[];
/** Where the phone says it is, and when. */
let position: { latitude: number; at: number } | null;
let now = T;

beforeEach(() => {
  db = testDatabase();
  db.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES ('d-phone', 'phone', 'test.phone', 'Anna’s phone', '{\"parts\":[],\"attributes\":[]}', '2026-06-01T00:00:00Z')").run();
  db.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES ('d-watch', 'watch', 'test.watch', 'Anna’s watch', '{\"parts\":[],\"attributes\":[]}', '2026-06-01T00:00:00Z')").run();
  people = new PeopleStore(db);
  places = new PlaceStore(db);
  devicePeople = new DevicePeopleStore(db);
  stays = new PresenceStore(db);
  people.ensureKeyless(ANNA, 'Anna', new Date(T).toISOString());
  people.addMember(ANNA, { role: 'member', invitedBy: null, at: new Date(T).toISOString() });
  places.addHome({ key: 'home', name: 'Home', type: 'house', timeZone: 'Europe/London', location: { latitude: 51.48, longitude: 0, radius: 150 } });
  places.addZone({ key: 'work', name: 'Work', location: { latitude: 51.5, longitude: 0, radius: 200 } });
  devicePeople.set(PHONE, 'carries', [ANNA], new Date(T).toISOString());
  // The house drawn: a kitchen and a hall side by side on its ground floor.
  spaces = new SpaceStore(db);
  const homeId = places.homeByKey('home')!.id;
  const site = spaces.site(homeId);
  const ground = spaces.addSpace({ parentId: site.id, kind: 'floor', name: 'Ground floor' });
  const kitchen = spaces.addSpace({ parentId: ground.id, kind: 'room', name: 'Kitchen', outline: [[0, 0], [4, 0], [4, 3], [0, 3]] });
  const hall = spaces.addSpace({ parentId: ground.id, kind: 'room', name: 'Hall', outline: [[4, 0], [8, 0], [8, 3], [4, 3]] });
  rooms = { home: homeId, site: site.id, kitchen: kitchen.id, hall: hall.id };
  spot = null;
  position = null;
  heard = null;
  said = [];
  now = T;
  const phone = () =>
    ({ description: { parts: [], attributes: [] }, placement: null, readings: position ? [{ key: 'position', value: { latitude: position.latitude, longitude: 0, accuracy: 10 }, at: new Date(position.at).toISOString() }] : [] }) as unknown as DeviceView;
  // The watch's map is the house's beacons': its origin at the site's.
  const watch = () =>
    ({
      description: { parts: [], attributes: [{ key: 'spot', label: 'Where', value: SPOT_SHAPE, means: 'spot' }] },
      placement: { part: 'main', homeId: rooms.home, spaceId: rooms.site, openingId: null, x: 0, y: 0, z: null, facing: 0, role: 'stands', since: '', until: null },
      readings: spot ? [{ key: 'spot', value: { x: spot.x, y: spot.y }, at: new Date(spot.at).toISOString() }] : [],
    }) as unknown as DeviceView;
  presence = new Presence({
    people,
    devicePeople,
    places,
    stays,
    spaces,
    views: { find: (id) => (id === PHONE ? phone() : id === WATCH ? watch() : null) },
    bus: { subscribe: (listener) => ((heard = listener), () => (heard = null)), publish: (message) => void said.push(message) },
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

describe('a person’s room', () => {
  test('a watch the house’s beacons hear: in the kitchen, then the hall, said on the bus; gone quiet, in none; below places, never kept', () => {
    devicePeople.set(WATCH, 'carries', [ANNA], new Date(T).toISOString());
    spot = { x: 1, y: 1, at: T };
    presence.lookAt(ANNA, T);
    expect(stays.room(ANNA)).toMatchObject({ spaceId: rooms.kitchen, since: new Date(T).toISOString(), deviceId: WATCH });
    expect(stays.rooms(rooms.home!)).toEqual([{ personId: ANNA, spaceId: rooms.kitchen!, since: new Date(T).toISOString(), deviceId: WATCH }]);
    // Into the hall: the kitchen ends as the hall begins.
    spot = { x: 6, y: 1, at: T + 30_000 };
    presence.lookAt(ANNA, T + 30_000);
    expect(stays.room(ANNA)?.spaceId).toBe(rooms.hall);
    expect(said.filter((message) => message.kind === 'presence' && message.place.kind === 'space').map((message) => message.kind === 'presence' && [message.change, message.place.id])).toEqual([
      ['arrived', rooms.kitchen!],
      ['left', rooms.kitchen!],
      ['arrived', rooms.hall!],
    ]);
    // Nothing heard for minutes: in no room.
    presence.lookAt(ANNA, T + 30_000 + 3 * 60_000);
    expect(stays.room(ANNA)).toBeNull();
    // Outside every drawn room: in none.
    spot = { x: 20, y: 20, at: T + 600_000 };
    presence.lookAt(ANNA, T + 600_000);
    expect(stays.room(ANNA)).toBeNull();
    // Home or away only: a room is more than that, and is not kept.
    people.setSharing(ANNA, { level: 'home-away' }, ANNA, new Date(T).toISOString());
    spot = { x: 1, y: 1, at: T + 700_000 };
    presence.lookAt(ANNA, T + 700_000);
    expect(stays.room(ANNA)).toBeNull();
  });
});

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
    // Said on the bus as it was decided: for automations — who, where, which way.
    const home = places.homeByKey('home')!.id;
    expect(said.map((message) => message.kind === 'presence' && [message.change, message.place.id, message.personId])).toEqual([
      ['arrived', home, ANNA],
      ['left', home, ANNA],
    ]);

    // At work: "at work", never coordinates.
    at(51.5, T + 3_600_000);
    const atWork = (await answered())[0]!;
    expect(atWork).toEqual({ personId: ANNA, sharing: 'places', home: false, places: [{ id: places.zoneByKey('work')!.id, kind: 'zone', name: 'Work', since: new Date(T + 3_600_000).toISOString() }], room: null });
    expect(JSON.stringify(atWork)).not.toContain('51.5');

    // Home or away only: the zone ends, and the answer says only that.
    people.setSharing(ANNA, { level: 'home-away' }, ANNA, new Date(now).toISOString());
    presence.lookAt(ANNA);
    expect((await answered())[0]).toEqual({ personId: ANNA, sharing: 'home-away', home: false, places: [], room: null });
    expect(stays.open(ANNA)).toEqual([]);

    // Nothing: nothing to say, and nothing kept from then.
    people.setSharing(ANNA, { level: 'off' }, ANNA, new Date(now).toISOString());
    at(51.48, T + 7_200_000);
    expect((await answered())[0]).toEqual({ personId: ANNA, sharing: 'off', home: null, places: [], room: null });
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
