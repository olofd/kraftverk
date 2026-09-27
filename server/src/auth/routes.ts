import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { audit } from '../history/db.ts';
import { LoginLimiter, limiterKeys } from './limiter.ts';
import {
  AccountError,
  countUsers,
  createFirstUser,
  createSession,
  createUser,
  deleteUser,
  endSession,
  getUser,
  listUsers,
  markLoggedIn,
  readSession,
  SESSION_LIFETIME_MS,
  setPassword,
  setTrustLan,
  trustLan,
  verifyLogin,
  type User,
} from './store.ts';
import { assessTrust, EXPOSURE_HEADER, normaliseIp, type ProxyDirectory, type Trust } from './trust.ts';

/**
 * Logging in, and who may use the API without doing so.
 *
 * One gate in front of every `/api` route: a request passes with a valid
 * session, or — when the owner has chosen to trust it — from the home network,
 * decided as `trust.ts` explains. Managing accounts always needs a real login:
 * otherwise any device on the LAN could quietly give itself a way in from the
 * internet.
 *
 * And one rule for every request that changes anything: it must carry an
 * `X-Kraftverk-Client` header. A web page on another site cannot add a custom
 * header to a cross-origin request without the browser first asking this
 * server, and the CORS policy says no. Without it, any page you visit could
 * post to this server from your browser — a "simple" request with a text body
 * needs no permission, and one route here switches mains power.
 */

export const SESSION_COOKIE = 'kraftverk_session';
export const CLIENT_HEADER = 'x-kraftverk-client';

/** Paths anyone may reach: the health check, and the way in. */
const OPEN = new Set(['/api/health', '/api/auth/state', '/api/auth/setup', '/api/auth/login', '/api/auth/logout']);

export type Access = {
  trust: Trust;
  /** Home network and trusted: no login needed. */
  trusted: boolean;
  user: User | null;
};

const accessByRequest = new WeakMap<Request, Access>();

/** Who is acting, for the audit log: the account, or the home network. */
export function actorOf(c: Context): string {
  const access = accessByRequest.get(c.req.raw);
  if (access?.user) return access.user.username;
  if (access?.trusted) return `home network (${access.trust.clientIp ?? 'unknown'})`;
  return 'unknown';
}

export type AuthDeps = {
  proxies: ProxyDirectory;
  limiter?: LoginLimiter;
};

