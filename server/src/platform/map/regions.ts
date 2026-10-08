import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MapRegionsView, MapRegionView } from '@kraftverk/api-contract';
import { DETAIL_ZOOM, regionOf, WORLD_ZOOM, type RegionAsk } from '@kraftverk/map';

import type { TileStore } from './tiles.ts';

/*
  The map this server holds, by region (docs/PLAN-MAPS.md): the world at
  zoom 0–6, fetched at its first start, and the detail of a country or the
  area around a place, downloaded when someone asks — each cut from
  Protomaps' daily build of OpenStreetMap by its `pmtiles` tool, one at a
  time, into the server's data folder. With the world come the fonts and
  icons the style draws its words and symbols with.

  What it holds is kept in `regions.json` beside the archives; an archive is
  written beside its final name and moved there whole, so a server stopped
  mid-download keeps what it had. Each download is a file of its own, named
  by its build's day: the new one is opened before the one it replaces is
  deleted, so no reader ever has a file change under it.
*/

/** Where Protomaps publishes its daily builds of the planet. */
const BUILDS = 'https://build.protomaps.com';
/** The fonts and icons Protomaps' style draws with (basemaps-assets), at a commit: the same files whenever fetched. */
const ASSETS = {
  url: 'https://codeload.github.com/protomaps/basemaps-assets/tar.gz/028c18f713baecad011301ff7a69acc39bcc2ae7',
  folder: 'basemaps-assets-028c18f713baecad011301ff7a69acc39bcc2ae7',
};

/** A region as kept: with the archive it is served from, once there is one. */
type Held = MapRegionView & { file: string | null };

export type MapDeps = {
  /** The folder the map lives in: `<data>/map`. */
  dir: string;
  /** The `pmtiles` tool, or null when this server has none. */
  tool: string | null;
  tiles: TileStore;
  /** For a test: how a download is run, and how the day's build is found. */
  run?: (args: string[], progress: (fraction: number) => void) => Promise<string>;
  latestBuild?: () => Promise<string>;
};

export class MapRegions {
  #held: Held[] = [];
  #queue: string[] = [];
  #running: string | null = null;
  #kill: (() => void) | null = null;
  /** The archive a download is writing, by region. */
  #parts = new Map<string, string>();
  /** The newest build Protomaps has published, as `20261007`, and when that was found. */
  #latest: { day: string; foundAt: number } | null = null;
  /** Whether a tile not held is fetched from Protomaps as someone looks: on, unless turned off. */
  #fetching = true;

  constructor(private deps: MapDeps) {
    mkdirSync(join(deps.dir, 'regions'), { recursive: true });
    try {
      this.#held = JSON.parse(readFileSync(this.#index, 'utf8')) as Held[];
    } catch {
      this.#held = [];
    }
    try {
      this.#fetching = (JSON.parse(readFileSync(join(deps.dir, 'settings.json'), 'utf8')) as { fetching?: boolean }).fetching !== false;
    } catch {
      this.#fetching = true;
    }
  }

  /** Where tiles not held are read from as someone looks: the newest build, once found. */
  buildUrl(): string | null {
    return this.#latest ? `${BUILDS}/${this.#latest.day}.pmtiles` : null;
  }

  /** Turns fetching tiles as someone looks on or off — off, only what was downloaded has detail. */
  setFetching(on: boolean): MapRegionsView {
    this.#fetching = on;
    this.deps.tiles.fetching = on;
    writeFileSync(join(this.deps.dir, 'settings.json'), JSON.stringify({ fetching: on }));
    return this.view();
  }

  /** Lets go of the tiles fetched as someone looked. */
  clearCache(): MapRegionsView {
    this.deps.tiles.clearCache();
    return this.view();
  }

