import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MAIN_PART, nodeId, type DeviceDescription } from '@kraftverk/device-sdk';

import { DeviceCatalog, LabelStore, NodeStore, PlaceStore, SpaceStore, type SqlDatabase } from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

/*
  A family's labels (docs/PLAN-WORLD-MODEL.md §8.13), on devices and spaces
  — on every driver a place opens SQLite with.
*/

const LAMP: DeviceDescription = { parts: [{ id: MAIN_PART, label: 'Lamp', kind: 'light' }], attributes: [] };

for (const driver of DRIVERS) {
  describe(driver.name, () => {
    let database: SqlDatabase;
    let labels: LabelStore;

    beforeAll(async () => {
      database = await driver.open();
      new NodeStore(database).declareSelf({ id: nodeId('n-000000000000000000000000A1'), name: 'Test machine', platform: 'system', transports: [], alwaysOn: true, reachable: true, trusted: true });
      labels = new LabelStore(database);
    });
    afterAll(() => database.close());

    test('made, by a name no other has; put on a device and a space; taken off everything when it goes', () => {
      const lamp = new DeviceCatalog(database).add({ typeId: 'test.lamp', name: 'Hall lamp', description: LAMP });
      const home = new PlaceStore(database).addHome({ name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' });
      const spaces = new SpaceStore(database);
      const upstairs = spaces.addSpace({ parentId: spaces.site(home.id).id, kind: 'floor', name: 'Upstairs', level: 1 });

      const heating = labels.add({ name: 'Heating', color: '#ff8800' });
      const night = labels.add({ name: 'Night' });
      expect(heating).toMatchObject({ key: 'heating', name: 'Heating', color: '#ff8800' });
      expect(() => labels.add({ name: 'heating' })).toThrow('already');
      expect(() => labels.add({ name: 'Wrong', color: 'orange' })).toThrow();

      labels.set({ device: lamp.id }, [heating.id, night.id]);
      labels.set({ space: upstairs.id }, [night.id]);
      expect(labels.on({ device: lamp.id }).map((label) => label.name)).toEqual(['Heating', 'Night']);
      expect(labels.labelled()).toEqual({ devices: { [lamp.id]: [heating.id, night.id] }, spaces: { [upstairs.id]: [night.id] }, automations: {} });

      labels.set({ device: lamp.id }, [night.id]);
      expect(labels.on({ device: lamp.id }).map((label) => label.key)).toEqual(['night']);
      expect(labels.update(night.id, { name: 'Bedtime' })).toMatchObject({ key: 'night', name: 'Bedtime' });
      labels.remove(night.id);
      expect(labels.labelled()).toEqual({ devices: {}, spaces: {}, automations: {} });
      expect(labels.list().map((label) => label.name)).toEqual(['Heating']);
    });
  });
}
