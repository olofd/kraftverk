import { Hono } from 'hono';
import { z } from 'zod';

import { linkId, type LinkKind } from '@kraftverk/device-sdk';

import { homeFor, PART, type AppDeps } from './context.ts';
import { body } from './parse.ts';

/**
 * How devices fit the house (docs/DATA-MODEL.md §3) — which plug feeds which
 * station's input — over HTTP. What a link means is the home's
 * (`KraftverkApi.links`).
 */
export function linkRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.post('/links', async (c) => {
    const input = await body(c, z.object({ kind: z.string().min(1).max(40), source: PART, target: PART }).strict());
    return c.json(await homeFor(deps, c).links.add({ ...input, kind: input.kind as LinkKind }));
  });

  api.delete('/links/:id', async (c) => {
    await homeFor(deps, c).links.remove(linkId(c.req.param('id')));
    return c.json({ ok: true });
  });

  return api;
}
