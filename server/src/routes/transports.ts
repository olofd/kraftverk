import { Hono } from 'hono';
import { z } from 'zod';

import { homeFor, type AppDeps } from './shared.ts';

/**
 * What this server can reach devices over (the home's: `KraftverkApi`), what
 * can be seen near it, and — the server's own — what it has said lately.
 */
export function transportRoutes(deps: AppDeps): Hono {
  const { serverLog } = deps;
  const api = new Hono();

  api.get('/transports', async (c) => c.json(await homeFor(deps, c).transports.list()));

  /** "Found near you": what can be seen that nothing you have is reached by. */
  api.get('/found', async (c) => c.json({ found: await homeFor(deps, c).nearby() }));

  api.get('/transports/:id/diagnostics/:name', async (c) => c.json(await homeFor(deps, c).transports.diagnostic(c.req.param('id'), c.req.param('name'), c.req.query())));

  /**
   * What the server has said lately — the same lines as its console, which in
   * a container nobody is watching. `?level=warn` for problems only. The full
   * record is in daily files, named here, for a shell on the server.
   */
  api.get('/diagnostics/log', (c) => {
    const { limit, level } = z
      .object({
        limit: z.coerce.number().int().min(1).max(2000).default(500),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      })
      .parse({ limit: c.req.query('limit') ?? 500, level: c.req.query('level') });
    return c.json({ dir: serverLog.dir, lines: serverLog.recent(limit, level) });
  });

  return api;
}
