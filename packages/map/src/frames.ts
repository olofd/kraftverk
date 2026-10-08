import type { LngLat } from './shapes.ts';

/*
  Frames (docs/PLAN-WORLD-MODEL.md §8.7): coordinates within a home are
  metres in a frame. The site's frame is anchored to the Earth by the home's
  place — its origin — and its bearing, which way its y axis points. Any
  space may have a frame of its own, an origin and a turn within its
  parent's; one without uses its parent's. So any point in any space is
  turned into any other frame, or onto the Earth, by walking up the tree.

  Turns are degrees clockwise, as a compass's are: x is east and y north
  when nothing is turned. Over a home's few hundred metres the Earth is flat
  enough: a metre north is a metre north wherever in the home it is.
*/

/** A point in a frame: metres along its x axis and its y axis. */
export type Point = readonly [x: number, y: number];

/** Where a frame's origin is in its parent's, and how far it is turned from it. */
export type Frame = { x: number; y: number; turn: number };

/** A space as a frame sees it: its parent, and its own frame, if it has one. */
export type FramedSpace = { id: string; parentId: string | null; frame: Frame | null };

/** What anchors a home's site to the Earth: its place, and which way its y axis points. */
export type Anchor = { latitude: number; longitude: number; bearing: number };

const EARTH = 6_371_008.8;
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** A point turned clockwise about the origin. */
export function turned([x, y]: Point, degrees: number): Point {
  if (!degrees) return [x, y];
  const t = rad(degrees);
  return [x * Math.cos(t) + y * Math.sin(t), -x * Math.sin(t) + y * Math.cos(t)];
}

/** A point in a frame, in its parent's. */
export const intoParent = (frame: Frame | null, point: Point): Point => {
  if (!frame) return point;
  const [x, y] = turned(point, frame.turn);
  return [x + frame.x, y + frame.y];
};

/** A point in a parent's frame, in the child's. */
export const outOfParent = (frame: Frame | null, point: Point): Point => (frame ? turned([point[0] - frame.x, point[1] - frame.y], -frame.turn) : point);

/** The spaces from one up to its site, itself first. A space not among them has none. */
function chainOf(spaces: readonly FramedSpace[], spaceId: string): FramedSpace[] {
  const byId = new Map(spaces.map((space) => [space.id, space]));
  const chain: FramedSpace[] = [];
  for (let at = byId.get(spaceId); at && chain.length < 64; at = at.parentId ? byId.get(at.parentId) : undefined) chain.push(at);
  return chain;
}

/** A point in a space's frame, in its site's. */
export const toSite = (spaces: readonly FramedSpace[], spaceId: string, point: Point): Point => chainOf(spaces, spaceId).reduce((at, space) => intoParent(space.frame, at), point);

/** A point in the site's frame, in a space's. */
export const fromSite = (spaces: readonly FramedSpace[], spaceId: string, point: Point): Point =>
  chainOf(spaces, spaceId)
    .reverse()
    .reduce((at, space) => outOfParent(space.frame, at), point);

/** A point in one space's frame, in another's of the same home. */
export const between = (spaces: readonly FramedSpace[], from: string, to: string, point: Point): Point => fromSite(spaces, to, toSite(spaces, from, point));

/** A point in the site's frame, on the Earth: longitude, then latitude, as GeoJSON has it. */
export function siteToGlobe(anchor: Anchor, point: Point): LngLat {
  // The site's y axis points at its bearing: so far east, so far north.
  const [east, north] = turned(point, anchor.bearing);
  const latitude = anchor.latitude + deg(north / EARTH);
  const longitude = anchor.longitude + deg(east / (EARTH * Math.cos(rad(anchor.latitude))));
  return [longitude, latitude];
}

/** A place on the Earth, in the site's frame. */
export function globeToSite(anchor: Anchor, [longitude, latitude]: LngLat): Point {
  const north = rad(latitude - anchor.latitude) * EARTH;
  const east = rad(longitude - anchor.longitude) * EARTH * Math.cos(rad(anchor.latitude));
  return turned([east, north], -anchor.bearing);
}

/** A point in a space's frame, on the Earth. */
export const toGlobe = (anchor: Anchor, spaces: readonly FramedSpace[], spaceId: string, point: Point): LngLat => siteToGlobe(anchor, toSite(spaces, spaceId, point));

/** A place on the Earth, in a space's frame. */
export const fromGlobe = (anchor: Anchor, spaces: readonly FramedSpace[], spaceId: string, place: LngLat): Point => fromSite(spaces, spaceId, globeToSite(anchor, place));

/**
 * Where a device's own map puts something — a robot cleaner, a watch a
 * room's beacons hear — in the frame of the space the device is placed in:
 * its map's origin at the placement's x and y, its y axis turned by its
 * facing. Placed with no coordinates: its map's origin is the space's.
 */
export const anchoredSpot = (placement: { x: number | null; y: number | null; facing: number | null }, spot: Point): Point =>
  intoParent({ x: placement.x ?? 0, y: placement.y ?? 0, turn: placement.facing ?? 0 }, spot);

/** A space's outline on the Earth, its ring closed; none when it is not drawn. */
export function outlineOnGlobe(anchor: Anchor, spaces: readonly FramedSpace[], space: FramedSpace & { outline: readonly Point[] | null }): LngLat[] | null {
  if (!space.outline || space.outline.length < 3) return null;
  const ring = space.outline.map((point) => toGlobe(anchor, spaces, space.id, point));
  return [...ring, ring[0]!];
}

/** A floor's drawing as it is placed. */
export type PlacedDrawing = { scale: number; x: number; y: number; turn: number; width: number; height: number };

/**
 * A floor's drawing on the Earth: its corners top-left, top-right,
 * bottom-right, bottom-left — what an image laid on a map is given. Its
 * pixels run right along x and down against y, turned about its top-left
 * corner.
 */
export function drawingCorners(anchor: Anchor, spaces: readonly FramedSpace[], floorId: string, plan: PlacedDrawing): [LngLat, LngLat, LngLat, LngLat] {
  const across = plan.width * plan.scale;
  const down = plan.height * plan.scale;
  const corner = (point: Point) => {
    const [x, y] = turned(point, plan.turn);
    return toGlobe(anchor, spaces, floorId, [x + plan.x, y + plan.y]);
  };
  return [corner([0, 0]), corner([across, 0]), corner([across, -down]), corner([0, -down])];
}

/** Whether a point is inside a polygon's corners — on its edge counts as in. */
export function inside([x, y]: Point, corners: readonly Point[]): boolean {
  let within = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [xi, yi] = corners[i]!;
    const [xj, yj] = corners[j]!;
    // On the edge between j and i.
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-9 && x >= Math.min(xi, xj) - 1e-9 && x <= Math.max(xi, xj) + 1e-9 && y >= Math.min(yi, yj) - 1e-9 && y <= Math.max(yi, yj) + 1e-9) return true;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
  }
  return within;
}

/**
 * The drawn space a point is in — a point in one space's frame, looked for
 * among the spaces within that space (and it): the innermost whose outline
 * holds it, a room before the floor it is on. None: no drawn space holds it.
 */
export function spaceAt<S extends FramedSpace & { outline: readonly Point[] | null }>(spaces: readonly S[], frameOf: string, point: Point): S | null {
  const depth = (id: string) => chainOf(spaces, id).length;
  const holding = spaces.filter((space) => space.outline && space.outline.length >= 3 && chainOf(spaces, space.id).some((each) => each.id === frameOf) && inside(between(spaces, frameOf, space.id, point), space.outline));
  return holding.sort((a, b) => depth(b.id) - depth(a.id))[0] ?? null;
}
