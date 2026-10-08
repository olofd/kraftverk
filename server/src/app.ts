import { Hono, type Context } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

import { ApiError, API_ERROR_STATUS, CLIENT_HEADER } from '@kraftverk/api-contract';

import { hostGuard } from './auth/host.ts';
import { createAuth } from './auth/routes.ts';
import { isPrivate, normaliseIp } from './auth/trust.ts';
import type { ServerConfig } from './config.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { automationRoutes } from './routes/automations.ts';
import { configurationRoutes } from './routes/configuration.ts';
import type { AppDeps } from './routes/context.ts';
import { deviceRoutes } from './routes/devices.ts';
import { followerRoutes } from './routes/followers.ts';
import { homeRoutes } from './routes/home.ts';
import { linkRoutes } from './routes/links.ts';
import { liveRoutes } from './routes/live.ts';
import { MAP_CACHED, mapRoutes } from './routes/map.ts';
import { invalid } from './routes/parse.ts';
import { serverRoutes } from './routes/server.ts';
import { setupRoutes } from './routes/setup.ts';
import { transportRoutes } from './routes/transports.ts';

export type { AppDeps } from './routes/context.ts';

/** Ports the Expo dev server serves the web app on. */
const DEV_PORTS = new Set(['8081', '19006']);

/**
 * What an allowed browser elsewhere may send: every method a route answers
 * to. One missing fails that route's preflight — PUT was, and a picture or a
 * home policy value could not be set from the app in development.
 */
export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
 * Which browsers may call this server with the session cookie.
 *
 * The app the web container serves is same-origin and needs no CORS at all,
 * and neither does the native app, which sends no Origin. So in production
 * only the origins named in `ALLOWED_ORIGINS` are allowed.
 *
 * It used to be every private address and `.local` name, on any port — and a
 * browser treats the same host on another port as the same *site*, so the
 * `SameSite=Lax` cookie went along. Any other web app on the NAS — DSM, a
 * media server, a router page — with a script-injection hole could then act
 * as whoever was signed in here, and read the answers. In development the
 * Expo dev server on a private address is allowed too, on its own ports only.
 */
export function corsOrigin(config: Pick<ServerConfig, 'allowedOrigins' | 'development'>) {
  return (origin: string): string | null => {
    if (config.allowedOrigins.includes(origin)) return origin;
    if (!config.development) return null;
    try {
      const url = new URL(origin);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const ip = normaliseIp(host);
      const local = host === 'localhost' || host.endsWith('.local') || (ip !== null && isPrivate(ip));
      return local && DEV_PORTS.has(url.port) ? origin : null;
    } catch {
      return null; // not a URL we can reason about, so not one we trust
    }
  };
}

/**
 * The HTTP server, built from what it serves.
 *
 * No side effects: nothing here starts a radio, a broker or a timer. The
 * process does that in `index.ts` and hands the results in — and a test hands
 * in a simulator and an empty database instead, and drives the very same
 * routes with `app.request()`.
 */
export function createApp(deps: AppDeps) {
  const { config } = deps;
  const allowed = corsOrigin(config);
  const app = new Hono();
  // One per app: the socket handlers Bun is given beside `fetch` (see `index.ts`).
  const { upgradeWebSocket, websocket } = createBunWebSocket();

  /*
    Requests worth a line: anything that changed something, and anything that
    failed. The app polls several routes every few seconds, and a line for each
    successful read — or each CORS preflight — would bury the one that matters.
  */
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const { method } = c.req;
    const status = c.res.status;
    if (method === 'OPTIONS' || ((method === 'GET' || method === 'HEAD') && status < 400)) return;
    const line = `[http] ${method} ${c.req.path} ${status} ${Date.now() - started}ms`;
    if (status >= 500) console.error(line);
    else console.log(line);
  });

  // Before anything else under /api — before CORS, so a rebinding page does
  // not even get a preflight answer. See `auth/host.ts`.
  app.use('/api/*', hostGuard(config.allowedHosts));

  // No body a client of this API sends comes near this.
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'That request body is too large' }, 413) }));

  // API answers are about one person's house: never cached, sniffed or framed.
  app.use('/api/*', async (c, next) => {
    await next();
    // Map data — tiles, fonts, icons — is nobody's house: kept by a browser a day, as its route says.
    if (!(MAP_CACHED.test(c.req.path) && c.res.ok)) c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.use(
    '/api/*',
    cors({
      origin: allowed,
      allowMethods: [...CORS_METHODS],
      // The forgery header must be allowed, or the app's own writes would fail
      // their preflight — and it is exactly what a foreign origin cannot send.
      allowHeaders: ['Content-Type', CLIENT_HEADER],
      credentials: true,
    })
  );

  /** Accounts, sessions, and the one gate in front of `/api`. See `auth/routes.ts`. */
  const auth = createAuth({ proxies: deps.proxies, accounts: deps.accounts, audit: deps.hub.audit, limiter: deps.limiter });

  const api = new Hono();
  // First, before any route: Hono runs middleware only for routes registered after it.
  api.use('*', auth.forgery);
  api.use('*', auth.gate);
  api.route('/auth', auth.auth);
  api.route('/users', auth.users);

  api.route('/', serverRoutes(deps, auth));
  api.route('/', homeRoutes(deps));
  api.route('/setup', setupRoutes(deps));
  api.route('/', followerRoutes(deps));
  api.route('/', deviceRoutes(deps, auth.confirm));
  api.route('/', linkRoutes(deps));
  api.route('/', transportRoutes(deps));
  api.route('/', automationRoutes(deps));
  api.route('/', configurationRoutes(deps, auth.confirm));
  api.route('/', assistantRoutes(deps));
  api.route('/', liveRoutes(deps, upgradeWebSocket, allowed));
  if (deps.map) api.route('/', mapRoutes(deps.map));

  app.route('/api', api);

  app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

  app.onError(answerError);

  return { app, auth, websocket };
}

/**
 * What a route that threw answers: JSON, like every other answer here — the
 * app reads `{ error }`. The home's refusal (`ApiError`) answers with the
 * status its kind maps to, and itself in the body (`toWire`): its kind,
 * `problems` and `needsConfirmation` beside its words;
 * a request that does not hold is refused the same way; anything else is a
 * bug, said in the log and not to the caller.
 */
export function answerError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  const refusal = err instanceof ZodError ? invalid(err) : err;
  if (refusal instanceof ApiError) return c.json(refusal.toWire(), API_ERROR_STATUS[refusal.kind] as ContentfulStatusCode);
  console.error('[server]', err);
  return c.json({ error: 'Internal server error' }, 500);
}
