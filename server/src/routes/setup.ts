import { Hono } from 'hono';
import { z } from 'zod';

import { LINK_KIND_IDS, type LinkKind } from '@kraftverk/device-sdk';

import { body, homeFor, type AppDeps } from './shared.ts';

const values = z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean()]));

/**
 * Adding a device (docs/DATA-MODEL.md §1), over HTTP. The app walks the
 * steps; each one that touches a device the server will hold runs in the
 * home (`KraftverkApi.setup`), in a draft only the account that started it
 * sees. Nothing is stored until the save.
 */
export function setupRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.post('/', async (c) => {
    const input = await body(c, z.object({ typeId: z.string().min(1).max(80), methodId: z.string().min(1).max(40).nullable().optional(), holder: z.enum(['master', 'this-node']).optional() }).strict());
    return c.json(await homeFor(deps, c).setup.start(input));
  });

  /**
   * A connection this app will hold. It ran the steps itself and read the
   * device with its own radio; this is what it learnt, never a secret. The
   * app speaks for itself only: the home checks it is this account's.
   */
  api.post('/held', async (c) => {
    const input = await body(
      c,
      z
        .object({
          nodeId: z.string().min(1).max(40),
          typeId: z.string().min(1).max(80),
          methodId: z.string().min(1).max(40),
          address: z.string().min(1).max(200),
          identified: z
            .object({
              identity: z.string().min(1).max(120).nullable(),
              model: z.string().max(80).nullable(),
              name: z.string().max(80).optional(),
              summary: z.string().max(300),
              config: values.optional(),
            })
            .strict()
            .nullable(),
          failure: z.string().max(300).optional(),
          device: values.optional(),
          connection: values.optional(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).setup.startHeld(input));
  });

  api.get('/:id', async (c) => c.json(await homeFor(deps, c).setup.get(c.req.param('id'))));

  api.delete('/:id', async (c) => {
    await homeFor(deps, c).setup.discard(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/:id/sightings', async (c) => c.json({ sightings: await homeFor(deps, c).setup.sightings(c.req.param('id')) }));

  api.post('/:id/choose', async (c) => {
    const input = await body(
      c,
      z.union([
        z.object({ address: z.string().min(1).max(200) }).strict(),
        z.object({ manual: z.string().min(1).max(200) }).strict(),
        // A server's transports list what they see: it has no chooser, and says so.
        z.object({ chooser: z.object({ showAll: z.boolean().optional() }).strict() }).strict(),
      ])
    );
    return c.json(await homeFor(deps, c).setup.choose(c.req.param('id'), input));
  });

  api.patch('/:id', async (c) => {
    const input = await body(c, z.object({ device: values.optional(), connection: values.optional() }).strict());
    return c.json(await homeFor(deps, c).setup.update(c.req.param('id'), input));
  });

  api.post('/:id/steps/:step/actions/:action', async (c) => {
    const { input } = await body(c, z.object({ input: values.default({}) }).strict());
    return c.json(await homeFor(deps, c).setup.action(c.req.param('id'), c.req.param('step'), c.req.param('action'), input, c.req.raw.signal));
  });

  api.post('/:id/steps/:step/discover', async (c) => c.json(await homeFor(deps, c).setup.discover(c.req.param('id'), c.req.param('step'), c.req.raw.signal)));

  api.post('/:id/check', async (c) => c.json(await homeFor(deps, c).setup.check(c.req.param('id'))));

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
                  other: z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80) }).strict(),
                  role: z.enum(['source', 'target']),
                })
                .strict()
            )
            .max(8)
            .optional(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).setup.save(c.req.param('id'), input));
  });

  return api;
}
