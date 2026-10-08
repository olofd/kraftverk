import type { Coordinates } from '@kraftverk/automation';
import { HOME_RADIUS, type HomeRecord, type PlaceStore } from '@kraftverk/store';

/*
  A family's homes, as the hub uses them (docs/PLAN-WORLD-MODEL.md §8.4):
  the first made with the family, where each is, and — until devices stand
  in homes (PLAN-WORLD-MODEL-WORK.md, W2) — the first one as the family's own
  place, policy and clock.
*/

/** The time zone where this node runs: what a family's first home keeps until its people say otherwise. */
export const localTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** The family's first home, made with the family: it has a home from the start, its clock this node's. */
export function ensureFirstHome(places: PlaceStore, timeZone = localTimeZone()): HomeRecord {
  return places.first() ?? places.homes({ removed: true })[0] ?? places.addHome({ name: 'Home', type: 'house', timeZone });
}

/** Where a home is — the one named, or the family's first — as a rule's "home" and the sun's times want it. Null: not said. */
export const locationOf =
  (places: PlaceStore) =>
  (homeId: string | null): Coordinates | null => {
    const home = (homeId ? places.home(homeId) : null) ?? places.first();
    return home?.location ? { latitude: home.location.latitude, longitude: home.location.longitude } : null;
  };

/** The family's first home's place, read and said: what the configuration file's \`home.location\` is until it names homes. */
export const firstHomeLocation = (places: PlaceStore) => ({
  get: (): Coordinates | null => locationOf(places)(null),
  set: (location: Coordinates | null): void => {
    const first = places.first();
    if (first) places.updateHome(first.id, { location: location ? { ...location, radius: first.location?.radius ?? HOME_RADIUS } : null });
  },
});
