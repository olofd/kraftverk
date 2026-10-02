import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { connectionId, linkId, savedDeviceId, type LinkKind } from '@kraftverk/device-sdk';

import { userOf } from '../auth/routes.ts';
import { auditAbout, body, homeFor, type AppDeps } from './shared.ts';

/**
 * How each device is reached, how devices fit the house, and the phones and
 * browsers that can hold a connection (docs/DATA-MODEL.md §4), over HTTP.
 * What each does with a device is the home's (`KraftverkApi`).
 *
 * A connection is added by the setup flow, never here: adding one has to
 * find the device, and that is what setup is.
 */

export function connectionRoutes(deps: AppDeps): Hono {
  const { catalog, clients, sessions } = deps;
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

  // --- clients ----------------------------------------------------------------

  /**
   * A phone or browser says who it is and what it can reach devices over. It
   * does so at every start, so "held by Olof's iPhone" has something to name
   * and the add flow knows what this app can hold.
   */
  api.post('/clients', async (c) => {
    const user = userOf(c);
    if (!user) throw new HTTPException(401, { message: 'Sign in first' });
    const input = await body(
      c,
      z
        .object({
          id: z.string().min(1).max(40).optional(),
          name: z.string().trim().min(1).max(60),
          platform: z.enum(['web', 'native']),
          transports: z.array(z.string().min(1).max(20)).max(10),
        })
        .strict()
    );
    return c.json(clients.register({ ...input, userId: user.id }));
  });

  api.get('/clients', (c) => {
    const user = userOf(c);
    if (!user) throw new HTTPException(401, { message: 'Sign in first' });
    return c.json({ clients: clients.forUser(user.id) });
  });

  /** Forgets a phone or browser, and every connection it held. */
  api.delete('/clients/:id', async (c) => {
    const user = userOf(c);
    const client = clients.get(c.req.param('id'));
    if (!user || !client || client.userId !== user.id) throw new HTTPException(404, { message: 'No such app' });
    clients.remove(client.id);
    auditAbout(c, 'client.forgotten', 'client', client.id, `Forgot "${client.name}" and every connection it held`);
    await sessions.sync(catalog.list());
    return c.json({ ok: true });
  });

  return api;
}
