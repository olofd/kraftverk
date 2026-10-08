import { describe, expect, test } from 'bun:test';

import type { DeviceView, HomeView, OpeningView, PlacementView, SpaceView } from '@kraftverk/api-contract';

import { byRoom, depthOf, isWithin, openingLine, placeLine, spaceLine, trailOf, withLabel, type HomeSpaces } from './spaces.ts';

const space = (id: string, parentId: string | null, kind: SpaceView['kind'], name: string, purpose: SpaceView['purpose'] = null): SpaceView => ({
  id,
  homeId: 'h-1',
  parentId,
  key: id,
  kind,
  purpose,
  name,
  icon: null,
  pictureId: null,
  position: 0,
  level: kind === 'floor' ? 0 : null,
  elevation: null,
  height: null,
  frame: null,
  outline: null,
  plan: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  removedAt: null,
});

const SPACES = [space('site', null, 'site', 'The site'), space('house', 'site', 'building', 'House'), space('ground', 'house', 'floor', 'Ground floor'), space('kitchen', 'ground', 'room', 'Kitchen', 'kitchen'), space('hall', 'ground', 'room', 'Hall', 'hallway')];
const DOOR: OpeningView = { id: 'o-1', homeId: 'h-1', key: 'front-door', fromId: 'hall', toId: null, kind: 'door', name: 'Front door', shape: null, removedAt: null };
const HOME = { id: 'h-1', name: 'Home' } as HomeView;
const HOMES: HomeSpaces[] = [{ home: HOME, spaces: SPACES, openings: [DOOR] }];
const at = (spaceId: string, more: Partial<PlacementView> = {}): PlacementView => ({ part: 'main', homeId: 'h-1', spaceId, openingId: null, x: null, y: null, z: null, facing: null, role: 'stands', since: '2026-10-08T00:00:00.000Z', until: null, ...more });
const device = (id: string, placement: PlacementView | null) => ({ id, name: id, placement }) as unknown as DeviceView;
const kitchen = SPACES[3]!;

describe('a home’s spaces, as the app says them', () => {
  test('each with the ones it is in, how deep, and what it may not move into', () => {
    expect(trailOf(kitchen, SPACES)).toEqual(['House', 'Ground floor']);
    expect(depthOf(kitchen, SPACES)).toBe(2);
    expect(depthOf(SPACES[1]!, SPACES)).toBe(0);
    expect(spaceLine(kitchen, SPACES)).toBe('Kitchen · House · Ground floor');
    expect(isWithin(kitchen, SPACES[1]!, SPACES)).toBe(true);
    expect(isWithin(SPACES[1]!, kitchen, SPACES)).toBe(false);
    expect(openingLine(DOOR, SPACES)).toBe('Front door: Hall to the outside');
    expect(openingLine(DOOR, SPACES, 'hall')).toBe('Front door, to the outside');
  });

  test('where a device stands, in words: the home named only where it is needed', () => {
    expect(placeLine(at('kitchen'), HOMES)).toBe('Kitchen');
    expect(placeLine(at('site'), HOMES)).toBe('Home');
    expect(placeLine(at('hall', { openingId: 'o-1' }), HOMES)).toBe('At the Front door, Hall');
    expect(placeLine(at('kitchen', { role: 'based' }), [...HOMES, { home: { id: 'h-2', name: 'Cabin' } as HomeView, spaces: [], openings: [] }])).toBe('Based: Kitchen, Home');
  });

  test('devices grouped by the room each stands in, in the home’s order; the rest after', () => {
    expect(byRoom([device('a', null), device('b', null)], HOMES)).toEqual([{ id: 'all', title: null, subtitle: null, devices: [device('a', null), device('b', null)] }]);
    const groups = byRoom([device('lamp', at('hall')), device('plug', at('kitchen')), device('car', at('site')), device('loose', null)], HOMES);
    // A label on the floor is on what stands in its rooms; one on a device is on that device.
    const labelled = (id: string, placement: PlacementView | null, labels: string[]) => ({ ...device(id, placement), labels }) as DeviceView;
    const all = [labelled('lamp', at('hall'), []), labelled('heater', null, ['l-heat']), labelled('car', at('site'), [])];
    expect(withLabel(all, 'l-up', HOMES, { ground: ['l-up'] }).map((each): string => each.id)).toEqual(['lamp']);
    expect(withLabel(all, 'l-heat', HOMES, {}).map((each): string => each.id)).toEqual(['heater']);
    expect(groups.map((group) => [group.title, group.subtitle, group.devices.map((each): string => each.id)])).toEqual([
      ['Home', null, ['car']],
      ['Kitchen', 'Ground floor', ['plug']],
      ['Hall', 'Ground floor', ['lamp']],
      ['Not in a room yet', null, ['loose']],
    ]);
  });
});
