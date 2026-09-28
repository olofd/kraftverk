import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

import pkg from '../package.json' with { type: 'json' };
import { hostGuard } from './auth/host.ts';
import { CLIENT_HEADER, createAuth } from './auth/routes.ts';
import { isPrivate, normaliseIp } from './auth/trust.ts';
import type { ServerConfig } from './config.ts';
import { SetupError } from './devices/setup.ts';
import { adminRoutes } from './routes/admin.ts';
import { deviceRoutes } from './routes/devices.ts';
import { connectionRoutes } from './routes/connections.ts';
import type { AppDeps } from './routes/shared.ts';
import { setupRoutes } from './routes/setup.ts';
import { transportRoutes } from './routes/transports.ts';

export type { AppDeps } from './routes/shared.ts';

/** What `GET /api/version` says about this server. */
export type VersionInfo = {
  name: string;
  version: string;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
  /** Every device is simulated: no hardware is reached. A launch decision. */
  simulate: boolean;
  /** Which transports this server may use. */
  transports: string[];
  readOnly: boolean;
};

/** Ports the Expo dev server serves the web app on. */
const DEV_PORTS = new Set(['8081', '19006']);

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
  const { config, startedAt } = deps;
  const app = new Hono();

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
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.use(
    '/api/*',
    cors({
      origin: corsOrigin(config),
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      // The forgery header must be allowed, or the app's own writes would fail
      // their preflight — and it is exactly what a foreign origin cannot send.
      allowHeaders: ['Content-Type', CLIENT_HEADER],
      credentials: true,
    })
  );

  /** Accounts, sessions, and the one gate in front of `/api`. See `auth/routes.ts`. */
  const accounts = createAuth({ proxies: deps.proxies, limiter: deps.limiter });

  const api = new Hono();
  // First, before any route: Hono runs middleware only for routes registered after it.
  api.use('*', accounts.forgery);
  api.use('*', accounts.gate);
  api.route('/auth', accounts.auth);
  api.route('/users', accounts.users);

  api.get('/health', (c) => c.json({ ok: true }));

  api.get('/version', (c) => {
    const info: VersionInfo = {
      name: pkg.name,
      version: pkg.version,
      runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.versions.node}`,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      simulate: config.simulate,
      transports: config.transports,
      readOnly: config.readOnly,
    };
    return c.json(info);
  });

  api.route('/setup', setupRoutes(deps));
  api.route('/', adminRoutes(deps, accounts));
  api.route('/', deviceRoutes(deps));
  api.route('/', connectionRoutes(deps));
  api.route('/', transportRoutes(deps));

  app.route('/api', api);

  app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

  app.onError((err, c) => {
    // JSON, like every other answer here: the app reads `{ error }`.
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // Adding a device went wrong in a way the person can act on: in words.
    if (err instanceof SetupError) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) {
      return c.json({ error: 'Validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    }
    console.error('[server]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return { app, accounts };
}
