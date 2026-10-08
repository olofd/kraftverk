import type { Coordinates } from '@kraftverk/automation';
import type { DeviceHome, PolicyValueName, PolicyValues, SavedDeviceId } from '@kraftverk/device-sdk';
import { HomeSettings, policyValues, setPolicyValue, type HomeRecord, type PlaceStore, type SpaceStore, type SqlDatabase } from '@kraftverk/store';

/*
  A family's homes, as the hub uses them (docs/PLAN-WORLD-MODEL.md §8.4):
  the first made with the family, where each is, and each one's values. A
  device is for the home it stands in — its place, its clock and its values
  are that home's — and, placed nowhere, for the family's first.
*/

/** The time zone where this node runs: what a family's first home keeps until its people say otherwise. */
const localTimeZone = (): string => {
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
/** The home a device is for (`DeviceContext.home`): the one it stands in, or the family's first. */
export const deviceHomeOf =
  (places: PlaceStore, spaces: SpaceStore) =>
  (deviceId: SavedDeviceId | null): DeviceHome | null => {
    const placed = deviceId ? spaces.placement(deviceId) : null;
    const home = (placed ? places.home(placed.homeId) : null) ?? places.first();
    return home ? { name: home.name, location: home.location ? { latitude: home.location.latitude, longitude: home.location.longitude } : null, timeZone: home.timeZone } : null;
  };

export const locationOf =
  (places: PlaceStore) =>
  (homeId: string | null): Coordinates | null => {
    const home = (homeId ? places.home(homeId) : null) ?? places.first();
    return home?.location ? { latitude: home.location.latitude, longitude: home.location.longitude } : null;
  };

/** A home's values — how much is a load, the reserve — read and set within their bounds. */
export const policyOf =
  (db: SqlDatabase) =>
  (homeId: string): { values(): PolicyValues; set(name: PolicyValueName, value: number | null): PolicyValues } => {
    const settings = new HomeSettings(db, homeId);
    return { values: () => policyValues(settings), set: (name, value) => setPolicyValue(settings, name, value) };
  };
