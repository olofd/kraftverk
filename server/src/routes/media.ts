import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError, type MediaType } from '@kraftverk/api-contract';

import { familyFor, type AppDeps } from './context.ts';
import { query } from './parse.ts';

/**
 * Pictures over HTTP (docs/PLAN-WORLD-MODEL.md §8.12): added as their bytes,
 * with what they are and how big — checked by the family — and fetched by
 * their id, which is their content, so a browser keeps one for ever. Kept
 * privately: a photo of a home is the family's.
 */

/** Pictures, by their id: what the API's no-store leaves to be cached. */
export const MEDIA_CACHED = /^\/api\/media\/[0-9a-f]{64}$/;

export function mediaRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.post('/media', async (c) => {
    const { width, height } = query(c, z.object({ width: z.coerce.number().int().min(1).max(8192), height: z.coerce.number().int().min(1).max(8192) }).strict());
    const type = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim() as MediaType;
    const data = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await familyFor(deps, c).media.add({ type, width, height, data }));
  });

  api.get('/media/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ApiError('not-found', 'No such picture');
    const picture = await familyFor(deps, c).media.get(id);
    if (!picture) throw new ApiError('not-found', 'No such picture');
    return new Response(picture.data as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': picture.type, 'Cache-Control': 'private, max-age=31536000, immutable' } });
  });

  return api;
}
