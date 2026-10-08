/*
  Writes packages/map/src/countries.json: every country, or part of one, a home
  may hold the map of — its code, its name and the box its mainland is in —
  from Natural Earth's map units (public domain). Run by hand when a newer
  Natural Earth is wanted; what it writes is kept in the repository.

    node scripts/gen-countries.mjs [path-or-url to ne_50m_admin_0_map_units.geojson]

  A unit's box is its main landmass and what lies within 1000 km of it — so
  Norway is not drawn to Svalbard, nor the United States to Hawaii: the area
  around a place is how those are fetched.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = process.argv[2] ?? 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_map_units.geojson';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'map', 'src', 'countries.json');
const NEAR_KM = 1000;

const text = SOURCE.startsWith('http') ? await (await fetch(SOURCE)).text() : readFileSync(SOURCE, 'utf8');
const units = JSON.parse(text).features;

const boxOf = (ring) => {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of ring) {
    box[0] = Math.min(box[0], lon);
    box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lon);
    box[3] = Math.max(box[3], lat);
  }
  return box;
};
// Roughly, in square degrees scaled for latitude: enough to say which part is the mainland.
const areaOf = (box) => (box[2] - box[0]) * (box[3] - box[1]) * Math.cos((((box[1] + box[3]) / 2) * Math.PI) / 180);
// How far apart two boxes are, in km, edge to edge.
const gapKm = (a, b) => {
  const lat = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
  const lon = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
  const mid = Math.cos((((a[1] + a[3] + b[1] + b[3]) / 4) * Math.PI) / 180);
  return Math.hypot(lat * 111, lon * 111 * mid);
};

const entries = [];
for (const unit of units) {
  const p = unit.properties;
  const polygons = unit.geometry.type === 'Polygon' ? [unit.geometry.coordinates] : unit.geometry.coordinates;
  const parts = polygons.map((polygon) => boxOf(polygon[0])).sort((a, b) => areaOf(b) - areaOf(a));
  const main = [...parts[0]];
  for (const part of parts.slice(1)) {
    if (gapKm(main, part) > NEAR_KM) continue;
    main[0] = Math.min(main[0], part[0]);
    main[1] = Math.min(main[1], part[1]);
    main[2] = Math.max(main[2], part[2]);
    main[3] = Math.max(main[3], part[3]);
  }
  const iso = [p.ISO_A2_EH, p.ISO_A2].find((code) => code && code !== '-99');
  const code = (iso ?? p.SU_A3 ?? p.GU_A3).toLowerCase();
  // A little beyond the coast, so a border town is whole.
  const round = (value, out) => Math.round((value + out) * 100) / 100;
  entries.push({ code, name: p.NAME_EN ?? p.NAME, box: [round(main[0], -0.1), round(main[1], -0.1), round(main[2], 0.1), round(main[3], 0.1)] });
}
// One entry per code: a unit sharing another's code (a country's parts) keeps its own name, said in full.
const seen = new Map();
for (const entry of entries) {
  const twin = seen.get(entry.code);
  if (twin) entry.code = `${entry.code}-${entry.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`;
  seen.set(entry.code, entry);
}
entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

// Data, not code: one country to a line, read by countries.ts.
writeFileSync(OUT, `[\n${entries.map(({ code, name, box }) => JSON.stringify({ code, name, box })).join(',\n')}\n]\n`);
console.log(`Wrote ${entries.length} countries to ${OUT}`);
