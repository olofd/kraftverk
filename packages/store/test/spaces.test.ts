import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { actor, MAIN_PART, nodeId, type DeviceDescription } from '@kraftverk/device-sdk';

import { DeviceCatalog, NodeStore, PlaceStore, SpaceStore, type SqlDatabase } from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

/*
  A home's spaces, the openings between them, and where each device stands
  over time (docs/PLAN-WORLD-MODEL.md §8.5, §8.7) — on every driver a place
  opens SQLite with.
*/

const LAMP: DeviceDescription = { parts: [{ id: MAIN_PART, label: 'Sensor', kind: 'sensor' }], attributes: [] };
const OLOF = actor('person', 'olof');
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();

for (const driver of DRIVERS) {
  describe(driver.name, () => {
    let database: SqlDatabase;
    let places: PlaceStore;
    let spaces: SpaceStore;
    let catalog: DeviceCatalog;

    beforeAll(async () => {
      database = await driver.open();
      new NodeStore(database).declareSelf({ id: nodeId('n-000000000000000000000000A1'), name: 'Test machine', platform: 'system', transports: [], alwaysOn: true, reachable: true, trusted: true });
      places = new PlaceStore(database);
      spaces = new SpaceStore(database);
      catalog = new DeviceCatalog(database);
    });
    afterAll(() => database.close());

    test('a home is a tree of spaces from its site: each after its parent, its keys its own', () => {
      const home = places.addHome({ name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' });
      const site = spaces.site(home.id);
      expect(site).toMatchObject({ kind: 'site', key: 'site', parentId: null });
      const house = spaces.addSpace({ parentId: site.id, kind: 'building', name: 'House' });
      const ground = spaces.addSpace({ parentId: house.id, kind: 'floor', name: 'Ground floor', level: 0 });
      const kitchen = spaces.addSpace({ parentId: ground.id, kind: 'room', purpose: 'kitchen', name: 'Kitchen' });
      spaces.addSpace({ parentId: site.id, kind: 'outdoor', name: 'Garden' });
      expect(spaces.spaces(home.id).map((space) => space.key)).toEqual(['site', 'house', 'ground-floor', 'kitchen', 'garden']);
      expect(kitchen).toMatchObject({ homeId: home.id, purpose: 'kitchen', level: null });
      expect(ground.level).toBe(0);
      // A key taken in this home is taken; another home has its own.
      expect(() => spaces.addSpace({ parentId: site.id, kind: 'room', name: 'Kitchen', key: 'kitchen' })).toThrow();
      const cabin = places.addHome({ name: 'Cabin', type: 'cabin', timeZone: 'Europe/Stockholm' });
      expect(spaces.addSpace({ parentId: spaces.site(cabin.id).id, kind: 'room', name: 'Kitchen' }).key).toBe('kitchen');
      // A space put inside itself is refused.
      expect(() => spaces.updateSpace(house.id, { parentId: kitchen.id })).toThrow('inside itself');
    });

    test('a parent is always in the same home: the database refuses another', () => {
      const one = places.addHome({ name: 'One', type: 'house', timeZone: 'UTC' });
      const two = places.addHome({ name: 'Two', type: 'house', timeZone: 'UTC' });
      const room = spaces.addSpace({ parentId: spaces.site(one.id).id, kind: 'room', name: 'Room' });
      expect(() => database.query('UPDATE space SET parent_id = ? WHERE id = ?').run(spaces.site(two.id).id, room.id)).toThrow();
    });

    test('a device moved keeps each room its own: the bedroom before, the kitchen after, never both', () => {
      const home = places.addHome({ name: 'Flat', type: 'apartment', timeZone: 'UTC' });
      const site = spaces.site(home.id);
      const bedroom = spaces.addSpace({ parentId: site.id, kind: 'room', name: 'Bedroom' });
      const kitchen = spaces.addSpace({ parentId: site.id, kind: 'room', name: 'Kitchen' });
      const sensor = catalog.add({ typeId: 'test.sensor', name: 'Sensor', description: LAMP });
      spaces.place(sensor.id, { spaceId: bedroom.id }, OLOF, at(0));
      spaces.place(sensor.id, { spaceId: kitchen.id }, OLOF, at(60));
      expect(spaces.placement(sensor.id)).toMatchObject({ homeId: home.id, spaceId: kitchen.id, since: at(60), until: null });
      expect(spaces.history(sensor.id).map((each) => [each.spaceId, each.since, each.until])).toEqual([
        [bedroom.id, at(0), at(60)],
        [kitchen.id, at(60), null],
      ]);
      // Which stood in the bedroom from 00:30 to 01:30: the sensor, until 01:00.
      expect(spaces.stoodIn(bedroom.id, at(30), at(90))).toEqual([{ deviceId: sensor.id, part: 'main', since: at(0), until: at(60) }]);
      // Placed where it is, as it is: nothing changes.
      spaces.place(sensor.id, { spaceId: kitchen.id }, OLOF, at(120));
      expect(spaces.history(sensor.id)).toHaveLength(2);
      // Never two open at once: the database says so too.
      expect(() => database.query("INSERT INTO placement (id, device_id, part, space_id, since, actor_kind, actor_name) VALUES ('pl-x', ?, 'main', ?, ?, 'person', 'x')").run(sensor.id, bedroom.id, at(200))).toThrow();
    });

    test('at an opening of its space only; and a space archived takes its openings, and what stood in it moves out to its parent', () => {
      const home = places.addHome({ name: 'House', type: 'house', timeZone: 'UTC' });
      const site = spaces.site(home.id);
      const hall = spaces.addSpace({ parentId: site.id, kind: 'room', name: 'Hall' });
      const den = spaces.addSpace({ parentId: site.id, kind: 'room', name: 'Den' });
      const front = spaces.addOpening({ fromId: hall.id, toId: null, kind: 'door', name: 'Front door' });
      expect(front.key).toBe('front-door');
      const contact = catalog.add({ typeId: 'test.contact', name: 'Front door sensor', description: LAMP });
      expect(() => spaces.place(contact.id, { spaceId: den.id, openingId: front.id }, OLOF)).toThrow('not one of that space');
      spaces.place(contact.id, { spaceId: hall.id, openingId: front.id }, OLOF, at(0));
      spaces.archiveSpace(hall.id, OLOF);
      expect(spaces.space(hall.id)?.removedAt).not.toBeNull();
      expect(spaces.opening(front.id)?.removedAt).not.toBeNull();
      expect(spaces.placement(contact.id)).toMatchObject({ spaceId: site.id, openingId: null });
      // History keeps where it stood.
      expect(spaces.history(contact.id)[0]).toMatchObject({ spaceId: hall.id, openingId: front.id });
    });
  });
}
