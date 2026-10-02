import { Hono } from 'hono';

import { answerMcp, worldText } from '@kraftverk/hub';

import { actorOf } from '../auth/routes.ts';
import { SERVER } from '../config.ts';
import { homeFor, type AppDeps } from './context.ts';

/**
 * The house for an assistant over HTTP (PROPOSITION.md §5.1–5.3): the world
 * as a model reads it, the words it is said in, and an MCP endpoint — whose
 * tools are the hub's (`answerMcp`).
 *
 * Behind the same sign-in as every route: an MCP client sends the session
 * cookie and the client header, as the app does. Each tool asks the home as
 * an agent acting for whoever is signed in: what needs a person's yes is
 * refused it there, in the gateway's words.
 */
export function assistantRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  /** The house now: every device, its parts, what each offers and reports and how fresh, and the links. `?format=text` for a context window. */
  api.get('/world', async (c) => {
    const now = await homeFor(deps, c).world();
    return c.req.query('format') === 'text' ? c.text(worldText(now)) : c.json(now);
  });

  /** The words the world is said in: capabilities, meanings, link kinds, recipes, and the values the home has set. */
  api.get('/vocabulary', async (c) => c.json(await homeFor(deps, c).vocabulary()));

  /**
   * MCP over HTTP: JSON-RPC in, JSON out — one message or a batch. Nothing
   * streams, so there is no event stream to open (GET answers 405).
   */
  api.post('/mcp', async (c) => {
    const payload: unknown = await c.req.json().catch(() => null);
    if (!payload || typeof payload !== 'object') return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That is not JSON' } }, 400);
    const messages = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
    // The assistant asks as an agent acting for whoever is signed in.
    const home = deps.hub.as({ kind: 'agent', for: actorOf(c) });
    const said = (await Promise.all(messages.map((message) => answerMcp(message, home, { name: 'kraftverk', version: SERVER.version })))).filter((reply) => reply !== null);
    if (!said.length) return c.body(null, 202);
    return c.json(Array.isArray(payload) ? said : said[0]!);
  });
  api.get('/mcp', (c) => c.json({ error: 'This MCP endpoint answers POSTs; it has no event stream.' }, 405));

  return api;
}
