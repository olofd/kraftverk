import { Hono } from 'hono';
import { z } from 'zod';

import { KEY, NODE_ID, nodeId, type PolicyValueName } from '@kraftverk/device-sdk';

import { familyFor, RESOURCE_KIND, type AppDeps } from './context.ts';
import { body, query } from './parse.ts';

/**
 * The family over HTTP (docs/PLAN-WORLD-MODEL.md): what its people call it
 * and which node is its master, its homes, the kraftverk nodes that are part
 * of it, the values it decides, and its timeline. What each does is the
 * family's (`KraftverkApi`).
 */
export function familyRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.get('/family', async (c) => c.json(await familyFor(deps, c).family()));

  /** Its homes: each a place, with its own clock — the family checks what each says. */
  const HOME = z
    .object({
      key: z.string().regex(KEY),
      name: z.string().trim().min(1).max(60),
      type: z.enum(['house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other']),
      timeZone: z.string().min(1).max(64),
      icon: z.string().max(40).nullable(),
      location: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), radius: z.number().finite().positive().max(50_000) }).strict().nullable(),
      address: z.object({ street: z.string().max(120).nullable(), postalCode: z.string().max(20).nullable(), locality: z.string().max(80).nullable(), region: z.string().max(80).nullable() }).strict(),
      country: z.string().regex(/^[A-Z]{2}$/).nullable(),
      bearing: z.number().finite().min(0).lt(360),
    })
    .strict();
  api.get('/homes', async (c) => c.json({ homes: await familyFor(deps, c).homes.list({ removed: c.req.query('removed') === 'true' }) }));
  api.post('/homes', async (c) => c.json(await familyFor(deps, c).homes.add(await body(c, HOME.partial({ key: true, icon: true, location: true, address: true, country: true, bearing: true })))));
  api.patch('/homes/:id', async (c) => c.json(await familyFor(deps, c).homes.update(c.req.param('id'), await body(c, HOME.partial()))));
  api.delete('/homes/:id', async (c) => c.json(await familyFor(deps, c).homes.remove(c.req.param('id'))));

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
        })
        .strict()
    );
    return c.json(await familyFor(deps, c).nodes.join({ ...input, id: nodeId(input.id) }));
  });

  api.get('/nodes', async (c) => c.json({ nodes: await familyFor(deps, c).nodes.list() }));

  /** Forgets a node, and every connection it held. */
  api.delete('/nodes/:id', async (c) => {
    await familyFor(deps, c).nodes.forget(nodeId(c.req.param('id')));
    return c.json({ ok: true });
  });

  /** What this home decides that declarations name: how much is a load worth confirming. */
  api.get('/policy', async (c) => c.json(await familyFor(deps, c).policy.list()));

  api.put('/policy/:name', async (c) => {
    const { value } = await body(c, z.object({ value: z.number().finite().nullable() }).strict());
    return c.json(await familyFor(deps, c).policy.set(c.req.param('name') as PolicyValueName, value));
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
    return c.json(await familyFor(deps, c).timeline(asked));
  });

  return api;
}
