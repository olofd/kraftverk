import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { actorOf } from '../auth/routes.ts';
import { LINK_KIND_IDS, type LinkKind } from '@kraftverk/device-sdk';

import { auditAbout, body, ownClient, type AppDeps } from './shared.ts';

const values = z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean()]));

/**
 * Adding a device the server will hold (docs/DATA-MODEL.md §1).
 *
 * The app walks the steps; each one that touches the device runs here, in a
 * draft only the account that started it can see. Nothing is stored until
 * the save, which writes the device, its connection, the connection's secrets
 * and its links in one go.
 */
export function setupRoutes({ setup, registry, clients }: AppDeps): Hono {
  const api = new Hono();

  /** The draft a request names, if it is this account's. */
  const draft = (c: Context): string => {
    const id = c.req.param('id') ?? '';
    setup.assertOwner(id, actorOf(c));
    return id;
  };

  api.post('/', async (c) => {
    const input = await body(c, z.object({ typeId: z.string().min(1).max(80), methodId: z.string().min(1).max(40).nullable().optional() }).strict());
    return c.json(await setup.start({ ...input, by: actorOf(c) }));
  });

  /**
   * A connection this app will hold. It ran the steps itself and read the
   * device with its own radio; this is what it learnt, never a secret. The
   * answer is the draft with its check, ready to save through `/:id/save`.
   */
  api.post('/app', async (c) => {
    const input = await body(
      c,
      z
        .object({
          clientId: z.string().min(1).max(40),
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
    const client = ownClient(clients, c, input.clientId);
    return c.json(setup.startHeld({ ...input, clientId: client.id, by: actorOf(c) }));
  });

  api.get('/:id', (c) => c.json(setup.view(draft(c))));

  api.delete('/:id', (c) => {
    setup.discard(draft(c));
    return c.json({ ok: true });
  });

  /** What the transport can see that this type's protocol recognises. Polled while the step is open. */
  api.get('/:id/sightings', (c) => c.json({ sightings: setup.sightings(draft(c)) }));

  api.post('/:id/choose', async (c) => {
    const input = await body(c, z.union([z.object({ address: z.string().min(1).max(200) }).strict(), z.object({ manual: z.string().min(1).max(200) }).strict()]));
    return c.json(setup.choose(draft(c), input));
  });

  api.patch('/:id', async (c) => {
    const input = await body(c, z.object({ device: values.optional(), connection: values.optional() }).strict());
    return c.json(setup.update(draft(c), input));
  });

  api.post('/:id/steps/:step/actions/:action', async (c) => {
    const id = draft(c);
    const { input } = await body(c, z.object({ input: values.default({}) }).strict());
    return c.json(await setup.action(id, c.req.param('step'), c.req.param('action'), input, c.req.raw.signal));
  });

  api.post('/:id/steps/:step/discover', async (c) => c.json(await setup.discover(draft(c), c.req.param('step'), c.req.raw.signal)));

  api.post('/:id/check', async (c) => c.json(await setup.check(draft(c))));

  api.post('/:id/save', async (c) => {
    const id = draft(c);
    const input = await body(
      c,
      z
        .object({
          name: z.string().trim().max(60).default(''),
          mode: z.enum(['new', 'attach', 'restore']).default('new'),
          deviceId: z.string().min(1).max(80).optional(),
          anyway: z.boolean().optional(),
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
    const record = await setup.save(id, input);
    if (input.anyway) auditAbout(c, 'device.saved-unchecked', 'device', record.id, `"${record.name}" was saved without answering the check`);
    return c.json(registry.find(record.id));
  });

  return api;
}
