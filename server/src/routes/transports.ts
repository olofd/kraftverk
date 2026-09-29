import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { AppDeps } from './shared.ts';

/**
 * What this server can reach devices over: each transport, whether it is
 * running, what it can see, and its own read-only diagnostics — the broker's
 * journal, the Bluetooth GATT layout — by name, so none is a route of its own.
 */
export function transportRoutes({ config, transports, serverLog, nearby }: AppDeps): Hono {
  const api = new Hono();

  api.get('/transports', (c) =>
    c.json({
      readOnly: config.readOnly,
      transports: transports.definitions().map((definition) => {
        const transport = transports.get(definition.id);
        return {
          ...definition,
          running: transport !== null,
          availability: transports.available(definition.id),
          values: transport?.values?.() ?? {},
          diagnostics: Object.keys(transport?.diagnostics ?? {}),
        };
      }),
      refused: transports.refused,
    })
  );

  /** "Found near you": what can be seen that nothing you have is reached by. */
  api.get('/found', (c) => c.json({ found: nearby.list() }));

  api.get('/transports/:id/diagnostics/:name', async (c) => {
    const transport = transports.get(c.req.param('id'));
    const diagnostic = transport?.diagnostics?.[c.req.param('name')];
    if (!diagnostic) throw new HTTPException(404, { message: 'No such diagnostic, or it is not running' });
    const result = await diagnostic(c.req.query());
    if (result === null || result === undefined) throw new HTTPException(503, { message: 'It is not answering' });
    return c.json(result);
  });

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
