import { describe, expect, test } from 'bun:test';

import { MOTION_HOLD_MS, occupancy, type OpeningNode, type SensorState, type SpaceNode } from '../src/occupancy/rules.ts';

/*
  Whether a space has someone in it, from what stands there: the rules on
  their own, on made-up sensors in a made-up house.
*/

const T = Date.parse('2026-10-09T08:00:00Z');
const SPACES: SpaceNode[] = [
  { id: 'site', parentId: null },
  { id: 'ground', parentId: 'site' },
  { id: 'bath', parentId: 'ground' },
  { id: 'hall', parentId: 'ground' },
  { id: 'kitchen', parentId: 'ground' },
];
const BATH_DOOR: OpeningNode = { id: 'bath-door', fromId: 'bath', toId: 'hall', kind: 'door' };

const sensor = (deviceId: string, sense: SensorState['sense'], spaceId: string, value: SensorState['value'], at: number, more: Partial<SensorState> = {}): SensorState => ({
  deviceId,
  sense,
  spaceId,
  openingId: null,
  value,
  at,
  current: true,
  roseAt: value === true ? at : null,
  ...more,
});
const occupied = (sensors: SensorState[], now = T, openings: OpeningNode[] = [], stays: { spaceId: string; deviceId: string | null }[] = []) => occupancy({ spaces: SPACES, openings, sensors, stays, now });

describe('occupancy, by its rules', () => {
  test('motion: occupied while seen, and a while after — the room, its floor and the site', () => {
    const seen = occupied([sensor('pir', 'motion', 'kitchen', true, T)]);
    expect([...seen.keys()].sort()).toEqual(['ground', 'kitchen', 'site']);
    expect(seen.get('kitchen')).toEqual({ spaceId: 'kitchen', devices: ['pir'], peak: null });
    const quiet = sensor('pir', 'motion', 'kitchen', false, T);
    expect(occupied([quiet], T + MOTION_HOLD_MS - 1).has('kitchen')).toBe(true);
    expect(occupied([quiet], T + MOTION_HOLD_MS).has('kitchen')).toBe(false);
  });

  test('a radar that says nobody is there cuts the hold short; one that says someone is, holds it', () => {
    const quiet = sensor('pir', 'motion', 'kitchen', false, T);
    expect(occupied([quiet, sensor('radar', 'occupied', 'kitchen', false, T)], T + 1000).has('kitchen')).toBe(false);
    expect(occupied([quiet, sensor('radar', 'occupied', 'kitchen', true, T - 60_000)], T + MOTION_HOLD_MS * 3).get('kitchen')!.devices).toEqual(['radar']);
  });

  test('a sensor gone quiet says nothing: a radar not current is no one, and no reason to cut a hold', () => {
    expect(occupied([sensor('radar', 'occupied', 'kitchen', true, T - 3_600_000, { current: false })]).size).toBe(0);
    const quiet = sensor('pir', 'motion', 'kitchen', false, T);
    expect(occupied([quiet, sensor('radar', 'occupied', 'kitchen', false, T - 3_600_000, { current: false })], T + 1000).has('kitchen')).toBe(true);
  });

  test('a closed room with motion in it after its door shut: someone is still inside, until the door opens', () => {
    const shut = sensor('contact', 'open', 'bath', false, T, { openingId: 'bath-door' });
    // Moved in after the door shut, then still: long past the hold, still occupied.
    const still = sensor('pir', 'motion', 'bath', false, T + 60_000, { roseAt: T + 30_000 });
    const later = T + MOTION_HOLD_MS * 4;
    expect(occupied([shut, still], later, [BATH_DOOR]).get('bath')!.devices.sort()).toEqual(['contact', 'pir']);
    // Moved before the door shut: whoever moved left.
    expect(occupied([shut, sensor('pir', 'motion', 'bath', false, T + 60_000, { roseAt: T - 30_000 })], later, [BATH_DOOR]).has('bath')).toBe(false);
    // The door open: not closed any more.
    expect(occupied([{ ...shut, value: true, at: T + 120_000 }, still], later, [BATH_DOOR]).has('bath')).toBe(false);
    // A way in nobody watches: never closed.
    expect(occupied([shut, still], later, [BATH_DOOR, { id: 'arch', fromId: 'bath', toId: 'kitchen', kind: 'opening' }]).has('bath')).toBe(false);
    // A window is no way in.
    expect(occupied([shut, still], later, [BATH_DOOR, { id: 'window', fromId: 'bath', toId: null, kind: 'window' }]).has('bath')).toBe(true);
  });

  test('a count is the peak, and a floor counts what its rooms count; a person in a room occupies it', () => {
    const counted = occupied([sensor('counter', 'people', 'kitchen', 3, T), sensor('counter-2', 'people', 'hall', 2, T), sensor('zero', 'people', 'bath', 0, T)]);
    expect(counted.get('kitchen')!.peak).toBe(3);
    expect(counted.get('ground')).toEqual({ spaceId: 'ground', devices: ['counter', 'counter-2'], peak: 5 });
    expect(counted.has('bath')).toBe(false);
    const someone = occupied([], T, [], [{ spaceId: 'hall', deviceId: 'watch' }]);
    expect(someone.get('hall')!.devices).toEqual(['watch']);
  });
});
