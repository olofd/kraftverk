import { describe, expect, test } from 'bun:test';

import { pairedOf, ZigbeeDevices } from '../src/gateway.ts';

/*
  A gateway knows what is paired with it from the start — as the Smart
  Life sign-in says, by Zigbee address and name — so a quiet plug behind it
  is offered to add before it has said a thing.
*/

const memoryStore = () => {
  const kept = new Map<string, unknown>();
  return { get: <T>(key: string) => (kept.get(key) as T) ?? null, set: (key: string, value: unknown) => void kept.set(key, value), delete: (key: string) => void kept.delete(key) };
};
const wire = { status: async () => ({}), refresh: async () => {}, set: async () => ({}), connected: () => true, version: () => '3.4' };

describe('what is paired with a gateway', () => {
  test('read as its way keeps it: address=name, comma-separated; what is not an address is left out', () => {
    expect([...pairedOf('A4C1380000000001=Fan plug, a4c1380000000002=, nonsense=x, a4c1380000000003')]).toEqual([
      ['a4c1380000000001', 'Fan plug'],
      ['a4c1380000000002', null],
      ['a4c1380000000003', null],
    ]);
    expect([...pairedOf(undefined)]).toEqual([]);
  });

  test('its members from the start, by name — and one it hears of later beside them', () => {
    const devices = new ZigbeeDevices(wire, memoryStore() as never, () => {}, pairedOf('a4c1380000000001=Fan plug'));
    expect(devices.members()).toEqual([{ key: 'a4c1380000000001', name: 'Fan plug', model: null, identity: 'zigbee:a4c1380000000001', typeId: null }]);
    devices.presence('a4c1380000000002', true);
    expect(devices.members().map((member) => [member.key, member.name])).toEqual([
      ['a4c1380000000001', 'Fan plug'],
      ['a4c1380000000002', null],
    ]);
  });
});
