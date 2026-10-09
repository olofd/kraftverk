/*
  How far a home's geometry may go (docs/PLAN-WORLD-MODEL.md §8.5, §8.7):
  the one set of limits the API, a file's reader and an import hold frames,
  outlines, drawings and where a device stands to — pure, each answering
  what is wrong in words, or null. A file the API would refuse is refused
  as it is read, never by the database as it is written.
*/

/** How far from its frame's origin anything of a home is drawn: a kilometre. */
export const REACH_METRES = 1000;
/** The most corners an outline, or points a shape, has. */
export const POINTS_MOST = 200;
/** The longest name a space or an opening has. */
export const NAME_MOST = 60;
/** The most metres a pixel of a floor's drawing is. */
export const PLAN_SCALE_MOST = 1;
/** How high above its floor something stands, at most, and how tall a space is. */
export const HEIGHT_MOST = 100;

const metres = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= REACH_METRES;
/** A turn: any number of degrees — kept as from 0 to below 360 (`turnOf`). */
const degrees = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A turn as it is kept: degrees from 0, below 360 — -90 is 270. */
export const turnOf = (value: number): number => ((value % 360) + 360) % 360;

/** What is wrong with a frame — an origin in metres within reach, a turn in degrees — or null. */
export function frameProblem(frame: { x: number; y: number; turn: number }): string | null {
  return metres(frame.x) && metres(frame.y) && degrees(frame.turn) ? null : `A frame is an origin in metres, within ${REACH_METRES} m, and a turn in degrees`;
}

/** What is wrong with points in a frame — metres within reach, from \`least\` to the most, no two the same in a row — or null. */
export function pointsProblem(points: readonly (readonly number[])[], least: number, what: string): string | null {
  if (points.length < least || points.length > POINTS_MOST) return `${what} has ${least} to ${POINTS_MOST} points`;
  if (!points.every((point) => point.length === 2 && metres(point[0]) && metres(point[1]))) return `${what}'s points are metres in its frame, within ${REACH_METRES} m`;
  if (points.some((point, at) => at > 0 && point[0] === points[at - 1]![0] && point[1] === points[at - 1]![1])) return `${what} has the same point twice in a row`;
  return null;
}

/** What is wrong with where a floor's drawing lies — its corner in metres, a turn, the metres a pixel is — or null. */
export function planProblem(plan: { scale: number; x: number; y: number; turn: number }): string | null {
  return plan.scale > 0 && plan.scale <= PLAN_SCALE_MOST && metres(plan.x) && metres(plan.y) && degrees(plan.turn) ? null : `A drawing is placed by its corner, in metres, a turn in degrees, and the metres a pixel is: above 0, at most ${PLAN_SCALE_MOST}`;
}

/** What is wrong with where in a space something stands — metres within reach, a height above its floor, a facing — or null. */
export function standingProblem(at: { x: number | null; y: number | null; z: number | null; facing: number | null }): string | null {
  if ((at.x !== null && !metres(at.x)) || (at.y !== null && !metres(at.y))) return `Where it stands is metres in its space, within ${REACH_METRES} m`;
  if (at.z !== null && !(Number.isFinite(at.z) && at.z >= 0 && at.z <= HEIGHT_MOST)) return `How high it stands is metres above its floor, from 0 to ${HEIGHT_MOST}`;
  if (at.facing !== null && !degrees(at.facing)) return 'Which way it faces is degrees';
  return null;
}

/** What is wrong with a space's or an opening's name, or a space's height — or null. */
export function nameProblem(name: string, what: string): string | null {
  return name.trim().length >= 1 && name.trim().length <= NAME_MOST ? null : `${what}’s name is 1 to ${NAME_MOST} characters`;
}

export function heightProblem(height: number): string | null {
  return Number.isFinite(height) && height > 0 && height <= HEIGHT_MOST ? null : `A height is metres, above 0, at most ${HEIGHT_MOST}`;
}
