import { Hono } from 'hono';
import { z } from 'zod';

import type { PolicyValueName } from '@kraftverk/api-contract';
import { NODE_ID, nodeId } from '@kraftverk/device-sdk';

import { homeFor, RESOURCE_KIND, type AppDeps } from './context.ts';
import { body, query } from './parse.ts';

/**
 * The home over HTTP (docs/DATA-MODEL.md §3): what its people call it and
 * which node is its master, the kraftverk nodes that are part of it, the
 * values it decides, and its timeline. What each does is the home's
 * (`KraftverkApi`).
 */
export function homeRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.get('/home', async (c) => c.json(await homeFor(deps, c).home()));

  /**
   * A node joins the home, saying who it is — by its own id — and what it can
   * reach devices over. It does so at every start, so "held by Olof's iPhone"
   * has something to name and the add flow knows what that node can hold.
   */
  api.post('/nodes', async (c) => {
    const input = await body(
      c,
      z
        .object({
          id: z.string().regex(NODE_ID),
          name: z.string().trim().min(1).max(60),
          platform: z.enum(['system', 'web', 'native']),
          transports: z.array(z.string().min(1).max(20)).max(10),
          alwaysOn: z.boolean(),
          reachable: z.boolean(),
          trusted: z.boolean(),
          place: z.string().min(1).max(40).nullable(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).nodes.join({ ...input, id: nodeId(input.id) }));
  });

  api.get('/nodes', async (c) => c.json({ nodes: await homeFor(deps, c).nodes.list() }));

  /** Forgets a node, and every connection it held. */
  api.delete('/nodes/:id', async (c) => {
    await homeFor(deps, c).nodes.forget(nodeId(c.req.param('id')));
    return c.json({ ok: true });
  });

  /** What this home decides that declarations name: how much is a load worth confirming. */
  api.get('/policy', async (c) => c.json(await homeFor(deps, c).policy.list()));

  api.put('/policy/:name', async (c) => {
    const { value } = await body(c, z.object({ value: z.number().finite().nullable() }).strict());
    return c.json(await homeFor(deps, c).policy.set(c.req.param('name') as PolicyValueName, value));
  });

  /** The timeline, newest first: all of it, one kind of thing's, or one thing's; `before` pages back. */
  api.get('/audit', async (c) => {
    const asked = query(
      c,
      z
        .object({
          limit: z.coerce.number().int().min(1).max(1000).default(100),
          resourceKind: RESOURCE_KIND.optional(),
          resource: z.string().min(1).max(120).optional(),
          before: z.coerce.number().int().min(1).optional(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).timeline(asked));
  });

  return api;
}
