import { beforeEach, describe, expect, test } from 'bun:test';

import type { DeviceView, PlacementView } from '@kraftverk/api-contract';
import { savedDeviceId, type AttributeSpec, type Reading } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';
import { HistoryStore, OccupancyStore, PlaceStore, SpaceStore, type SqlDatabase } from '@kraftverk/store';

import { occupancyApi } from '../src/api/occupancy.ts';
import type { Hub } from '../src/node/hub.ts';
import { Occupancy, OCCUPANCY_DAYS } from '../src/occupancy/occupancy.ts';
import { MOTION_HOLD_MS } from '../src/occupancy/rules.ts';
import { testDatabase } from './home.ts';

/*
  Occupancy kept: a motion sensor in the bathroom and a contact on its door,
  their readings as their views say them, on a clock the test moves — the
  bathroom, its floor and the site occupied and let go, said on the bus,
  answered, and forgotten after 30 days.
*/

const T = Date.parse('2026-10-09T08:00:00Z');
const PIR = savedDeviceId('d-pir');
const CONTACT = savedDeviceId('d-contact');

let db: SqlDatabase;
let spaces: SpaceStore;
let store: OccupancyStore;
let occupancy: Occupancy;
let said: LiveMessage[];
let now = T;
let homeId: string;
let ids: Record<string, string>;
/** What each sensor says now. */
let readings: Record<string, Reading[]>;
/** What hears the bus: the service, once started. */
let listener: ((message: LiveMessage) => void) | null;

const attribute = (key: string, means: string): AttributeSpec => ({ key, label: key, value: { type: 'boolean' }, means });
const view = (id: string, attributes: AttributeSpec[], placement: Partial<PlacementView>): DeviceView =>
  ({ id, description: { parts: [], attributes }, readings: readings[id] ?? [], placement: { part: 'main', homeId, openingId: null, x: null, y: null, z: null, facing: null, role: 'stands', since: '', until: null, ...placement } }) as unknown as DeviceView;

beforeEach(() => {
  db = testDatabase();
  for (const [id, key] of [
    ['d-pir', 'pir'],
    ['d-contact', 'contact'],
  ])
    db.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES (?, ?, 'test.sensor', ?, '{\"parts\":[],\"attributes\":[]}', '2026-06-01T00:00:00Z')").run(id, key, key);
  const places = new PlaceStore(db);
  spaces = new SpaceStore(db);
  store = new OccupancyStore(db);
  homeId = places.addHome({ key: 'home', name: 'Home', type: 'house', timeZone: 'Europe/London' }).id;
  const site = spaces.site(homeId);
  const ground = spaces.addSpace({ parentId: site.id, kind: 'floor', name: 'Ground floor' });
  const bath = spaces.addSpace({ parentId: ground.id, kind: 'room', purpose: 'bathroom', name: 'Bathroom' });
  const hall = spaces.addSpace({ parentId: ground.id, kind: 'room', purpose: 'hallway', name: 'Hall' });
  const door = spaces.addOpening({ fromId: bath.id, toId: hall.id, kind: 'door' });
  ids = { site: site.id, ground: ground.id, bath: bath.id, door: door.id };
  readings = {};
  said = [];
  listener = null;
  // Started long enough ago that what it heard as it started is behind it.
  now = T - 10 * 60_000;
  occupancy = new Occupancy({
    places,
    spaces,
    store,
    views: { all: () => [view(PIR, [attribute('occupancy', 'motion')], { spaceId: ids.bath! }), view(CONTACT, [attribute('contact', 'open')], { spaceId: ids.bath!, openingId: ids.door! })] },
    history: new HistoryStore(db),
    bus: { subscribe: (heard) => ((listener = heard), () => {}), publish: (message) => void said.push(message) },
    clock: { now: () => now, setTimeout: () => ({ clock: 'timer' }), setInterval: () => ({ clock: 'timer' }), clear: () => {}, rate: 1 },
  });
  occupancy.start();
  now = T;
});

/** A sensor says something, as its device does: its view, and the bus. */
const says = (id: string, key: string, value: boolean, at = now) => {
  readings[id] = [{ key, value, at: new Date(at).toISOString() }];
  listener?.({ kind: 'readings', deviceId: id as never, readings: readings[id]! });
};
const occupiedNow = () => store.open(homeId).map((record) => record.spaceId).sort();

