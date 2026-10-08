import type { DeviceView, HomeView, OccupancyView, SpaceView } from '@kraftverk/api-contract';
import type { LngLat, MapArea, MapMarker } from '@kraftverk/map';
// The frames alone: the map's style, and its basemap, are not bundled with a screen that only places things.
import { anchoredSpot, drawingCorners, fromGlobe, outlineOnGlobe, spaceAt, toGlobe, type Anchor, type Point } from '@kraftverk/map/frames';
import { isSpot } from '@kraftverk/device-sdk';

/*
  A home's map, as a screen draws it (docs/PLAN-WORLD-MODEL.md §8.5, §8.7):
  one floor at a time — or the whole home, where it has no floors — its
  rooms as drawn, filled while someone is in them; its drawing beneath;
  what stands at coordinates, where it stands. All in the home's frame,
  onto the Earth by its place and bearing (`@kraftverk/map`'s frames).
*/

/** What anchors a home's frames to the Earth: none until its people say where it is. */
export const anchorOf = (home: Pick<HomeView, 'location' | 'bearing'>): Anchor | null => (home.location ? { latitude: home.location.latitude, longitude: home.location.longitude, bearing: home.bearing } : null);

/** The spaces from one down: it, and everything within it. */
export function spacesWithin(spaces: readonly SpaceView[], rootId: string): SpaceView[] {
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const space of spaces) if (space.parentId && ids.has(space.parentId) && !ids.has(space.id)) (ids.add(space.id), (grew = true));
  }
  return spaces.filter((space) => ids.has(space.id));
}

/** What a map is shown by: each floor, lowest first — or the home itself, where it has none. */
export function mapLevels(spaces: readonly SpaceView[]): SpaceView[] {
  const floors = spaces.filter((space) => space.kind === 'floor').sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  const site = spaces.find((space) => space.kind === 'site');
  return floors.length ? floors : site ? [site] : [];
}

/** A space with someone in it, as a list says it: its name, since when, and what said so. */
export type OccupiedRoom = { spaceId: string; name: string; since: string; peak: number | null; by: string[] };

export type HomeMap = {
  anchor: Anchor | null;
  areas: MapArea[];
  markers: MapMarker[];
  /** The floor's drawing: its picture, and its corners on the Earth. */
  drawing: { pictureId: string; corners: [LngLat, LngLat, LngLat, LngLat] } | null;
  /** The rooms shown with someone in them — not the floor or the home they are on. */
  occupied: OccupiedRoom[];
  /** The rooms shown that are drawn, and those not yet. */
  drawn: SpaceView[];
  undrawn: SpaceView[];
};

/** Containers: occupied while something within is — said by their rooms, not themselves. */
const CONTAINERS = new Set(['site', 'building', 'floor']);

/** One level of a home, as its map shows it. */
export function homeMapOf(input: { home: HomeView; spaces: readonly SpaceView[]; devices: readonly DeviceView[]; occupancy: readonly OccupancyView[]; showing: string }): HomeMap {
  const { home, spaces, devices, occupancy, showing } = input;
  const anchor = anchorOf(home);
  const shown = spacesWithin(spaces, showing);
  const shownIds = new Set(shown.map((space) => space.id));
  const occupiedIds = new Map(occupancy.map((each) => [each.spaceId, each]));
  const rooms = shown.filter((space) => !CONTAINERS.has(space.kind));
  const names = new Map(devices.map((device) => [device.id as string, device.name]));
  const level = spaces.find((space) => space.id === showing);
  if (!anchor) return { anchor, areas: [], markers: [], drawing: null, occupied: occupiedOf(rooms, occupiedIds, names), drawn: [], undrawn: rooms };
  const areas = shown.flatMap((space): MapArea[] => {
    const ring = space.id === showing && space.kind !== 'room' ? null : outlineOnGlobe(anchor, spaces, space);
    return ring ? [{ id: space.id, ring, label: CONTAINERS.has(space.kind) ? '' : space.name, filled: occupiedIds.has(space.id) && !CONTAINERS.has(space.kind) }] : [];
  });
  const markers = devices.flatMap((device): MapMarker[] => {
    const placed = device.placement;
    if (!placed || !shownIds.has(placed.spaceId)) return [];
    // One that says where it is on its own map — a robot cleaner — is drawn there; its map anchored where it is placed.
    const spot = spotOf(device);
    if (spot) {
      const [longitude, latitude] = toGlobe(anchor, spaces, placed.spaceId, anchoredSpot(placed, [spot.x, spot.y]));
      return [{ id: device.id, latitude, longitude, accuracy: spot.accuracy ?? null, label: device.name }];
    }
    if (placed.x === null || placed.y === null) return [];
    const [longitude, latitude] = toGlobe(anchor, spaces, placed.spaceId, [placed.x, placed.y]);
    return [{ id: device.id, latitude, longitude, label: device.name }];
  });
  const drawing = level?.plan ? { pictureId: level.plan.pictureId, corners: drawingCorners(anchor, spaces, level.id, level.plan) } : null;
  return { anchor, areas, markers, drawing, occupied: occupiedOf(rooms, occupiedIds, names), drawn: rooms.filter((space) => space.outline), undrawn: rooms.filter((space) => !space.outline) };
}

/** Where a device says it is on its own map, if it does. */
function spotOf(device: DeviceView): { x: number; y: number; accuracy?: number | null } | null {
  const attribute = device.description.attributes.find((each) => each.means === 'spot');
  const value = attribute ? device.readings.find((reading) => reading.key === attribute.key)?.value : undefined;
  return isSpot(value) ? value : null;
}

function occupiedOf(rooms: readonly SpaceView[], occupied: ReadonlyMap<string, OccupancyView>, names: ReadonlyMap<string, string>): OccupiedRoom[] {
  return rooms.flatMap((room) => {
    const found = occupied.get(room.id);
    return found ? [{ spaceId: room.id, name: room.name, since: found.since, peak: found.peak, by: found.devices.map((id) => names.get(id) ?? 'a device') }] : [];
  });
}

/** Corners tapped on the map, as a space's outline: metres in its own frame. */
export const outlineFrom = (anchor: Anchor, spaces: readonly SpaceView[], spaceId: string, corners: readonly LngLat[]): [number, number][] =>
  corners.map((corner) => {
    const [x, y] = fromGlobe(anchor, spaces, spaceId, corner);
    return [round(x), round(y)];
  });

/**
 * Where a tap on a level's map places a device: the innermost drawn room
 * there, or — none drawn there — the space it stands in now, else the
 * level itself; and the point in that space's frame.
 */
export function placementAt(anchor: Anchor, spaces: readonly SpaceView[], level: string, standsIn: string | null, place: LngLat): { spaceId: string; x: number; y: number } {
  const onLevel = fromGlobe(anchor, spaces, level, place);
  const room = spaceAt(spacesWithin(spaces, level), level, onLevel);
  const spaceId = room?.id ?? (standsIn && spacesWithin(spaces, level).some((space) => space.id === standsIn) ? standsIn : level);
  const [x, y]: Point = fromGlobe(anchor, spaces, spaceId, place);
  return { spaceId, x: round(x), y: round(y) };
}

/** Centimetres: what a tap is good to. */
const round = (metres: number) => Math.round(metres * 100) / 100;
