import type { DeviceView, HomeView, OpeningView, PlacementView, SpaceKind, SpacePurpose, SpaceView } from './types.ts';

/*
  A family's homes and their spaces, as the app shows them
  (docs/PLAN-WORLD-MODEL.md §8.5): each space with the ones it is in, where a
  device stands in words, and a list of devices grouped by the room each
  stands in. Pure: the screens ask, and this says.
*/

/** A home with its spaces — the site first, each after its parent — and its openings. */
export type HomeSpaces = { home: HomeView; spaces: readonly SpaceView[]; openings: readonly OpeningView[] };

export const SPACE_KIND_LABELS: Record<Exclude<SpaceKind, 'site'>, string> = {
  building: 'Building',
  floor: 'Floor',
  room: 'Room',
  area: 'Area',
  stairs: 'Stairs',
  outdoor: 'Outdoors',
};

export const SPACE_PURPOSE_LABELS: Record<SpacePurpose, string> = {
  kitchen: 'Kitchen',
  living: 'Living room',
  dining: 'Dining room',
  bedroom: 'Bedroom',
  children: 'Children’s room',
  guest: 'Guest room',
  bathroom: 'Bathroom',
  toilet: 'Toilet',
  hallway: 'Hallway',
  office: 'Office',
  laundry: 'Laundry',
  storage: 'Storage',
  utility: 'Utility room',
  garage: 'Garage',
  gym: 'Gym',
  sauna: 'Sauna',
  other: 'Something else',
};

/** What may be inside a space of a kind: a building has floors and rooms, a floor rooms, a room areas. An apartment's rooms are the home's own: no building said. */
export const INSIDE: Record<SpaceKind, readonly Exclude<SpaceKind, 'site'>[]> = {
  site: ['room', 'floor', 'building', 'outdoor', 'stairs', 'area'],
  building: ['floor', 'room', 'stairs', 'area'],
  floor: ['room', 'stairs', 'area'],
  room: ['area'],
  area: [],
  stairs: [],
  outdoor: ['area'],
};

/** How deep a space is: 0 for what stands on the site itself. */
export function depthOf(space: SpaceView, spaces: readonly SpaceView[]): number {
  let depth = -1;
  for (let at: SpaceView | undefined = space; at && at.kind !== 'site'; at = spaces.find((each) => each.id === at!.parentId)) depth++;
  return Math.max(depth, 0);
}

/** The spaces a space is in, outermost first, the site left out: ["House", "Ground floor"] for a kitchen. */
export function trailOf(space: SpaceView, spaces: readonly SpaceView[]): string[] {
  const trail: string[] = [];
  for (let at = spaces.find((each) => each.id === space.parentId); at && at.kind !== 'site'; at = spaces.find((each) => each.id === at!.parentId)) trail.unshift(at.name);
  return trail;
}

/** Whether `candidate` is `space` or inside it: where a space may not be moved to. */
export function isWithin(candidate: SpaceView, space: SpaceView, spaces: readonly SpaceView[]): boolean {
  for (let at: SpaceView | undefined = candidate; at; at = spaces.find((each) => each.id === at!.parentId)) if (at.id === space.id) return true;
  return false;
}

/** A space in a line: its kind, or what it is for, and the floor it is on — "Kitchen · Ground floor". */
export function spaceLine(space: SpaceView, spaces: readonly SpaceView[]): string {
  const what = space.kind === 'site' ? 'The home itself' : space.purpose ? SPACE_PURPOSE_LABELS[space.purpose] : SPACE_KIND_LABELS[space.kind];
  return [what, ...trailOf(space, spaces)].filter((part, index, all) => all.indexOf(part) === index).join(' · ');
}

/** An opening in words: "Front door, to the outside", "Kitchen door, to the Hall". */
export function openingLine(opening: OpeningView, spaces: readonly SpaceView[], from?: string): string {
  const nameOf = (id: string | null) => (id === null ? 'the outside' : (spaces.find((space) => space.id === id)?.name ?? 'a space'));
  const other = from === undefined ? null : opening.fromId === from ? opening.toId : opening.fromId;
  const name = opening.name ?? (opening.kind === 'garage-door' ? 'Garage door' : opening.kind[0]!.toUpperCase() + opening.kind.slice(1));
  return from === undefined ? `${name}: ${nameOf(opening.fromId)} to ${nameOf(opening.toId)}` : `${name}, to ${other === null ? 'the outside' : nameOf(other)}`;
}

/** Where a device stands, in words: "Kitchen, Home", "Home" for the site, "At the Front door, Hall, Home". With one home, its name is left out. */
export function placeLine(placement: PlacementView, homes: readonly HomeSpaces[]): string {
  const where = homes.find((each) => each.home.id === placement.homeId);
  if (!where) return 'In a home no longer yours';
  const space = where.spaces.find((each) => each.id === placement.spaceId);
  const opening = placement.openingId ? where.openings.find((each) => each.id === placement.openingId) : undefined;
  const parts = [
    opening ? `At the ${opening.name ?? opening.kind}` : null,
    space && space.kind !== 'site' ? space.name : null,
    homes.length > 1 || !space || space.kind === 'site' ? where.home.name : null,
  ].filter(Boolean);
  return `${placement.role === 'based' ? 'Based: ' : ''}${parts.join(', ')}`;
}

/**
 * The devices a label is on: labelled themselves, or standing in a space that
 * is — or inside one that is: "upstairs" on a floor is on its rooms' lamps.
 */
export function withLabel(devices: readonly DeviceView[], labelId: string, homes: readonly HomeSpaces[], spaceLabels: Readonly<Record<string, readonly string[]>>): DeviceView[] {
  const spaces = homes.flatMap((each) => each.spaces);
  const labelled = (spaceId: string): boolean => {
    for (let at = spaces.find((space) => space.id === spaceId); at; at = spaces.find((space) => space.id === at!.parentId)) if (spaceLabels[at.id]?.includes(labelId)) return true;
    return false;
  };
  return devices.filter((device) => device.labels.includes(labelId) || (device.placement !== null && labelled(device.placement.spaceId)));
}

/** A group of devices on the home screen: those standing in one space, or nowhere said. */
export type RoomGroup = { id: string; title: string | null; subtitle: string | null; devices: DeviceView[] };

/**
 * Devices grouped by where each stands, in the order of the homes and their
 * spaces; then those standing nowhere said. With nothing placed at all, one
 * group without a title: the list as it always was.
 */
export function byRoom(devices: readonly DeviceView[], homes: readonly HomeSpaces[]): RoomGroup[] {
  if (!devices.some((device) => device.placement)) return devices.length ? [{ id: 'all', title: null, subtitle: null, devices: [...devices] }] : [];
  const groups: RoomGroup[] = [];
  for (const { home, spaces } of homes)
    for (const space of spaces) {
      const here = devices.filter((device) => device.placement?.spaceId === space.id);
      if (!here.length) continue;
      // Named by the space it is in — its floor, or its building — not the whole way down: a heading is short.
      const within = trailOf(space, spaces).at(-1);
      groups.push({
        id: space.id,
        title: space.kind === 'site' ? home.name : space.name,
        subtitle: [...(within ? [within] : []), ...(homes.length > 1 && space.kind !== 'site' ? [home.name] : [])].join(' · ') || null,
        devices: here,
      });
    }
  const known = new Set(groups.flatMap((group) => group.devices.map((device) => device.id)));
  const elsewhere = devices.filter((device) => !known.has(device.id));
  if (elsewhere.length) groups.push({ id: 'nowhere', title: 'Not in a room yet', subtitle: null, devices: elsewhere });
  return groups;
}