describe('occupancy kept', () => {
  test('motion in the bathroom: it, its floor and the site occupied, said on the bus, answered — and let go once the hold runs out', async () => {
    says(PIR, 'occupancy', true);
    occupancy.look();
    expect(occupiedNow()).toEqual([ids.bath!, ids.ground!, ids.site!].sort());
    expect(said.filter((message) => message.kind === 'occupancy').map((message) => message.kind === 'occupancy' && [message.spaceId, message.occupied])).toContainEqual([ids.bath!, true]);
    const answered = await occupancyApi({ places: { home: () => ({ id: homeId }) }, occupancies: store, spaces } as unknown as Hub).occupancy.now(homeId);
    expect(answered.find((each) => each.spaceId === ids.bath)).toEqual({ spaceId: ids.bath!, since: new Date(T).toISOString(), until: null, peak: null, devices: [PIR] });

    // Nobody moves: still occupied for the hold, then not.
    now = T + 60_000;
    says(PIR, 'occupancy', false);
    occupancy.look();
    expect(occupiedNow()).toHaveLength(3);
    now = T + 60_000 + MOTION_HOLD_MS;
    occupancy.look();
    expect(occupiedNow()).toEqual([]);
    expect(said.filter((message) => message.kind === 'occupancy' && !message.occupied)).toHaveLength(3);
    // Its battery said, still nobody moving: nothing starts again.
    says(PIR, 'occupancy', false);
    occupancy.look();
    expect(occupiedNow()).toEqual([]);
    expect(store.since(ids.bath!, new Date(0).toISOString())[0]).toMatchObject({ since: new Date(T).toISOString(), until: new Date(now).toISOString() });

    // Thirty days on, forgotten.
    now += OCCUPANCY_DAYS * 86_400_000 + 1;
    occupancy.prune();
    expect(store.since(ids.bath!, new Date(0).toISOString())).toEqual([]);
  });

  test('the door shut, then motion: occupied long past the hold, until the door opens', () => {
    says(CONTACT, 'contact', false);
    now = T + 10_000;
    says(PIR, 'occupancy', true);
    occupancy.look();
    now = T + 70_000;
    says(PIR, 'occupancy', false);
    // Readings refreshed as a device that is still there does.
    readings[CONTACT] = [{ key: 'contact', value: false, at: new Date(T).toISOString(), confirmedAt: new Date(now).toISOString() }];
    now = T + MOTION_HOLD_MS * 3;
    readings[CONTACT] = [{ key: 'contact', value: false, at: new Date(T).toISOString(), confirmedAt: new Date(now).toISOString() }];
    occupancy.look();
    expect(store.open(homeId).find((record) => record.spaceId === ids.bath)?.devices).toEqual([CONTACT, PIR].sort());
    says(CONTACT, 'contact', true);
    occupancy.look();
    expect(occupiedNow()).toEqual([]);
  });

  test('just started, what it hears is what was kept: nothing ends until every sensor has had its say', () => {
    says(PIR, 'occupancy', true);
    occupancy.look();
    expect(occupiedNow()).toHaveLength(3);
    // Restarted: the sensor's last word kept, not current — nothing ends for the length of a hold.
    const again = new Occupancy({ places: new PlaceStore(db), spaces, store, views: { all: () => [view(PIR, [attribute('occupancy', 'motion')], { spaceId: ids.bath! })] }, history: new HistoryStore(db), bus: { subscribe: () => () => {}, publish: () => {} }, clock: { now: () => now, setTimeout: () => ({ clock: 'timer' }), setInterval: () => ({ clock: 'timer' }), clear: () => {}, rate: 1 } });
    readings[PIR] = [{ key: 'occupancy', value: false, at: new Date(T - 3_600_000).toISOString() }];
    again.start();
    expect(occupiedNow()).toHaveLength(3);
    now = T + MOTION_HOLD_MS + 1000;
    again.look();
    expect(occupiedNow()).toEqual([]);
    again.stop();
  });

  test('a home archived: what was open in it ends', () => {
    says(PIR, 'occupancy', true);
    occupancy.look();
    new PlaceStore(db).archiveHome(homeId);
    occupancy.look();
    expect(store.allOpen()).toEqual([]);
  });

  test('a device deleted takes its evidence with it', () => {
    says(PIR, 'occupancy', true);
    occupancy.look();
    db.query('DELETE FROM device WHERE id = ?').run(PIR);
    expect(store.open(homeId)[0]!.devices).toEqual([]);
  });
});