  get #index(): string {
    return join(this.deps.dir, 'regions.json');
  }

  /** Where the fonts and icons are, once fetched. */
  get assets(): string {
    return join(this.deps.dir, 'assets', ASSETS.folder);
  }

  /** At start: the archives held opened; the world, and the fonts and icons, fetched when missing. */
  async start(): Promise<void> {
    this.deps.tiles.fetching = this.#fetching;
    await this.#reopen();
    // A download a stop cut short is asked for again.
    for (const region of this.#held) if (region.state === 'downloading' || region.state === 'queued') this.#enqueue(region.id);
    // The newest build found now, so the first map looked at has its detail; and again each day.
    void this.#build().catch(() => undefined);
    const daily = setInterval(() => void this.#build().catch(() => undefined), 6 * 60 * 60_000);
    (daily as { unref?: () => void }).unref?.();
    // The world, kept on the disk where the tool can get it; without, it is fetched as someone looks, like the rest.
    const downloads = this.view().downloads.ok;
    if (!downloads) this.#held = this.#held.filter((region) => !(region.id === 'world' && region.state === 'failed'));
    if (downloads && !this.#held.some((region) => region.id === 'world')) this.#add({ id: 'world', name: 'The world', kind: 'world', box: [-180, -85, 180, 85], maxZoom: WORLD_ZOOM });
    if (!existsSync(this.assets)) void this.#fetchAssets().catch((error: unknown) => console.warn(`[map] fonts and icons not fetched: ${(error as Error).message}`));
  }

  view(): MapRegionsView {
    return {
      regions: this.#held.map(({ file: _file, ...region }) => region),
      downloads: this.deps.tool || this.deps.run ? { ok: true } : { ok: false, reason: 'This server has no pmtiles tool to download maps with: it comes with kraftverk’s Docker image' },
      cache: { fetching: this.#fetching, bytes: this.deps.tiles.cachedBytes },
    };
  }

  /** Asks for a region: queued, and downloaded in its turn. One held already is left as it is. */
  add(ask: RegionAsk): MapRegionsView {
    const spec = regionOf(ask);
    if (!spec) throw new Error('No such region');
    if (!this.#held.some((region) => region.id === spec.id)) this.#add({ ...spec, kind: 'country' in ask ? 'country' : 'around', maxZoom: DETAIL_ZOOM });
    return this.view();
  }

  /** How big a region would be, asked of Protomaps' build without downloading it. */
  async estimate(ask: RegionAsk): Promise<number> {
    const spec = regionOf(ask);
    if (!spec) throw new Error('No such region');
    const said = await this.#run(['extract', `${BUILDS}/${await this.#build()}.pmtiles`, join(this.deps.dir, 'estimate.pmtiles'), `--bbox=${spec.box.join(',')}`, `--maxzoom=${DETAIL_ZOOM}`, '--dry-run'], () => {});
    const size = /archive size of ([\d.]+) (B|kB|KB|MB|GB|TB)/.exec(said);
    if (!size) throw new Error('Protomaps did not say how big it would be');
    const unit = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[size[2] as 'B'];
    return Math.round(Number(size[1]) * unit);
  }

  /** Gets a region afresh, from the day's build: what it had is served until the new one is whole. */
  refresh(id: string): MapRegionsView {
    const region = this.#get(id);
    if (region.state === 'ready' || region.state === 'failed') {
      region.state = 'queued';
      region.error = null;
      this.#save();
      this.#enqueue(id);
    }
    return this.view();
  }

  /** Lets a region go: its download stopped, its archive deleted. The world stays. */
  async remove(id: string): Promise<MapRegionsView> {
    if (id === 'world') throw new Error('The world stays: it is what every map starts from');
    const region = this.#get(id);
    this.#queue = this.#queue.filter((each) => each !== id);
    if (this.#running === id) this.#kill?.();
    this.#held = this.#held.filter((each) => each !== region);
    this.#save();
    await this.#reopen();
    if (region.file) rmSync(region.file, { force: true });
    const part = this.#parts.get(id);
    if (part) rmSync(part, { force: true });
    return this.view();
  }

  #get(id: string): Held {
    const region = this.#held.find((each) => each.id === id);
    if (!region) throw new Error('No such region');
    return region;
  }

  #add(spec: Pick<MapRegionView, 'id' | 'name' | 'kind' | 'box' | 'maxZoom'>): void {
    this.#held.push({ ...spec, state: 'queued', progress: null, bytes: null, built: null, error: null, addedAt: new Date().toISOString(), file: null });
    this.#save();
    this.#enqueue(spec.id);
  }

  #enqueue(id: string): void {
    if (!this.#queue.includes(id) && this.#running !== id) this.#queue.push(id);
    void this.#next();
  }

  /** The next download in line, one at a time. */
  async #next(): Promise<void> {
    if (this.#running) return;
    const id = this.#queue.shift();
    if (!id) return;
    const region = this.#held.find((each) => each.id === id);
    if (!region) return void this.#next();
    this.#running = id;
    region.state = 'downloading';
    region.progress = 0;
    this.#save();
    try {
      const built = await this.#build();
      const target = join(this.deps.dir, region.id === 'world' ? `world-${built}.pmtiles` : join('regions', `${region.id}-${built}.pmtiles`));
      const part = `${target}.part`;
      this.#parts.set(region.id, part);
      rmSync(part, { force: true });
      await this.#run(['extract', `${BUILDS}/${built}.pmtiles`, part, ...(region.kind === 'world' ? [] : [`--bbox=${region.box.join(',')}`]), `--maxzoom=${region.maxZoom}`], (fraction) => {
        region.progress = fraction;
      });
      // Stopped while it ran: nothing kept.
      if (!this.#held.includes(region)) return rmSync(part, { force: true });
      renameSync(part, target);
      const before = region.file;
      Object.assign(region, { file: target, state: 'ready', progress: null, error: null, bytes: statSync(target).size, built: `${built.slice(0, 4)}-${built.slice(4, 6)}-${built.slice(6, 8)}` });
      console.log(`[map] ${region.name}: held, ${Math.round(region.bytes! / 1e6)} MB from the build of ${region.built}`);
      await this.#reopen();
      // The one it replaces, once nothing reads it.
      if (before && before !== target) rmSync(before, { force: true });
    } catch (error) {
      if (this.#held.includes(region)) Object.assign(region, { state: 'failed', progress: null, error: (error as Error).message });
      console.warn(`[map] ${region.name} not downloaded: ${(error as Error).message}`);
    } finally {
      this.#running = null;
      this.#kill = null;
      this.#parts.delete(region.id);
      this.#save();
      void this.#next();
    }
  }

  /** The day of the newest build Protomaps has published, as `20261007`: today's may still be cut. */
  async #build(): Promise<string> {
    if (this.deps.latestBuild) return this.deps.latestBuild();
    // Looked for again after a day: a newer map, for downloads and for what is fetched as someone looks.
    if (this.#latest && Date.now() - this.#latest.foundAt < 86_400_000) return this.#latest.day;
    for (let back = 1; back <= 8; back++) {
      const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
      const answer = await fetch(`${BUILDS}/${day}.pmtiles`, { method: 'HEAD', signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (answer?.ok) {
        this.#latest = { day, foundAt: Date.now() };
        return day;
      }
    }
    throw new Error('Protomaps has published no build this past week');
  }

  /** The tool, run: what it said, and how far along it is as it goes (its progress bar's percent). */
  #run(args: string[], progress: (fraction: number) => void): Promise<string> {
    if (this.deps.run) return this.deps.run(args, progress);
    const tool = this.deps.tool;
    if (!tool) return Promise.reject(new Error(this.view().downloads.ok ? 'No tool' : (this.view().downloads as { reason: string }).reason));
    const child = Bun.spawn([tool, ...args], { stdout: 'pipe', stderr: 'pipe' });
    this.#kill = () => child.kill();
    const read = async (stream: ReadableStream<Uint8Array>) => {
      let said = '';
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk);
        said += text;
        const percents = [...text.matchAll(/(\d{1,3})%/g)];
        const last = percents.at(-1);
        if (last) progress(Math.min(1, Number(last[1]) / 100));
      }
      return said;
    };
    return Promise.all([read(child.stdout), read(child.stderr), child.exited]).then(([out, err, code]) => {
      if (code !== 0) throw new Error(`pmtiles stopped (${code}): ${(err || out).trim().split('\n').at(-1) ?? ''}`);
      return `${out}\n${err}`;
    });
  }

  /** The fonts and icons, fetched and unpacked beside the archives. */
  async #fetchAssets(): Promise<void> {
    const dir = join(this.deps.dir, 'assets');
    mkdirSync(dir, { recursive: true });
    const archive = join(dir, 'assets.tar.gz');
    const answer = await fetch(ASSETS.url, { signal: AbortSignal.timeout(120_000) });
    if (!answer.ok) throw new Error(`GitHub answered ${answer.status}`);
    writeFileSync(archive, new Uint8Array(await answer.arrayBuffer()));
    // From inside the folder, by a name with no drive in it: a Windows path's "C:" reads to tar as a host.
    const unpacked = Bun.spawn(['tar', 'xzf', 'assets.tar.gz'], { cwd: dir, stdout: 'ignore', stderr: 'pipe' });
    if ((await unpacked.exited) !== 0) throw new Error('its archive could not be unpacked');
    rmSync(archive, { force: true });
    console.log('[map] fonts and icons held');
  }

  async #reopen(): Promise<void> {
    await this.deps.tiles.open(this.#held.flatMap((region) => (region.file && existsSync(region.file) ? [{ id: region.id, file: region.file }] : [])));
  }

  #save(): void {
    writeFileSync(this.#index, JSON.stringify(this.#held, null, 2));
  }
}
