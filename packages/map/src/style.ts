import { layers, namedFlavor } from '@protomaps/basemaps';

/*
  A map's look: Protomaps' basemap (BSD-3, from OpenStreetMap's data, ODbL),
  drawn from the home's own tiles, fonts and sprites — every URL the home's,
  so the page asks nobody else, and nobody else learns where anyone looks.
*/

/** The map data's credit, shown on every map: OpenStreetMap's licence asks it. */
export const MAP_CREDIT = '© OpenStreetMap';

/** How detailed the home's tiles go: closer than this, the map draws from these. */
export const DETAIL_ZOOM = 14;

export type MapTheme = 'dark' | 'light';

/** Where a home serves its map, under its own origin: tiles, fonts, sprites. */
export const mapPaths = (origin: string) => ({
  tiles: `${origin}/api/map/tiles/{z}/{x}/{y}.mvt`,
  glyphs: `${origin}/api/map/fonts/{fontstack}/{range}.pbf`,
  sprite: (theme: MapTheme) => `${origin}/api/map/sprites/v4/${theme}`,
});

/**
 * The style a renderer draws: MapLibre's, on the web and on a phone alike.
 * `origin` is the home's, absolute — a renderer's worker cannot resolve a
 * relative URL — and `lang` the language places are named in.
 */
export function mapStyle(options: { origin: string; theme?: MapTheme; lang?: string }): Record<string, unknown> {
  const theme = options.theme ?? 'dark';
  const paths = mapPaths(options.origin);
  return {
    version: 8,
    glyphs: paths.glyphs,
    sprite: paths.sprite(theme),
    sources: {
      protomaps: { type: 'vector', tiles: [paths.tiles], maxzoom: DETAIL_ZOOM, attribution: MAP_CREDIT },
    },
    layers: layers('protomaps', namedFlavor(theme), { lang: options.lang ?? 'en' }),
  };
}
