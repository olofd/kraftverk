import { isSpot, type DeviceDescription, type Reading } from '@kraftverk/device-sdk';
import { anchoredSpot, between, spaceAt, type FramedSpace, type Point } from '@kraftverk/map/frames';

/*
  A person's room (docs/PLAN-WORLD-MODEL.md §8.9), when a signal tells people
  apart: a device they carry that says where it is on its own map of the
  home — a watch a room's beacons hear, a tag a grid of anchors follows —
  anchored by where that device's map is placed. Pure rules, no clock or
  store of their own.

  - The room is the innermost drawn room the spot falls in.
  - A spot older than a couple of minutes says nothing: the stay ends then.
  - In one room at a time: a new room ends the last as it begins.
  - Kept as far as they share: at `places` and above, as a zone is.
*/

/** A spot older than this says nothing of where someone is now. */
const ROOM_STALE_MS = 2 * 60_000;

/** Where what they carry put them: the room, if one, and when. */
export type RoomFix = { deviceId: string; roomId: string | null; at: number };

/** The room stay they have, if one. */
export type OpenRoom = { id: string; spaceId: string; since: number };

export type RoomDecision = { end: { stayId: string; until: number; because: 'left' | 'unshared' } | null; begin: { spaceId: string; since: number; deviceId: string } | null };

/**
 * What changes in which room someone is, from their freshest fix. Warming —
 * just started, what it hears what was kept — a fix gone stale ends nothing.
 */
export function decideRoom(input: { open: OpenRoom | null; fix: RoomFix | null; keeps: boolean; now: number; warming?: boolean }): RoomDecision {
  const { open, keeps, now } = input;
  const fix = input.fix && now - input.fix.at <= ROOM_STALE_MS ? input.fix : null;
  if (!keeps) return { end: open ? { stayId: open.id, until: now, because: 'unshared' } : null, begin: null };
  if (!fix && input.warming) return { end: null, begin: null };
  if (!fix || !fix.roomId) return { end: open ? { stayId: open.id, until: input.fix?.at ?? now, because: 'left' } : null, begin: null };
  if (open?.spaceId === fix.roomId) return { end: null, begin: null };
  return { end: open ? { stayId: open.id, until: fix.at, because: 'left' } : null, begin: { spaceId: fix.roomId, since: fix.at, deviceId: fix.deviceId } };
}

/** How long after starting a stale fix ends no room stay: until what is carried has had its say. */
export const ROOM_WARM_UP_MS = ROOM_STALE_MS;

/** What only holds rooms: never a room itself. */
const CONTAINERS = new Set(['site', 'building', 'floor']);

/** A space as the room rules see it. */
export type RoomSpace = FramedSpace & { kind: string; outline: readonly Point[] | null };

/**
 * The room a device's spot puts it in: the spot anchored where the device is
 * placed, and the innermost drawn room there — on the floor its map is
 * placed on, never a room above or below it; without floors, anywhere on
 * the site.
 */
export function roomOf(spaces: readonly RoomSpace[], placement: { spaceId: string; x: number | null; y: number | null; facing: number | null }, spot: Point): string | null {
  const byId = new Map(spaces.map((space) => [space.id, space]));
  let level = byId.get(placement.spaceId);
  for (let depth = 0; level && level.kind !== 'floor' && level.parentId && depth < 64; depth++) level = byId.get(level.parentId);
  const within = level?.kind === 'floor' ? level : spaces.find((space) => space.parentId === null);
  if (!within) return null;
  const found = spaceAt(spaces, within.id, between(spaces, placement.spaceId, within.id, anchoredSpot(placement, spot)));
  return found && !CONTAINERS.has(found.kind) ? found.id : null;
}

/** A device's spot reading, and when: its first attribute that means one. */
export function spotOf(description: DeviceDescription, readings: readonly Reading[]): { spot: Point; at: number } | null {
  for (const attribute of description.attributes) {
    if (attribute.means !== 'spot') continue;
    const reading = readings.find((each) => each.key === attribute.key);
    if (reading && isSpot(reading.value)) return { spot: [reading.value.x, reading.value.y], at: Date.parse(reading.confirmedAt && reading.confirmedAt > reading.at ? reading.confirmedAt : reading.at) };
  }
  return null;
}
