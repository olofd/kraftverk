/*
  Whether a space has someone in it (docs/PLAN-WORLD-MODEL.md §8.9), whoever
  they are: pure rules over what stands there, no clock or store of their own.

  - A radar that says someone is there: occupied while it says so.
  - Motion: occupied while a sensor sees it, and for a while after — unless
    a radar in the same space says now that nobody is.
  - A count above nought: occupied, and the count is the peak.
  - A closed room: when every way in is a door whose contact says it is
    shut, motion that began after the last of them shut means someone is
    still inside — occupied until a door opens ("a wasp in a box").
  - A person's room stay — a signal that tells people apart — occupies its
    room.
  - A floor, a building and the site are occupied while a space within them
    is, by what said so there.

  A reading that is not current — a sensor gone quiet — says nothing, except
  a motion sensor's last "nobody moves", which the hold is counted from.
*/

/** How long a space stays occupied after its motion sensors last saw anyone, with no radar there to say otherwise. */
export const MOTION_HOLD_MS = 5 * 60_000;

/** What a sensor senses: someone moving, someone there, a door open, how many. */
export type Sense = 'motion' | 'occupied' | 'open' | 'people';

/** One sensor's reading as the rules take it. */
export type SensorState = {
  deviceId: string;
  sense: Sense;
  /** The space it stands in, and the opening it is at, if one. */
  spaceId: string;
  openingId: string | null;
  value: boolean | number | null;
  /** When it said its value. */
  at: number;
  /** Whether that is still so: its device still says it. */
  current: boolean;
  /** When it last turned true, as kept: what a closed room is judged by. Null: not known. */
  roseAt: number | null;
};

export type SpaceNode = { id: string; parentId: string | null };
export type OpeningNode = { id: string; fromId: string; toId: string | null; kind: string };
/** Someone in a room, by a signal that tells people apart: the device that said so, if one. */
export type RoomStay = { spaceId: string; deviceId: string | null };

/** A space with someone in it: what said so, and how many when counted. */
export type Occupied = { spaceId: string; devices: string[]; peak: number | null };

/** The ways in a room is closed by: one whose contact says it is shut is shut. An archway, the stairs, a lift cannot be. */
const CLOSABLE = new Set(['door', 'gate', 'garage-door']);
/** What a person cannot pass: not a way in. */
const NOT_A_WAY_IN = new Set(['window']);

/** The spaces with someone in them now, each with its evidence: those with a sensor of their own, then everything they are within. */
export function occupancy(input: { spaces: readonly SpaceNode[]; openings: readonly OpeningNode[]; sensors: readonly SensorState[]; stays: readonly RoomStay[]; now: number }): Map<string, Occupied> {
  const { spaces, openings, sensors, stays, now } = input;
  const direct = new Map<string, Occupied>();
  for (const space of spaces) {
    const here = sensors.filter((sensor) => sensor.spaceId === space.id && sensor.sense !== 'open');
    const devices: string[] = [];
    let peak: number | null = null;
    const radars = here.filter((sensor) => sensor.sense === 'occupied' && sensor.current);
    for (const radar of radars) if (radar.value === true) devices.push(radar.deviceId);
    const motion = here.filter((sensor) => sensor.sense === 'motion');
    for (const sensor of motion) {
      if (sensor.current && sensor.value === true) devices.push(sensor.deviceId);
      // Quiet for less than the hold, and no radar here to say nobody is.
      else if (sensor.value === false && !radars.length && now - sensor.at < MOTION_HOLD_MS) devices.push(sensor.deviceId);
    }
    for (const counter of here.filter((sensor) => sensor.sense === 'people' && sensor.current && typeof sensor.value === 'number' && sensor.value > 0)) {
      devices.push(counter.deviceId);
      peak = Math.max(peak ?? 0, counter.value as number);
    }
    const sealed = closedWithSomeoneIn(space.id, openings, sensors);
    if (sealed) devices.push(...sealed);
    const inRoom = stays.filter((stay) => stay.spaceId === space.id);
    for (const stay of inRoom) if (stay.deviceId) devices.push(stay.deviceId);
    if (devices.length || inRoom.length) direct.set(space.id, { spaceId: space.id, devices: [...new Set(devices)], peak });
  }

  // Everything a space with someone in it is within.
  const byId = new Map(spaces.map((space) => [space.id, space]));
  const all = new Map<string, Occupied>();
  for (const found of direct.values()) {
    for (let at = byId.get(found.spaceId), depth = 0; at && depth < 64; at = at.parentId ? byId.get(at.parentId) : undefined, depth++) {
      const had = all.get(at.id);
      all.set(at.id, had ? { spaceId: at.id, devices: [...new Set([...had.devices, ...found.devices])].sort(), peak: sum(had.peak, found.peak) } : { spaceId: at.id, devices: [...found.devices].sort(), peak: found.peak });
    }
  }
  return all;
}

const sum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/**
 * The devices that say someone is shut in a room — its contacts and what
 * moved after they shut — or null. Every way in must be a door with a
 * contact that says now that it is shut.
 */
function closedWithSomeoneIn(spaceId: string, openings: readonly OpeningNode[], sensors: readonly SensorState[]): string[] | null {
  const ways = openings.filter((opening) => (opening.fromId === spaceId || opening.toId === spaceId) && !NOT_A_WAY_IN.has(opening.kind));
  if (!ways.length || ways.some((way) => !CLOSABLE.has(way.kind))) return null;
  const contacts: SensorState[] = [];
  for (const way of ways) {
    const watching = sensors.filter((sensor) => sensor.sense === 'open' && sensor.openingId === way.id);
    // Not watched, not said, or open: the room is not closed.
    if (!watching.length || watching.some((sensor) => !sensor.current || sensor.value !== false)) return null;
    contacts.push(...watching);
  }
  const shutAt = Math.max(...contacts.map((contact) => contact.at));
  const moved = sensors.filter((sensor) => sensor.spaceId === spaceId && (sensor.sense === 'motion' || sensor.sense === 'occupied') && sensor.roseAt !== null && sensor.roseAt > shutAt);
  return moved.length ? [...moved.map((sensor) => sensor.deviceId), ...contacts.map((contact) => contact.deviceId)] : null;
}
