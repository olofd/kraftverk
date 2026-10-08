import { COUNTRIES, type Country } from './countries.ts';
import type { Bounds } from './shapes.ts';

/*
  The map a home holds, by region: the world, roughly, always — and the
  detail of a country, or of the area around a place, where it is wanted
  (docs/PLAN-MAPS.md). What a region is, as plain data the server keeps and
  the app shows.
*/

/** How close the world goes: enough to see a country, small enough for every home (about 45 MB). */
export const WORLD_ZOOM = 6;

/** What a region is asked for as: a country by its code, or the area around a place. */
export type RegionAsk = { country: string } | { around: { latitude: number; longitude: number; km: number; name: string } };

/** A region, as asked for: its id, its name, and its box. */
export type RegionSpec = { id: string; name: string; box: Bounds };

/** A country, by its code. */
export const countryOf = (code: string): Country | null => COUNTRIES.find((country) => country.code === code.toLowerCase()) ?? null;

/** The country a place is in — the one whose box holds it and is smallest — for offering the home's own. */
export function countryAt(latitude: number, longitude: number): Country | null {
  const holding = COUNTRIES.filter(({ box }) => longitude >= box[0] && longitude <= box[2] && latitude >= box[1] && latitude <= box[3]);
  return holding.sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0] ?? null;
}

/** What is asked for, as a region: its id and box. Null for a country there is none of. */
export function regionOf(ask: RegionAsk): RegionSpec | null {
  if ('country' in ask) {
    const country = countryOf(ask.country);
    return country ? { id: country.code, name: country.name, box: country.box } : null;
  }
  const { latitude, longitude, km, name } = ask.around;
  if (!(km > 0 && km <= 500) || Math.abs(latitude) > 85 || Math.abs(longitude) > 180) return null;
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.05, Math.cos((latitude * Math.PI) / 180)));
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    id: `around-${round(latitude)}-${round(longitude)}-${km}`.replace(/\./g, '_'),
    name,
    box: [round(Math.max(-180, longitude - dLon)), round(Math.max(-85, latitude - dLat)), round(Math.min(180, longitude + dLon)), round(Math.min(85, latitude + dLat))],
  };
}
