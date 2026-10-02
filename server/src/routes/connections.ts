import { Hono } from 'hono';
import { z } from 'zod';

import { connectionId, linkId, NODE_ID, nodeId, savedDeviceId, type LinkKind } from '@kraftverk/device-sdk';

import { body, homeFor, type AppDeps } from './shared.ts';

/**
 * How each device is reached, how devices fit the house, and the home with
 * its kraftverk nodes, each holding the connections it reaches
 * (docs/DATA-MODEL.md §3, §4), over HTTP.
 * What each does with a device is the home's (`KraftverkApi`).
 *
 * A connection is added by the setup flow, never here: adding one has to
 * find the device, and that is what setup is.
 */

export function connectionRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  const ids = (c: { req: { param(name: string): string | undefined } }) => [savedDeviceId(c.req.param('id') ?? ''), connectionId(c.req.param('connection') ?? '')] as const;

  api.post('/devices/:id/connections/:connection/prefer', async (c) => c.json(await homeFor(deps, c).connections.prefer(...ids(c))));

  api.delete('/devices/:id/connections/:connection', async (c) => c.json(await homeFor(deps, c).connections.remove(...ids(c))));

  api.put('/devices/:id/connections/:connection/secrets', async (c) => {
    const given = await body(c, z.record(z.string().max(64), z.string().min(1).max(4096)));
    return c.json(await homeFor(deps, c).connections.setSecrets(...ids(c), given));
  });

  api.patch('/devices/:id/connections/:connection', async (c) => {
    const input = await body(c, z.object({ secretsExportable: z.boolean() }).strict());
    return c.json(await homeFor(deps, c).connections.setExportable(...ids(c), input.secretsExportable));
  });

  // --- links ------------------------------------------------------------------

  const LINK_END = z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80) }).strict();

  api.post('/links', async (c) => {
    const input = await body(c, z.object({ kind: z.string().min(1).max(40), source: LINK_END, target: LINK_END }).strict());
    return c.json(await homeFor(deps, c).links.add({ ...input, kind: input.kind as LinkKind }));
  });

  api.delete('/links/:id', async (c) => {
    await homeFor(deps, c).links.remove(linkId(c.req.param('id')));
    return c.json({ ok: true });
  });

  // --- the home and its nodes -----------------------------------------------

  /** The home: what its people call it, and which node is its master. */
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

  return api;
}
