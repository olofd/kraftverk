import list from './countries.json' with { type: 'json' };

/*
  Every country, or part of one, a home may hold the map of: its code, its
  name, and the box its mainland lies in — west, south, east, north. The
  list is data (countries.json), written by scripts/gen-countries.mjs from
  Natural Earth's map units (public domain, naturalearthdata.com).
*/

export type Country = { code: string; name: string; box: readonly [number, number, number, number] };

export const COUNTRIES: readonly Country[] = list as unknown as Country[];
