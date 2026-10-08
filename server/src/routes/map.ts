import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError } from '@kraftverk/api-contract';
import type { RegionAsk } from '@kraftverk/map';

import type { MapRegions } from '../platform/map/regions.ts';
import type { TileStore } from '../platform/map/tiles.ts';
import { body } from './parse.ts';

/*
  The map, over HTTP (docs/PLAN-MAPS.md): its tiles, the fonts and icons its
  style draws with — all under the home's own origin, so a page asks nobody
  else — and the regions the server holds. Tiles, fonts and icons are public
  map data, not anyone's house: the one answer under /api a browser may keep
  a day (app.ts lets these alone).
*/

export type MapParts = { tiles: TileStore; regions: MapRegions };

/** Map data a browser may keep: what app.ts does not mark "no-store". */
export const MAP_CACHED = /^\/api\/map\/(tiles|fonts|sprites)\//;

const ASK = z.union([
  z.object({ country: z.string().regex(/^[a-z0-9-]{2,40}$/i) }).strict(),
  z.object({ around: z.object({ latitude: z.number().finite().min(-85).max(85), longitude: z.number().finite().min(-180).max(180), km: z.number().positive().max(500), name: z.string().trim().min(1).max(80) }).strict() }).strict(),
]);

export function mapRoutes(map: MapParts): Hono {
  const api = new Hono();
  const kept = { 'Cache-Control': 'private, max-age=86400' };

  api.get('/map/tiles/:z/:x/:file', async (c) => {
    const [z, x, y] = [Number(c.req.param('z')), Number(c.req.param('x')), Number(c.req.param('file').replace(/\.mvt$/, ''))];
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new ApiError('invalid', 'No such tile');
    const tile = await map.tiles.tile(z, x, y).catch((error: unknown) => {
      console.warn(`[map] tile ${z}/${x}/${y}: ${(error as Error).message}`);
      return null;
    });
    // Nothing there to draw — the sea, past the map's detail — is an empty answer, not a failure.
    if (!tile) return c.body(null, 204, kept);
    return c.body(tile as Uint8Array<ArrayBuffer>, 200, { ...kept, 'Content-Type': 'application/vnd.mapbox-vector-tile' });
  });

  api.get('/map/fonts/:stack/:range', (c) => {
    const stack = c.req.param('stack');
    const range = c.req.param('range');
    if (!/^[A-Za-z0-9 ]{1,60}$/.test(stack) || !/^\d{1,5}-\d{1,5}\.pbf$/.test(range)) throw new ApiError('invalid', 'No such font');
    return served(join(map.regions.assets, 'fonts', stack, range), 'application/x-protobuf');
  });

  api.get('/map/sprites/v4/:name', (c) => {
    const name = c.req.param('name');
    if (!/^(dark|light)(@2x)?\.(json|png)$/.test(name)) throw new ApiError('invalid', 'No such sprite');
    return served(join(map.regions.assets, 'sprites', 'v4', name), name.endsWith('.png') ? 'image/png' : 'application/json');
  });

  const served = (file: string, type: string) => {
    if (!existsSync(file)) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new Response(Bun.file(file), { headers: { ...kept, 'Content-Type': type } });
  };

  api.get('/map/regions', (c) => c.json(map.regions.view()));

  api.post('/map/regions/estimate', async (c) => {
    const ask = (await body(c, ASK)) as RegionAsk;
    return c.json({ bytes: await map.regions.estimate(ask).catch((error: unknown) => Promise.reject(new ApiError('conflict', (error as Error).message))) });
  });

  api.post('/map/regions', async (c) => {
    const ask = (await body(c, ASK)) as RegionAsk;
    try {
      return c.json(map.regions.add(ask));
    } catch (error) {
      throw new ApiError('invalid', (error as Error).message);
    }
  });

  api.post('/map/regions/:id/refresh', (c) => {
    try {
      return c.json(map.regions.refresh(c.req.param('id')));
    } catch (error) {
      throw new ApiError('not-found', (error as Error).message);
    }
  });

  api.delete('/map/regions/:id', async (c) => {
    try {
      return c.json(await map.regions.remove(c.req.param('id')));
    } catch (error) {
      throw new ApiError('conflict', (error as Error).message);
    }
  });

  api.put('/map/fetching', async (c) => {
    const { on } = await body(c, z.object({ on: z.boolean() }).strict());
    return c.json(map.regions.setFetching(on));
  });

  api.delete('/map/cache', (c) => c.json(map.regions.clearCache()));

  return api;
}
