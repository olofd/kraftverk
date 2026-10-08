import { describe, expect, test } from 'bun:test';

import { accuracyGeoJSON, boundsOf, circleRing, countryAt, mapStyle, markersGeoJSON, overlaps, regionOf, tileBounds, tileOf, trailsGeoJSON } from './index.ts';

/* Made-up places only: a box in the sea west of Africa, and capitals anyone can look up. */

describe('the style', () => {
  test('every URL the home’s own, absolute; OpenStreetMap credited', () => {
    const style = mapStyle({ origin: 'https://home.example.test' }) as { glyphs: string; sprite: string; sources: { protomaps: { tiles: string[]; attribution: string } }; layers: unknown[] };
    expect(style.glyphs).toBe('https://home.example.test/api/map/fonts/{fontstack}/{range}.pbf');
    expect(style.sprite).toBe('https://home.example.test/api/map/sprites/v4/dark');
    expect(style.sources.protomaps.tiles).toEqual(['https://home.example.test/api/map/tiles/{z}/{x}/{y}.mvt']);
    expect(style.sources.protomaps.attribution).toBe('© OpenStreetMap');
    expect(style.layers.length).toBeGreaterThan(20);
  });
});

describe('what a map shows', () => {
  test('a circle of metres is that far from its centre all round', () => {
    const ring = circleRing(10, 0, 1000, 16);
    expect(ring).toHaveLength(17);
    for (const [lon, lat] of ring) {
      const metres = Math.hypot((lat - 10) * 111_195, (lon - 0) * 111_195 * Math.cos((10 * Math.PI) / 180));
      expect(Math.abs(metres - 1000)).toBeLessThan(5);
    }
  });

  test('markers, how sure each is, and trails, as GeoJSON — a trail of one point draws nothing', () => {
    const marker = { id: 'p', latitude: 10, longitude: 0, accuracy: 20 };
    expect(markersGeoJSON([marker]).features[0]!.geometry).toEqual({ type: 'Point', coordinates: [0, 10] });
    expect(accuracyGeoJSON([marker, { id: 'q', latitude: 1, longitude: 1 }]).features).toHaveLength(1);
    expect(trailsGeoJSON([{ id: 't', points: [{ latitude: 1, longitude: 1 }] }]).features).toHaveLength(0);
    expect(trailsGeoJSON([{ id: 't', points: [{ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }] }]).features[0]!.geometry.coordinates).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test('the box around what is shown takes in how sure a marker is', () => {
    const box = boundsOf({ markers: [{ id: 'p', latitude: 10, longitude: 0, accuracy: 1000 }] })!;
    expect(box[3] - 10).toBeCloseTo(1000 / 111_195, 4);
    expect(boundsOf({})).toBeNull();
  });

  test('tiles: where a place is, and what a tile covers', () => {
    const { x, y } = tileOf(59.33, 18.07, 10);
    const [west, south, east, north] = tileBounds(10, x, y);
    expect(18.07 >= west && 18.07 <= east && 59.33 >= south && 59.33 <= north).toBe(true);
    expect(overlaps([0, 0, 1, 1], [0.5, 0.5, 2, 2])).toBe(true);
    expect(overlaps([0, 0, 1, 1], [2, 2, 3, 3])).toBe(false);
  });
});

describe('regions', () => {
  test('a country by its code, the country a place is in, and the area around a place', () => {
    expect(regionOf({ country: 'SE' })).toMatchObject({ id: 'se', name: 'Sweden' });
    expect(regionOf({ country: 'xx' })).toBeNull();
    expect(countryAt(48.86, 2.35)?.code).toBe('fr');
    const around = regionOf({ around: { latitude: 10, longitude: 0, km: 50, name: 'Somewhere' } })!;
    expect(around.box[3] - around.box[1]).toBeCloseTo(100 / 111, 1);
    expect(regionOf({ around: { latitude: 10, longitude: 0, km: 5000, name: 'Too far' } })).toBeNull();
  });
});
