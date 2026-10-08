import { Hono } from 'hono';
import { z } from 'zod';

import { LINK_KIND_IDS, type LinkKind } from '@kraftverk/device-sdk';

import { familyFor, PART, type AppDeps } from './context.ts';
import { body } from './parse.ts';

const values = z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean()]));

/**
 * Adding a device (docs/DATA-MODEL.md §1), over HTTP. The app walks the
 * steps; each one that touches a device the master will hold runs in the
 * home (`KraftverkApi.setup`), in a draft only the account that started it
 * sees. Nothing is stored until the save. A way a follower sets up itself
 * comes in with what it holds (`followers.ts`).
 */
export function setupRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.post('/', async (c) => {
    const input = await body(
      c,
      z.object({ typeId: z.string().min(1).max(80), methodId: z.string().min(1).max(40).nullable().optional(), holder: z.enum(['master', 'this-node']).optional(), through: z.string().min(1).max(40).optional() }).strict()
    );
    return c.json(await familyFor(deps, c).setup.start(input));
  });

  /** One of a device's ways, set up again: signed in again, its key fetched again. */
  api.post('/again', async (c) => {
    const input = await body(c, z.object({ deviceId: z.string().min(1).max(40), connectionId: z.string().min(1).max(40) }).strict());
    return c.json(await familyFor(deps, c).setup.again(input));
  });

  api.get('/:id', async (c) => c.json(await familyFor(deps, c).setup.get(c.req.param('id'))));

  api.delete('/:id', async (c) => {
    await familyFor(deps, c).setup.discard(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/:id/sightings', async (c) => c.json({ sightings: await familyFor(deps, c).setup.sightings(c.req.param('id')) }));

  api.post('/:id/choose', async (c) => {
    const input = await body(
      c,
      z.union([
        // A member of a bridge says which bridge: its key is one there.
        z.object({ address: z.string().min(1).max(200), through: z.string().min(1).max(40).optional() }).strict(),
        z.object({ manual: z.string().min(1).max(200) }).strict(),
        // Where the transports list what they see, there is no chooser: the home says so.
        z.object({ chooser: z.object({ showAll: z.boolean().optional() }).strict() }).strict(),
      ])
    );
    return c.json(await familyFor(deps, c).setup.choose(c.req.param('id'), input));
  });

  api.patch('/:id', async (c) => {
    const input = await body(c, z.object({ device: values.optional(), connection: values.optional() }).strict());
    return c.json(await familyFor(deps, c).setup.update(c.req.param('id'), input));
  });

  api.post('/:id/steps/:step/actions/:action', async (c) => {
    const { input } = await body(c, z.object({ input: values.default({}) }).strict());
    return c.json(await familyFor(deps, c).setup.action(c.req.param('id'), c.req.param('step'), c.req.param('action'), input, c.req.raw.signal));
  });

  api.post('/:id/steps/:step/discover', async (c) => c.json(await familyFor(deps, c).setup.discover(c.req.param('id'), c.req.param('step'), c.req.raw.signal)));

  api.post('/:id/check', async (c) => c.json(await familyFor(deps, c).setup.check(c.req.param('id'))));

  api.post('/:id/save', async (c) => {
    const input = await body(
      c,
      z
        .object({
          name: z.string().trim().max(60).default(''),
          mode: z.enum(['new', 'attach', 'restore']).default('new'),
          deviceId: z.string().min(1).max(80).optional(),
          anyway: z.boolean().optional(),
          secretsExportable: z.boolean().optional(),
          links: z
            .array(
              z
                .object({
                  kind: z.enum(LINK_KIND_IDS as [LinkKind, ...LinkKind[]]),
                  part: z.string().min(1).max(80),
                  other: PART,
                  role: z.enum(['source', 'target']),
                })
                .strict()
            )
            .max(8)
            .optional(),
        })
        .strict()
    );
    return c.json(await familyFor(deps, c).setup.save(c.req.param('id'), input));
  });

  return api;
}
