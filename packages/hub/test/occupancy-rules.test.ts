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
  { id: 'nook', parentId: 'kitchen' },
];
const BATH_DOOR: OpeningNode = { id: 'bath-door', fromId: 'bath', toId: 'hall', kind: 'door' };

/** A sensor that took its value at \`since\`, and has said nothing since. */
const sensor = (deviceId: string, sense: SensorState['sense'], spaceId: string, value: SensorState['value'], since: number, more: Partial<SensorState> = {}): SensorState => ({
  deviceId,
  sense,
  spaceId,
  openingId: null,
  value,
  current: true,
  since,
  heard: since,
  roseAt: value === true ? since : null,
  ...more,
});
const found = (sensors: SensorState[], now = T, openings: OpeningNode[] = [], stays: { spaceId: string }[] = []) => occupancy({ spaces: SPACES, openings, sensors, stays, now });
const occupied = (...args: Parameters<typeof found>) => found(...args).occupied;

describe('occupancy, by its rules', () => {
  test('motion: occupied while seen, and a while after it turned to nobody — the room, its floor and the site; when the hold runs out is said', () => {
    const seen = occupied([sensor('pir', 'motion', 'kitchen', true, T)]);
    expect([...seen.keys()].sort()).toEqual(['ground', 'kitchen', 'site']);
    expect(seen.get('kitchen')).toEqual({ spaceId: 'kitchen', devices: ['pir'], peak: null });
    const quiet = sensor('pir', 'motion', 'kitchen', false, T);
    expect(found([quiet], T + 1000)).toMatchObject({ next: T + MOTION_HOLD_MS });
    expect(occupied([quiet], T + MOTION_HOLD_MS - 1).has('kitchen')).toBe(true);
    expect(occupied([quiet], T + MOTION_HOLD_MS).has('kitchen')).toBe(false);
  });

  test('the hold runs from when it turned to nobody, not from when it last spoke: a battery report starts nothing again', () => {
    const quiet = sensor('pir', 'motion', 'kitchen', false, T, { heard: T + MOTION_HOLD_MS });
    expect(occupied([quiet], T + MOTION_HOLD_MS + 1000).has('kitchen')).toBe(false);
    // When it turned is not known: no hold to run.
    expect(occupied([{ ...quiet, since: null }], T + 1000).has('kitchen')).toBe(false);
  });

  test('gone quiet still saying someone moves: held from when it last spoke', () => {
    const stuck = sensor('pir', 'motion', 'kitchen', true, T - 3_600_000, { current: false, heard: T });
    expect(occupied([stuck], T + MOTION_HOLD_MS - 1).has('kitchen')).toBe(true);
    expect(occupied([stuck], T + MOTION_HOLD_MS).has('kitchen')).toBe(false);
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
    // The door's sensor speaks again, its battery: it shut when it shut — the room stays sealed.
    expect(occupied([{ ...shut, heard: later - 1000 }, still], later, [BATH_DOOR]).has('bath')).toBe(true);
    // Moved before the door shut: whoever moved left.
    expect(occupied([shut, sensor('pir', 'motion', 'bath', false, T + 60_000, { roseAt: T - 30_000 })], later, [BATH_DOOR]).has('bath')).toBe(false);
    // The door open: not closed any more.
    expect(occupied([{ ...shut, value: true, since: T + 120_000 }, still], later, [BATH_DOOR]).has('bath')).toBe(false);
    // When it shut not known: not closed, as far as anything here can tell.
    expect(occupied([{ ...shut, since: null }, still], later, [BATH_DOOR]).has('bath')).toBe(false);
    // A way in nobody watches: never closed.
    expect(occupied([shut, still], later, [BATH_DOOR, { id: 'arch', fromId: 'bath', toId: 'kitchen', kind: 'opening' }]).has('bath')).toBe(false);
    // A window is no way in.
    expect(occupied([shut, still], later, [BATH_DOOR, { id: 'window', fromId: 'bath', toId: null, kind: 'window' }]).has('bath')).toBe(true);
  });

  test('a count is the peak; a floor adds up its rooms — but a counter in a room counts the nook within it too; a person in a room occupies it by nobody’s device', () => {
    const counted = occupied([sensor('counter', 'people', 'kitchen', 3, T), sensor('nook-counter', 'people', 'nook', 2, T), sensor('counter-2', 'people', 'hall', 2, T), sensor('zero', 'people', 'bath', 0, T)]);
    expect(counted.get('kitchen')!.peak).toBe(3);
    expect(counted.get('nook')!.peak).toBe(2);
    expect(counted.get('ground')).toEqual({ spaceId: 'ground', devices: ['counter', 'counter-2', 'nook-counter'], peak: 5 });
    expect(counted.has('bath')).toBe(false);
    const someone = occupied([], T, [], [{ spaceId: 'hall' }]);
    expect(someone.get('hall')).toEqual({ spaceId: 'hall', devices: [], peak: null });
    expect(someone.has('ground')).toBe(true);
  });
});
