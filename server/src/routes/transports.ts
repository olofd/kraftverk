import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { homeFor, type AppDeps } from './context.ts';
import { body } from './parse.ts';

/** Where something was found: a transport and its address; for a member of a bridge, the bridge too. */
const FOUND_AT = z.object({ transport: z.string().min(1).max(40), through: z.string().min(1).max(40).nullable(), address: z.string().min(1).max(200) }).strict();
const foundAt = (c: Context) => body(c, FOUND_AT);

/** What this node can reach devices over, and what can be seen near it: the home's (`KraftverkApi`). */
export function transportRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.get('/transports', async (c) => c.json(await homeFor(deps, c).transports.list()));

  /** "Found near you": what can be seen that nothing you have is reached by. */
  api.get('/found', async (c) => c.json({ found: await homeFor(deps, c).nearby() }));

  /** Something found, not to be offered again; or offered again: by where it was found. */
  api.post('/found/ignored', async (c) => c.json(await homeFor(deps, c).ignoreFound(await foundAt(c))));
  api.post('/found/offered', async (c) => c.json(await homeFor(deps, c).unignoreFound(await foundAt(c))));

  /** What an integration keeps between setups, said — never shown — and forgotten. */
  api.get('/integrations/:id/kept', async (c) => c.json({ kept: await homeFor(deps, c).integrations.kept(c.req.param('id')) }));
  api.delete('/integrations/:id/kept/:key', async (c) => c.json(await homeFor(deps, c).integrations.forget(c.req.param('id'), c.req.param('key'))));

  api.get('/transports/:id/diagnostics/:name', async (c) => c.json(await homeFor(deps, c).transports.diagnostic(c.req.param('id'), c.req.param('name'), c.req.query())));

  return api;
}
