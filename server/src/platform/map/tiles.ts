import { Database } from 'bun:sqlite';
import { FetchSource, FileSource, PMTiles } from 'pmtiles';

import { DETAIL_ZOOM, overlaps, tileBounds, type Bounds } from '@kraftverk/map';

/*
  The home's map tiles (docs/PLAN-MAPS.md). A tile is served from, in turn:
  1. the most detailed archive on the disk that holds it — a region
     downloaded, else the world;
  2. the tiles fetched before, kept in a cache of a capped size;
  3. Protomaps' daily build itself, read by byte range as a region download
     reads it — fetched as someone looks, then kept in the cache. So a map
     has detail wherever it is looked at, with nothing to set up first.
  The third can be turned off: then only what was downloaded has detail.
  Archives are read by byte ranges, never whole: a country's is gigabytes.
*/

type Archive = { id: string; tiles: PMTiles; box: Bounds; minZoom: number; maxZoom: number };

/** How big the cache of tiles fetched as someone looks may grow before its oldest are let go. */
const CACHE_BYTES = 2_000_000_000;

export class TileStore {
  #archives: Archive[] = [];
  #remote: { build: string; tiles: PMTiles } | null = null;
  readonly #cache: Database;
  #cachedBytes: number;
  /** Whether a tile not held is fetched from Protomaps as someone looks. */
  fetching = true;

  constructor(
    cacheFile: string,
    /** The newest build's URL, when one is known: what tiles not held are read from. */
    private readonly build: () => string | null
  ) {
    this.#cache = new Database(cacheFile, { create: true });
    this.#cache.run('PRAGMA journal_mode = WAL');
    this.#cache.run('CREATE TABLE IF NOT EXISTS tile (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (z, x, y))');
    this.#cachedBytes = (this.#cache.query('SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM tile').get() as { bytes: number }).bytes;
  }

  /** Opens these archives, closing what was open: called again whenever the regions change. */
  async open(files: readonly { id: string; file: string }[]): Promise<void> {
    const opened: Archive[] = [];
    for (const { id, file } of files) {
      try {
        // Bun's file is the File the library reads by slices.
        const tiles = new PMTiles(new FileSource(Bun.file(file) as unknown as File));
        const header = await tiles.getHeader();
        opened.push({ id, tiles, box: [header.minLon, header.minLat, header.maxLon, header.maxLat], minZoom: header.minZoom, maxZoom: header.maxZoom });
      } catch (error) {
        console.warn(`[map] ${id} could not be read: ${(error as Error).message}`);
      }
    }
    // The most detailed first: a region's tile before the world's.
    this.#archives = opened.sort((a, b) => b.maxZoom - a.maxZoom);
  }

  /** The tile at z/x/y, unpacked: held, cached, or fetched as someone looks. Null when there is none — the sea, past the map's zoom. */
  async tile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    const box = tileBounds(z, x, y);
    for (const archive of this.#archives) {
      if (z < archive.minZoom || z > archive.maxZoom || !overlaps(box, archive.box)) continue;
      const found = await archive.tiles.getZxy(z, x, y);
      if (found) return new Uint8Array(found.data);
      // Held there and empty: nothing there to draw — no need to ask anyone.
      if (archive.maxZoom >= z) return null;
    }
    if (z > DETAIL_ZOOM) return null;
    const cached = this.#cache.query('SELECT data FROM tile WHERE z = ? AND x = ? AND y = ?').get(z, x, y) as { data: Uint8Array } | null;
    if (cached) {
      this.#cache.run('UPDATE tile SET used = ? WHERE z = ? AND x = ? AND y = ?', [Date.now(), z, x, y]);
      return cached.data;
    }
    if (!this.fetching) return null;
    const remote = this.#remoteArchive();
    if (!remote) return null;
    const fetched = await remote.getZxy(z, x, y);
    // Nothing there (the open sea): kept as nothing, so it is not asked again.
    const data = fetched ? new Uint8Array(fetched.data) : new Uint8Array(0);
    this.#keep(z, x, y, data);
    return data.length ? data : null;
  }

  /** How much the cache holds now. */
  get cachedBytes(): number {
    return this.#cachedBytes;
  }

  /** Closes the cache's file: at a stop. */
  close(): void {
    this.#cache.close();
  }

  /** Lets go of the cache: what was fetched as someone looked. */
  clearCache(): void {
    this.#cache.run('DELETE FROM tile');
    this.#cachedBytes = 0;
  }

  #remoteArchive(): PMTiles | null {
    const build = this.build();
    if (!build) return null;
    // A newer build: read from it, and the cache, cut from the old, kept — a map a day old is the same map.
    if (this.#remote?.build !== build) this.#remote = { build, tiles: new PMTiles(new FetchSource(build)) };
    return this.#remote.tiles;
  }

  #keep(z: number, x: number, y: number, data: Uint8Array): void {
    this.#cache.run('INSERT OR REPLACE INTO tile (z, x, y, data, used) VALUES (?, ?, ?, ?, ?)', [z, x, y, data, Date.now()]);
    this.#cachedBytes += data.length;
    if (this.#cachedBytes <= CACHE_BYTES) return;
    // Past its size: the tenth used longest ago let go.
    const count = (this.#cache.query('SELECT COUNT(*) AS n FROM tile').get() as { n: number }).n;
    this.#cache.run('DELETE FROM tile WHERE rowid IN (SELECT rowid FROM tile ORDER BY used LIMIT ?)', [Math.max(1, Math.floor(count / 10))]);
    this.#cachedBytes = (this.#cache.query('SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM tile').get() as { bytes: number }).bytes;
  }
}
