/*
  Whether a space has someone in it (docs/PLAN-WORLD-MODEL.md §8.9), whoever
  they are: pure rules over what stands there, no clock or store of their own.

  - A radar that says someone is there: occupied while it says so.
  - Motion: occupied while a sensor sees it, and for a while after it last
    did — after it turned to "nobody moves", or after it went quiet still
    saying someone moves — unless a radar in the same space says now that
    nobody is.
  - A count above nought: occupied, and the count is the peak.
  - A closed room: when every way in is a door whose contact says it is
    shut, motion that began after the last of them shut means someone is
    still inside — occupied until a door opens ("a wasp in a box").
  - A person in a room, by a signal that tells people apart: occupied —
    by nobody's device: who it was is theirs, not the room's.
  - A floor, a building and the site are occupied while a space within them
    is, by what said so there; how many, as a counter at that level says, or
    the spaces within added up.

  Times are when a value changed, never when a device last spoke: a sensor
  that reports its battery while saying "nobody moves" does not start its
  hold again. What a sensor last said, gone quiet, says nothing — but motion.
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
  /** Whether that is still so: its device still says it. */
  current: boolean;
  /** When it took the value it has: null when that was not seen, and is not kept. */
  since: number | null;
  /** When it last said anything at all. */
  heard: number;
  /** When it last turned true in the space it stands in now: null, not known. What a closed room is judged by. */
  roseAt: number | null;
};

export type SpaceNode = { id: string; parentId: string | null };
export type OpeningNode = { id: string; fromId: string; toId: string | null; kind: string };
/** Someone in a room, by a signal that tells people apart. */
export type RoomStay = { spaceId: string };

/** A space with someone in it: what said so, and how many when counted. */
export type Occupied = { spaceId: string; devices: string[]; peak: number | null };

/** The ways in a room is closed by: one whose contact says it is shut is shut. An archway, the stairs, a lift cannot be. */
const CLOSABLE = new Set(['door', 'gate', 'garage-door']);
/** What a person cannot pass: not a way in. */
const NOT_A_WAY_IN = new Set(['window']);

/**
 * The spaces with someone in them now, each with its evidence — those with a
 * sensor of their own, then everything they are within — and when the
 * answer next changes on the clock alone, a hold running out: null, never.
 */
export function occupancy(input: { spaces: readonly SpaceNode[]; openings: readonly OpeningNode[]; sensors: readonly SensorState[]; stays: readonly RoomStay[]; now: number }): { occupied: Map<string, Occupied>; next: number | null } {
  const { spaces, openings, sensors, stays, now } = input;
  let next: number | null = null;
  const until = (at: number) => (next = next === null ? at : Math.min(next, at));
  const direct = new Map<string, { devices: string[]; occupied: boolean; counted: number | null }>();
  for (const space of spaces) {
    const here = sensors.filter((sensor) => sensor.spaceId === space.id && sensor.sense !== 'open');
    const devices: string[] = [];
    const radars = here.filter((sensor) => sensor.sense === 'occupied' && sensor.current);
    for (const radar of radars) if (radar.value === true) devices.push(radar.deviceId);
    for (const sensor of here.filter((each) => each.sense === 'motion')) {
      if (sensor.current && sensor.value === true) {
        devices.push(sensor.deviceId);
        continue;
      }
      // A radar here says now whether anyone is: no hold beside it.
      if (radars.length) continue;
      // Quiet for less than the hold: since it turned to nobody, or since it last said anyone, gone quiet.
      const from = sensor.value === false ? sensor.since : sensor.value === true ? sensor.heard : null;
      if (from !== null && now - from < MOTION_HOLD_MS) {
        devices.push(sensor.deviceId);
        until(from + MOTION_HOLD_MS);
      }
    }
    const counters = here.filter((sensor) => sensor.sense === 'people' && sensor.current && typeof sensor.value === 'number');
    const counted = counters.length ? Math.max(...counters.map((counter) => counter.value as number)) : null;
    for (const counter of counters) if ((counter.value as number) > 0) devices.push(counter.deviceId);
    const sealed = closedWithSomeoneIn(space.id, openings, sensors);
    if (sealed) devices.push(...sealed);
    const someone = stays.some((stay) => stay.spaceId === space.id);
    if (devices.length || someone || counted !== null) direct.set(space.id, { devices: [...new Set(devices)], occupied: devices.length > 0 || someone, counted });
  }

  // Everything a space with someone in it is within, from the innermost out.
  const children = new Map<string, string[]>();
  for (const space of spaces) if (space.parentId) children.set(space.parentId, [...(children.get(space.parentId) ?? []), space.id]);
  const all = new Map<string, Occupied>();
  const walk = (id: string, depth: number): { devices: string[]; occupied: boolean; peak: number | null } => {
    const own = direct.get(id);
    const within = depth < 64 ? (children.get(id) ?? []).map((child) => walk(child, depth + 1)) : [];
    const devices = [...new Set([...(own?.devices ?? []), ...within.flatMap((each) => each.devices)])].sort();
    const occupied = Boolean(own?.occupied) || within.some((each) => each.occupied);
    // A counter here counts everyone here, those in its spaces too; without one, theirs added up.
    const peaks = within.map((each) => each.peak).filter((peak): peak is number => peak !== null);
    const peak = own?.counted ?? (peaks.length ? peaks.reduce((sum, each) => sum + each, 0) : null);
    if (occupied) all.set(id, { spaceId: id, devices, peak: peak && peak > 0 ? peak : null });
    return { devices, occupied, peak };
  };
  for (const space of spaces) if (!space.parentId || !spaces.some((each) => each.id === space.parentId)) walk(space.id, 0);
  return { occupied: all, next };
}

/**
 * The devices that say someone is shut in a room — its contacts and what
 * moved after they shut — or null. Every way in must be a door with a
 * contact that says now that it is shut, and when it shut must be known.
 */
function closedWithSomeoneIn(spaceId: string, openings: readonly OpeningNode[], sensors: readonly SensorState[]): string[] | null {
  const ways = openings.filter((opening) => (opening.fromId === spaceId || opening.toId === spaceId) && !NOT_A_WAY_IN.has(opening.kind));
  if (!ways.length || ways.some((way) => !CLOSABLE.has(way.kind))) return null;
  const contacts: SensorState[] = [];
  for (const way of ways) {
    const watching = sensors.filter((sensor) => sensor.sense === 'open' && sensor.openingId === way.id);
    // Not watched, not said, open, or shut when nobody saw: the room is not closed.
    if (!watching.length || watching.some((sensor) => !sensor.current || sensor.value !== false || sensor.since === null)) return null;
    contacts.push(...watching);
  }
  const shutAt = Math.max(...contacts.map((contact) => contact.since!));
  const moved = sensors.filter((sensor) => sensor.spaceId === spaceId && (sensor.sense === 'motion' || sensor.sense === 'occupied') && sensor.roseAt !== null && sensor.roseAt > shutAt);
  return moved.length ? [...moved.map((sensor) => sensor.deviceId), ...contacts.map((contact) => contact.deviceId)] : null;
}
