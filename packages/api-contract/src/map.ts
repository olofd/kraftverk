import type { Bounds, RegionAsk } from '@kraftverk/map';

/*
  The map a server holds (docs/PLAN-MAPS.md), as `GET /api/map/regions`
  answers it: the world, always, and the regions downloaded for detail.
*/

/** One archive of map the server holds, or is getting. */
export type MapRegionView = {
  id: string;
  name: string;
  /** The world, roughly; a country; or the area around a place. */
  kind: 'world' | 'country' | 'around';
  box: Bounds;
  /** How close it goes. */
  maxZoom: number;
  /** Held and served; waiting its turn; being downloaded; or the last try failed. */
  state: 'ready' | 'queued' | 'downloading' | 'failed';
  /** How far a download is, 0–1, while it is. */
  progress: number | null;
  /** Its size on disk, once held. */
  bytes: number | null;
  /** The day of the map data it was cut from: `2026-10-07`. */
  built: string | null;
  error: string | null;
  addedAt: string;
};

export type MapRegionsView = {
  regions: MapRegionView[];
  /** Whether this server can download a region; why not, when it cannot. */
  downloads: { ok: true } | { ok: false; reason: string };
  /**
   * Detail fetched as someone looks: a tile no region holds is read from
   * Protomaps' build and kept — whether that is on, and how much is kept.
   */
  cache: { fetching: boolean; bytes: number };
};

/** What a region is asked for as: a country by its code, or the area around a place. */
export type MapRegionAsk = RegionAsk;
