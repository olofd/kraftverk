import { Hono } from 'hono';

import { homeFor, type AppDeps } from './context.ts';

/** What this node can reach devices over, and what can be seen near it: the home's (`KraftverkApi`). */
export function transportRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.get('/transports', async (c) => c.json(await homeFor(deps, c).transports.list()));

  /** "Found near you": what can be seen that nothing you have is reached by. */
  api.get('/found', async (c) => c.json({ found: await homeFor(deps, c).nearby() }));

  api.get('/transports/:id/diagnostics/:name', async (c) => c.json(await homeFor(deps, c).transports.diagnostic(c.req.param('id'), c.req.param('name'), c.req.query())));

  return api;
}
