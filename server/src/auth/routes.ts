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
  passwordMatches,
  readSession,
  SESSION_LIFETIME_MS,
  setPassword,
  verifyLogin,
  type User,
} from './store.ts';
import { assessTrust, EXPOSURE_HEADER, FORWARDING_HEADERS as FORWARDED, normaliseIp, type ProxyDirectory, type Trust } from './trust.ts';

/**
 * Logging in.
 *
 * One gate in front of every `/api` route, and it asks one question: is there a
 * valid session? Reads and writes alike, from the home network and from
 * anywhere else. Devices belong to accounts, so every request has to say whose
 * view it wants — and an anonymous visitor, however local, has no answer.
 *
 * The home network still matters in exactly one place: the first account can
 * only be created from it (see `trust.ts`), so a fresh server already reachable
 * from the internet cannot be claimed by whoever finds it first.
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

/**
 * The only paths reachable without a session: the way in. Each does one narrow
 * thing, and none reads or changes anything but its own session.
 */
const OPEN = new Set(['/api/auth/state', '/api/auth/setup', '/api/auth/login', '/api/auth/logout']);

/**
 * The health check, for the container's own healthcheck — which runs inside
 * the container, on loopback. Open to that and to a session; not to the
 * network, which has no need to know the server is up.
 */
const HEALTH = '/api/health';

export type Access = {
  trust: Trust;
  user: User | null;
};

const accessByRequest = new WeakMap<Request, Access>();

/** Who is acting, for the audit log. */
export function actorOf(c: Context): string {
  return accessByRequest.get(c.req.raw)?.user?.username ?? 'unknown';
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

  /** This machine, directly — not something it forwarded. */
  const localCaller = (c: Context): boolean => {
    const socket = socketIp(c);
    if (!socket || proxies.addresses.has(socket)) return false;
    if (FORWARDED.some((name) => c.req.raw.headers.has(name))) return false;
    return socket === '::1' || socket.startsWith('127.');
  };

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
    const session = readSession(getCookie(c, SESSION_COOKIE));
    // Renewed sessions send the cookie again, so its own expiry moves with it.
    if (session?.renewed) writeCookie(c, getCookie(c, SESSION_COOKIE)!);
    const result: Access = { trust: trustOf(c), user: session?.user ?? null };
    accessByRequest.set(c.req.raw, result);
    return result;
  };

  /**
   * The signed-in account behind a request, or a 401.
   *
   * Throws rather than returning null: every route behind the gate has an
   * account by construction, and one that somehow did not must not carry on as
   * nobody in particular.
   */
  const requireUser = (c: Context): User => {
    const { user } = access(c);
    if (!user) throw new HTTPException(401, { message: 'Log in to use this server.' });
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
    if (access(c).user) return next();
    if (c.req.path === HEALTH && localCaller(c)) return next();
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
    const { user, trust } = access(c);
    const users = countUsers();
    return c.json({
      user: user ? { id: user.id, username: user.username } : null,
      // Only consulted for setup: signing in is required everywhere.
      onHomeNetwork: trust.onHomeNetwork,
      reason: trust.reason,
      setupRequired: users === 0,
      canSetup: users === 0 && trust.onHomeNetwork,
    });
  });

  /**
   * The first administrator. From the home network only: a fresh install
   * reachable from the internet must not be claimable by whoever finds it first.
   */
  auth.post('/setup', async (c) => {
    const { trust } = access(c);
    if (!trust.onHomeNetwork) {
      throw new HTTPException(403, { message: `The first account can only be created from the home network. ${trust.reason}.` });
    }
    // Before the body, and before the slow hash `createFirstUser` starts with:
    // once there is an account this route has nothing left to do, and must not
    // be a way to make the server hash passwords for anyone who asks.
    if (countUsers() > 0) throw new HTTPException(409, { message: 'This server already has an administrator. Log in instead.' });
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
    const keys = limiterKeys(trust.clientIp, username, trust.onHomeNetwork);

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
    // Whatever session this browser held before, it holds this one instead.
    endSession(getCookie(c, SESSION_COOKIE));
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
    const { trust } = access(c);
    const { current, next: password } = await parse(c, z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) }));
    // Counted like a login: otherwise a borrowed session could guess the
    // current password here without limit, and then keep the account.
    const keys = limiterKeys(trust.clientIp, user.username, trust.onHomeNetwork);
    const wait = limiter.wait(keys);
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return c.json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60_000)} min.` }, 429);
    }
    if (!(await passwordMatches(user.id, current))) {
      limiter.failed(keys);
      throw new HTTPException(403, { message: 'The current password is not right' });
    }
    limiter.succeeded(keys);
    await setPassword(user.id, password, getCookie(c, SESSION_COOKIE)).catch(rethrow);
    audit({ at: now(), kind: 'user.password', actor: user.username, resource: user.id, summary: `${user.username} changed their password; their other sessions were signed out` });
    return c.json({ ok: true });
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
