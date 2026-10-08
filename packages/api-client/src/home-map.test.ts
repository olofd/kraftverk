import { describe, expect, test } from 'bun:test';

import type { DeviceView, HomeView, OccupancyView, SpaceView } from '@kraftverk/api-contract';
import { globeToSite } from '@kraftverk/map';

import { homeMapOf, mapLevels, outlineFrom, placementAt, spacesWithin } from './home-map.ts';

/*
  A home's map, as a screen draws it: a floor's rooms on the Earth, filled
  while occupied; what stands at coordinates; a robot cleaner where its own
  map says; corners tapped kept as metres in a room's frame. Made-up places
  near Greenwich.
*/

const HOME = { id: 'h-1', name: 'Home', location: { latitude: 51.4779, longitude: 0, radius: 150 }, bearing: 0 } as HomeView;
const space = (id: string, parentId: string | null, kind: SpaceView['kind'], more: Partial<SpaceView> = {}): SpaceView => ({
  id,
  homeId: 'h-1',
  parentId,
  key: id,
  kind,
  purpose: null,
  name: id[0]!.toUpperCase() + id.slice(1),
  icon: null,
  pictureId: null,
  position: 0,
  level: kind === 'floor' ? 0 : null,
  elevation: null,
  height: null,
  frame: null,
  outline: null,
  plan: null,
  createdAt: '2026-10-09T00:00:00.000Z',
  removedAt: null,
  ...more,
});
const SPACES = [
  space('site', null, 'site'),
  space('ground', 'site', 'floor', { plan: { pictureId: 'p'.repeat(64), scale: 0.01, x: 0, y: 8, turn: 0, width: 1000, height: 800 } }),
  space('upstairs', 'site', 'floor', { level: 1 }),
  space('kitchen', 'ground', 'room', { outline: [[0, 0], [4, 0], [4, 3], [0, 3]] }),
  space('hall', 'ground', 'room', { frame: { x: 4, y: 0, turn: 0 }, outline: [[0, 0], [4, 0], [4, 3], [0, 3]] }),
  space('pantry', 'ground', 'room'),
  space('bedroom', 'upstairs', 'room'),
];
const device = (id: string, placement: Partial<DeviceView['placement']> | null, more: Partial<DeviceView> = {}) =>
  ({
    id,
    name: id,
    description: { parts: [], attributes: [] },
    readings: [],
    placement: placement ? { part: 'main', homeId: 'h-1', openingId: null, x: null, y: null, z: null, facing: null, role: 'stands', since: '', until: null, spaceId: 'site', ...placement } : null,
    ...more,
  }) as unknown as DeviceView;
const OCCUPIED: OccupancyView[] = [
  { spaceId: 'kitchen', since: '2026-10-09T08:00:00.000Z', until: null, peak: null, devices: ['pir'] },
  { spaceId: 'ground', since: '2026-10-09T08:00:00.000Z', until: null, peak: null, devices: ['pir'] },
];

describe('a home’s map', () => {
  test('its levels, lowest first; and what is within one', () => {
    expect(mapLevels(SPACES).map((each) => each.id)).toEqual(['ground', 'upstairs']);
    expect(mapLevels([space('site', null, 'site'), space('kitchen', 'site', 'room')]).map((each) => each.id)).toEqual(['site']);
    expect(spacesWithin(SPACES, 'ground').map((each) => each.id)).toEqual(['ground', 'kitchen', 'hall', 'pantry']);
  });

  test('a floor: its rooms drawn, the kitchen filled — not the floor — what stands at coordinates, a robot where its map says, and the drawing', () => {
    const robot = device(
      'robot',
      { spaceId: 'ground', x: 1, y: 1, facing: 0 },
      { description: { parts: [], attributes: [{ key: 'spot', label: 'Where', value: { type: 'object', fields: {} }, means: 'spot' }] }, readings: [{ key: 'spot', value: { x: 5, y: 1 }, at: '' }] } as Partial<DeviceView>
    );
    const map = homeMapOf({ home: HOME, spaces: SPACES, devices: [device('lamp', { spaceId: 'hall', x: 2, y: 1.5 }), device('plug', { spaceId: 'kitchen' }), device('far', { spaceId: 'bedroom', x: 1, y: 1 }), robot], occupancy: OCCUPIED, showing: 'ground' });
    expect(map.areas.map((area) => [area.id, area.filled])).toEqual([
      ['kitchen', true],
      ['hall', false],
    ]);
    expect(map.occupied).toEqual([{ spaceId: 'kitchen', name: 'Kitchen', since: '2026-10-09T08:00:00.000Z', peak: null, by: ['a device'] }]);
    expect(map.drawn.map((each) => each.id)).toEqual(['kitchen', 'hall']);
    expect(map.undrawn.map((each) => each.id)).toEqual(['pantry']);
    const at = (id: string) => {
      const marker = map.markers.find((each) => each.id === id)!;
      return globeToSite(map.anchor!, [marker.longitude, marker.latitude]).map((each) => Math.round(each * 100) / 100);
    };
    // The lamp, 2 m into the hall, which starts 4 m along: 6 m east of the site's origin.
    expect(at('lamp')).toEqual([6, 1.5]);
    // The robot's map starts at its dock, 1 m in: it says 5 m along, so 6 m.
    expect(at('robot')).toEqual([6, 2]);
    expect(map.markers.map((each) => each.id).sort()).toEqual(['lamp', 'robot']);
    const [topLeft, , bottomRight] = map.drawing!.corners;
    expect(globeToSite(map.anchor!, topLeft).map(Math.round)).toEqual([0, 8]);
    expect(globeToSite(map.anchor!, bottomRight).map(Math.round)).toEqual([10, 0]);
  });

  test('a home that has not said where it is: nothing drawn, its rooms still listed', () => {
    const map = homeMapOf({ home: { ...HOME, location: null }, spaces: SPACES, devices: [], occupancy: OCCUPIED, showing: 'ground' });
    expect([map.anchor, map.areas, map.markers, map.drawing]).toEqual([null, [], [], null]);
    expect(map.occupied.map((each) => each.spaceId)).toEqual(['kitchen']);
  });

  test('corners tapped kept in the room’s frame; a device placed by a tap in the drawn room there', () => {
    const anchor = homeMapOf({ home: HOME, spaces: SPACES, devices: [], occupancy: [], showing: 'ground' }).anchor!;
    const map = homeMapOf({ home: HOME, spaces: SPACES, devices: [device('lamp', { spaceId: 'hall', x: 2, y: 1.5 })], occupancy: [], showing: 'ground' });
    const tapped = map.markers[0]!;
    // The tap where the lamp is, as the hall's outline would keep it: 2 m in, from the hall's own origin.
    expect(outlineFrom(anchor, SPACES, 'hall', [[tapped.longitude, tapped.latitude]])).toEqual([[2, 1.5]]);
    expect(placementAt(anchor, SPACES, 'ground', null, [tapped.longitude, tapped.latitude])).toEqual({ spaceId: 'hall', x: 2, y: 1.5 });
    // Where no room is drawn: the space it stands in, if on this floor, else the floor.
    const far = map.areas[0]!.ring[0]!;
    const outside: [number, number] = [far[0] - 0.001, far[1] - 0.001];
    expect(placementAt(anchor, SPACES, 'ground', 'pantry', outside).spaceId).toBe('pantry');
    expect(placementAt(anchor, SPACES, 'ground', 'bedroom', outside).spaceId).toBe('ground');
  });
});
