import { describe, expect, test } from 'bun:test';

import { transportStore } from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

for (const driver of DRIVERS) {
  describe(driver.name, () => {
    test('a transport keeps its own, and cannot reach another’s', async () => {
      const database = await driver.open();
      const ble = transportStore(database, 'ble');
      const matter = transportStore(database, 'matter');
      ble.set('bond', 'one');
      matter.set('bond', 'two');
      ble.set('bond', 'three');
      expect(ble.get('bond')).toBe('three');
      expect(matter.get('bond')).toBe('two');
      // Kept between runs: a new handle reads what the last one wrote.
      expect(transportStore(database, 'ble').get('bond')).toBe('three');
      ble.delete('bond');
      expect(ble.get('bond')).toBeNull();
      expect(matter.get('bond')).toBe('two');
      database.close();
    });
  });
}
