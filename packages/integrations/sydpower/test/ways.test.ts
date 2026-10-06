import { expect, test } from 'bun:test';

import { SYDPOWER_WAYS } from '../src/index.ts';

test('a Sydpower station is reached two ways, both its protocol: Wi-Fi through the broker first, and Bluetooth', () => {
  expect(SYDPOWER_WAYS.map((way) => [way.id, way.protocol, way.transport, way.reach])).toEqual([
    ['wifi', 'sydpower', 'mqtt', 'local'],
    ['bluetooth', 'sydpower', 'ble', 'local'],
  ]);
  expect(SYDPOWER_WAYS.filter((way) => way.recommended).map((way) => way.id)).toEqual(['wifi']);
});
