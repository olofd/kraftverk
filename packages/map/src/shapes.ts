/*
  What a map shows, as GeoJSON — the language both renderers draw: where
  something is and how sure (a marker and a circle of metres), where it has
  been (a trail), and an area that means something (a zone). Longitude
  first, as GeoJSON has it.
*/

export type LngLat = readonly [number, number];
export type Bounds = readonly [number, number, number, number];

/** Something drawn where it is: its place, how sure, what it is called, and its colour. */
export type MapMarker = { id: string; latitude: number; longitude: number; accuracy?: number | null; label?: string; color?: string; stale?: boolean };
/** Where something has been, oldest first. */
export type MapTrail = { id: string; points: readonly { latitude: number; longitude: number; at?: string }[]; color?: string };
/** An area: a circle of so many metres around a place. */
export type MapZone = { id: string; latitude: number; longitude: number; radius: number; label?: string; color?: string };

const EARTH = 6_371_008.8;
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** A circle of `metres` around a place, as a ring of `steps` points: what an accuracy, or a zone, is drawn as. */
export function circleRing(latitude: number, longitude: number, metres: number, steps = 64): LngLat[] {
  const d = metres / EARTH;
  const lat = rad(latitude);
  const lon = rad(longitude);
  const ring: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(bearing));
    const lon2 = lon + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    ring.push([deg(lon2), deg(lat2)]);
  }
  return ring;
}

type Feature = { type: 'Feature'; id?: string; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
type Collection = { type: 'FeatureCollection'; features: Feature[] };

/** Markers as points, each with its colour and whether it is old. */
export const markersGeoJSON = (markers: readonly MapMarker[]): Collection => ({
  type: 'FeatureCollection',
  features: markers.map((marker) => ({
    type: 'Feature',
    id: marker.id,
    properties: { id: marker.id, label: marker.label ?? '', color: marker.color ?? '', stale: marker.stale === true },
    geometry: { type: 'Point', coordinates: [marker.longitude, marker.latitude] },
  })),
});

/** How sure each marker is, as a circle around it — those whose accuracy is known. */
export const accuracyGeoJSON = (markers: readonly MapMarker[]): Collection => ({
  type: 'FeatureCollection',
  features: markers
    .filter((marker) => typeof marker.accuracy === 'number' && marker.accuracy > 0)
    .map((marker) => ({ type: 'Feature', id: marker.id, properties: { id: marker.id, color: marker.color ?? '' }, geometry: { type: 'Polygon', coordinates: [circleRing(marker.latitude, marker.longitude, marker.accuracy!)] } })),
});

/** Trails as lines. A trail of one point draws nothing. */
export const trailsGeoJSON = (trails: readonly MapTrail[]): Collection => ({
  type: 'FeatureCollection',
  features: trails
    .filter((trail) => trail.points.length > 1)
    .map((trail) => ({ type: 'Feature', id: trail.id, properties: { id: trail.id, color: trail.color ?? '' }, geometry: { type: 'LineString', coordinates: trail.points.map((point) => [point.longitude, point.latitude]) } })),
});

/** An area drawn as it is: a room's outline on the Earth, its ring closed — filled when it is occupied. */
export type MapArea = { id: string; ring: readonly LngLat[]; label?: string; color?: string; filled?: boolean };

/** Areas as polygons, each with whether it is filled. */
export const areasGeoJSON = (areas: readonly MapArea[]): Collection => ({
  type: 'FeatureCollection',
  features: areas
    .filter((area) => area.ring.length >= 4)
    .map((area) => ({ type: 'Feature', id: area.id, properties: { id: area.id, label: area.label ?? '', color: area.color ?? '', filled: area.filled === true }, geometry: { type: 'Polygon', coordinates: [area.ring] } })),
});

/** Zones as circles. */
export const zonesGeoJSON = (zones: readonly MapZone[]): Collection => ({
  type: 'FeatureCollection',
  features: zones.map((zone) => ({ type: 'Feature', id: zone.id, properties: { id: zone.id, label: zone.label ?? '', color: zone.color ?? '' }, geometry: { type: 'Polygon', coordinates: [circleRing(zone.latitude, zone.longitude, zone.radius)] } })),
});

/**
 * The box around what a map shows — markers with their accuracy, trails,
 * zones — west, south, east, north. Null when it shows nothing.
 */
export function boundsOf(shown: { markers?: readonly MapMarker[]; trails?: readonly MapTrail[]; zones?: readonly MapZone[]; areas?: readonly MapArea[] }): Bounds | null {
  const points: { latitude: number; longitude: number; metres: number }[] = [
    ...(shown.areas ?? []).flatMap((area) => area.ring.map(([longitude, latitude]) => ({ latitude, longitude, metres: 0 }))),
    ...(shown.markers ?? []).map((marker) => ({ latitude: marker.latitude, longitude: marker.longitude, metres: marker.accuracy ?? 0 })),
    ...(shown.trails ?? []).flatMap((trail) => trail.points.map((point) => ({ ...point, metres: 0 }))),
    ...(shown.zones ?? []).map((zone) => ({ latitude: zone.latitude, longitude: zone.longitude, metres: zone.radius })),
  ];
  if (!points.length) return null;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const point of points) {
    const dLat = deg(point.metres / EARTH);
    const dLon = dLat / Math.max(0.01, Math.cos(rad(point.latitude)));
    west = Math.min(west, point.longitude - dLon);
    east = Math.max(east, point.longitude + dLon);
    south = Math.min(south, point.latitude - dLat);
    north = Math.max(north, point.latitude + dLat);
  }
  return [west, south, east, north];
}

/** Which tile holds a place at a zoom: x and y in the web map's grid. */
export function tileOf(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad(latitude)) + 1 / Math.cos(rad(latitude))) / Math.PI) / 2) * n);
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

/** The box a tile covers, west, south, east, north. */
export function tileBounds(z: number, x: number, y: number): Bounds {
  const n = 2 ** z;
  const lon = (tx: number) => (tx / n) * 360 - 180;
  const lat = (ty: number) => deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))));
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** Whether two boxes overlap. */
export const overlaps = (a: Bounds, b: Bounds): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