export function createAuth({ proxies, limiter = new LoginLimiter() }: AuthDeps) {
  const socketIp = (c: Context): string | null => {
    const env = c.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
    return normaliseIp(env?.requestIP?.(c.req.raw)?.address ?? null);
  };

  const trustOf = (c: Context): Trust =>
    assessTrust({ socketIp: socketIp(c), headers: c.req.raw.headers, proxies: proxies.addresses });

  /** Served over HTTPS as far as the browser is concerned — through the public entrance, or directly. */
  const secure = (c: Context): boolean => {
    const socket = socketIp(c);
    if (socket && proxies.addresses.has(socket) && c.req.header(EXPOSURE_HEADER) === 'public') return true;
    return new URL(c.req.url).protocol === 'https:';
  };

  const writeCookie = (c: Context, token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      path: '/api',
      httpOnly: true,
      sameSite: 'Lax',
      secure: secure(c),
      maxAge: Math.floor(SESSION_LIFETIME_MS / 1000),
    });

  const clearCookie = (c: Context) => deleteCookie(c, SESSION_COOKIE, { path: '/api', secure: secure(c) });

  /** Reads the session and the network once per request, and remembers both. */
  const access = (c: Context): Access => {
    const known = accessByRequest.get(c.req.raw);
    if (known) return known;
    const trust = trustOf(c);
    const session = readSession(getCookie(c, SESSION_COOKIE));
    if (session?.renewed) writeCookie(c, getCookie(c, SESSION_COOKIE)!);
    const result: Access = { trust, trusted: trust.onHomeNetwork && trustLan(), user: session?.user ?? null };
    accessByRequest.set(c.req.raw, result);
    return result;
  };

  const requireUser = (c: Context): User => {
    const { user } = access(c);
    if (!user) throw new HTTPException(401, { message: 'Log in to manage accounts — even on the home network' });
    return user;
  };

  /** Refuses state-changing requests that a page on another site could have forged. */
  const forgery: MiddlewareHandler = async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.req.header(CLIENT_HEADER)) {
      return c.json(
        { error: `Requests that change anything must carry an ${CLIENT_HEADER} header. The app sends it; a forged request from another website cannot.` },
        403
      );
    }
    await next();
  };

  /** The gate in front of every `/api` route. */
  const gate: MiddlewareHandler = async (c, next) => {
    if (c.req.method === 'OPTIONS' || OPEN.has(c.req.path)) return next();
    const { user, trusted } = access(c);
    if (user || trusted) return next();
    const setupRequired = countUsers() === 0;
    return c.json(
      {
        error: setupRequired
          ? 'This server has no accounts yet. Create the first one from the home network.'
          : 'Log in to use this server.',
        loginRequired: true,
        setupRequired,
      },
      401
    );
  };

  const credentials = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) });

  const parse = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
    const raw = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: 'Expected a JSON body' });
    });
    return schema.parse(raw);
  };

  const now = () => new Date().toISOString();

  const auth = new Hono();

  /** Everything the app needs to decide what to show: who, where, and whether setup is due. */
  auth.get('/state', (c) => {
    const { user, trust, trusted } = access(c);
    const users = countUsers();
    return c.json({
      user: user ? { id: user.id, username: user.username } : null,
      onHomeNetwork: trust.onHomeNetwork,
      trustLan: trustLan(),
      trusted,
      reason: trust.reason,
      setupRequired: users === 0,
      canSetup: users === 0 && trust.onHomeNetwork,
    });
  });

  /**
   * The first administrator. From the home network only, whatever the trust
   * setting says: a fresh install reachable from the internet must not be
   * claimable by whoever finds it first.
   */
  auth.post('/setup', async (c) => {
    const { trust } = access(c);
    if (!trust.onHomeNetwork) {
      throw new HTTPException(403, { message: `The first account can only be created from the home network. ${trust.reason}.` });
    }
    const { username, password } = await parse(c, credentials);
    const user = await createFirstUser(username, password).catch(rethrow);
    const { token } = createSession(user.id, trust.clientIp, c.req.header('user-agent') ?? null);
    markLoggedIn(user.id);
    writeCookie(c, token);
    audit({ at: now(), kind: 'auth.setup', actor: username, resource: user.id, summary: `${username} created the first account`, detail: { clientIp: trust.clientIp } });
    return c.json({ user: { id: user.id, username: user.username } }, 201);
  });

  auth.post('/login', async (c) => {
    const { trust } = access(c);
    const { username, password } = await parse(c, credentials);
    const keys = limiterKeys(trust.clientIp, username);

    const wait = limiter.wait(keys);
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return c.json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60_000)} min.` }, 429);
    }

    const user = await verifyLogin(username, password);
    if (!user) {
      limiter.failed(keys);
      audit({ at: now(), kind: 'auth.login-failed', actor: username, summary: `Failed login for ${username}`, detail: { clientIp: trust.clientIp, reason: trust.reason } });
      // One message for both: which half was wrong is what a guesser wants to know.
      return c.json({ error: 'That username and password do not match.' }, 401);
    }

    limiter.succeeded(keys);
    const { token } = createSession(user.id, trust.clientIp, c.req.header('user-agent') ?? null);
    writeCookie(c, token);
    audit({ at: now(), kind: 'auth.login', actor: user.username, resource: user.id, summary: `${user.username} logged in`, detail: { clientIp: trust.clientIp, reason: trust.reason } });
    return c.json({ user: { id: user.id, username: user.username } });
  });

  auth.post('/logout', (c) => {
    const { user } = access(c);
    endSession(getCookie(c, SESSION_COOKIE));
    clearCookie(c);
    if (user) audit({ at: now(), kind: 'auth.logout', actor: user.username, resource: user.id, summary: `${user.username} logged out` });
    return c.json({ ok: true });
  });

  /** Your own password. Needs the current one: a borrowed, unlocked browser should not be enough. */
  auth.post('/password', async (c) => {
    const user = requireUser(c);
    const { current, next: password } = await parse(c, z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) }));
    if (!(await verifyLogin(user.username, current))) {
      throw new HTTPException(403, { message: 'The current password is not right' });
    }
    await setPassword(user.id, password, getCookie(c, SESSION_COOKIE)).catch(rethrow);
    audit({ at: now(), kind: 'user.password', actor: user.username, resource: user.id, summary: `${user.username} changed their password; their other sessions were signed out` });
    return c.json({ ok: true });
  });

  /** Whether the home network may skip the login. A security setting, so it needs a login to change. */
  auth.patch('/settings', async (c) => {
    const user = requireUser(c);
    const { trustLan: next } = await parse(c, z.object({ trustLan: z.boolean() }));
    setTrustLan(next);
    audit({
      at: now(),
      kind: 'auth.trust-lan',
      actor: user.username,
      summary: next ? `${user.username} let the home network use the app without logging in` : `${user.username} required a login on every network`,
    });
    return c.json({ trustLan: next });
  });

  const users = new Hono();

  users.get('/', (c) => {
    requireUser(c);
    return c.json({ users: listUsers() });
  });

  users.post('/', async (c) => {
    const actor = requireUser(c);
    const { username, password } = await parse(c, credentials);
    const user = await createUser(username, password, actor.username).catch(rethrow);
    audit({ at: now(), kind: 'user.created', actor: actor.username, resource: user.id, summary: `${actor.username} added ${user.username}` });
    return c.json({ user }, 201);
  });

  users.delete('/:id', (c) => {
    const actor = requireUser(c);
    const target = getUser(c.req.param('id'));
    if (!target) throw new HTTPException(404, { message: 'No such user' });
    try {
      deleteUser(target.id);
    } catch (error) {
      rethrow(error);
    }
    if (target.id === actor.id) clearCookie(c);
    audit({ at: now(), kind: 'user.removed', actor: actor.username, resource: target.id, summary: `${actor.username} removed ${target.username}` });
    return c.json({ ok: true });
  });

  /** Someone else's password. Signs them out everywhere, which is usually why it is being reset. */
  users.post('/:id/password', async (c) => {
    const actor = requireUser(c);
    const target = getUser(c.req.param('id'));
    if (!target) throw new HTTPException(404, { message: 'No such user' });
    const { password } = await parse(c, z.object({ password: z.string().min(1).max(256) }));
    const keep = target.id === actor.id ? getCookie(c, SESSION_COOKIE) : undefined;
    await setPassword(target.id, password, keep).catch(rethrow);
    audit({ at: now(), kind: 'user.password', actor: actor.username, resource: target.id, summary: `${actor.username} set a new password for ${target.username}; their sessions were signed out` });
    return c.json({ ok: true });
  });

  return { gate, forgery, auth, users, access, requireUser };
}

/** Account problems are the caller's to fix, so they are 400s with the reason — not 500s. */
function rethrow(error: unknown): never {
  if (error instanceof AccountError) throw new HTTPException(400, { message: error.message });
  throw error;
}
