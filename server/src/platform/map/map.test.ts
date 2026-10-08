import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MapRegions } from './regions.ts';
import { TileStore } from './tiles.ts';

/*
  The map's regions, with the pmtiles tool and Protomaps' build played: asked
  for, downloaded in turn with progress, refreshed into a file of its own,
  let go — and what it holds kept across a restart.
*/

const dirs: string[] = [];
const stores: TileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function aMap() {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-map-'));
  dirs.push(dir);
  const ran: string[][] = [];
  let finish: () => void = () => {};
  const run = async (args: string[], progress: (fraction: number) => void) => {
    ran.push(args);
    if (args.includes('--dry-run')) return 'Extract transferred 2.6 GB (overfetch 0.05) for an archive size of 2.5 GB';
    progress(0.5);
    await new Promise<void>((resolve) => (finish = resolve));
    writeFileSync(args[2]!, 'not really tiles');
    return '';
  };
  const tiles = new TileStore(join(dir, 'cache.db'), () => null);
  stores.push(tiles);
  const regions = new MapRegions({ dir, tool: null, tiles, run, latestBuild: async () => '20261007' });
  return { dir, ran, regions, tiles, finish: () => finish() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the map’s regions', () => {
  test('the world first, then a country, one at a time, with progress; refreshed into a file of its own; let go', async () => {
    const map = aMap();
    await map.regions.start();
    await settle();
    expect(map.regions.view().regions.map((region) => [region.id, region.state])).toEqual([['world', 'downloading']]);
    expect(map.ran[0]).toEqual(['extract', 'https://build.protomaps.com/20261007.pmtiles', expect.stringMatching(/world-20261007\.pmtiles\.part$/), '--maxzoom=6']);

    map.regions.add({ country: 'se' });
    expect(map.regions.view().regions.find((region) => region.id === 'se')).toMatchObject({ name: 'Sweden', state: 'queued', maxZoom: 14 });
    expect(map.regions.view().regions[0]!.progress).toBe(0.5);

    map.finish();
    await settle();
    expect(map.regions.view().regions.map((region) => [region.id, region.state])).toEqual([
      ['world', 'ready'],
      ['se', 'downloading'],
    ]);
    expect(map.ran[1]!.find((arg) => arg.startsWith('--bbox='))).toBe('--bbox=11.05,55.25,24.26,69.14');
    map.finish();
    await settle();
    const sweden = map.regions.view().regions.find((region) => region.id === 'se')!;
    expect(sweden).toMatchObject({ state: 'ready', built: '2026-10-07', bytes: 16 });

    // Kept across a restart.
    const again = new MapRegions({ dir: map.dir, tool: null, tiles: map.tiles, run: async () => '', latestBuild: async () => '20261008' });
    expect(again.view().regions.map((region) => region.id)).toEqual(['world', 'se']);

    // Let go: its file deleted. The world stays.
    await map.regions.remove('se');
    expect(existsSync(join(map.dir, 'regions', 'se-20261007.pmtiles'))).toBe(false);
    await expect(map.regions.remove('world')).rejects.toThrow('The world stays');
  });

  test('how big a region would be, asked without downloading it; a region that is no country refused', async () => {
    const map = aMap();
    expect(await map.regions.estimate({ country: 'se' })).toBe(2_500_000_000);
    expect(() => map.regions.add({ country: 'xx' })).toThrow('No such region');
  });

  test('fetching as someone looks is on until turned off, and stays off across a restart', () => {
    const map = aMap();
    expect(map.regions.view().cache).toEqual({ fetching: true, bytes: 0 });
    map.regions.setFetching(false);
    expect(map.tiles.fetching).toBe(false);
    const again = new MapRegions({ dir: map.dir, tool: null, tiles: map.tiles, run: async () => '' });
    expect(again.view().cache.fetching).toBe(false);
  });
});
