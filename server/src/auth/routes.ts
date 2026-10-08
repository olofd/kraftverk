import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { ApiError, CLIENT_HEADER, CONFIG_SCHEMA_PATH } from '@kraftverk/api-contract';
import { actor } from '@kraftverk/device-sdk';
import type { AuditLog } from '@kraftverk/store';
import { body } from '../routes/parse.ts';
import { LoginLimiter, limiterKeys } from './limiter.ts';
import { AccountError, SESSION_LIFETIME_MS, type Accounts, type User } from './accounts.ts';
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

/**
 * The only paths reachable without a session: the way in — each doing one
 * narrow thing, none reading or changing anything but its own session — and
 * the configuration's JSON Schema, which an editor fetches without logging in:
 * the installed types only, nothing you have (`routes/configuration.ts`).
 */
const OPEN = new Set(['/api/auth/state', '/api/auth/setup', '/api/auth/login', '/api/auth/logout', `/api${CONFIG_SCHEMA_PATH}`]);

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

/** The signed-in account's name: what a caller is named by. */
export function usernameOf(c: Context): string {
  return accessByRequest.get(c.req.raw)?.user?.username ?? 'unknown';
}

/** The signed-in account, once the gate has let the request through. */
export function userOf(c: Context): User | null {
  return accessByRequest.get(c.req.raw)?.user ?? null;
}

type AuthDeps = {
  proxies: ProxyDirectory;
  /** The accounts that may sign in, and their sessions. */
  accounts: Accounts;
  /** The home's timeline: sign-ins, failures and account changes are on it. */
  audit: Pick<AuditLog, 'record'>;
  /** The nodes an account joined from, forgotten with it, and every way they held: no other account may speak for them. */
  forgetNodesOf: (accountId: string) => void;
  limiter?: LoginLimiter;
};

export function createAuth({ proxies, accounts, audit, forgetNodesOf, limiter = new LoginLimiter() }: AuthDeps) {
  const socketIp = (c: Context): string | null => {
    const env = c.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
    return normaliseIp(env?.requestIP?.(c.req.raw)?.address ?? null);
  };

  const trustOf = (c: Context): Trust => {
    const socket = socketIp(c);
    if (socket && !proxies.addresses.has(socket) && c.req.raw.headers.has(EXPOSURE_HEADER)) proxies.refreshSoon();
    return assessTrust({ socketIp: socket, headers: c.req.raw.headers, proxies: proxies.addresses });
  };

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
    const session = accounts.readSession(getCookie(c, SESSION_COOKIE));
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
    const setupRequired = accounts.countUsers() === 0;
    return c.json(
      {
        error: setupRequired
          ? 'This server has no accounts yet. Create the first one from the home network.'
          : 'Log in to use this server.',
        kind: 'signed-out',
        loginRequired: true,
        setupRequired,
      },
      401
    );
  };

  const credentials = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) });

  const now = () => new Date().toISOString();

  /**
   * Proves the person at the keyboard is the account signed in: its password,
   * asked for again.
   *
   * For what a borrowed session — an unlocked laptop, a copied cookie — must
   * not be enough for: your own password, and every account but your own.
   * Otherwise it could set a password it knows, or add an account it keeps,
   * and outlast the session it borrowed. Counted like a login, so it cannot
   * be used to guess the password either.
   */
  const confirmIdentity = async (c: Context, user: User, password: string): Promise<Response | null> => {
    const { trust } = access(c);
    const keys = limiterKeys(trust.clientIp, user.username, trust.onHomeNetwork);
    const tooMany = limiter.admit(c, keys, 'Too many wrong passwords.');
    if (tooMany) return tooMany;
    if (!(await accounts.passwordMatches(user.id, password))) {
      audit.record({ at: now(), kind: 'auth.confirm-failed', actor: actor('person', user.username), resourceKind: 'account', resource: user.id, summary: `${user.username} gave a wrong password to confirm a change`, detail: { clientIp: trust.clientIp, path: c.req.path } });
      throw new ApiError('forbidden', 'Your password is not right');
    }
    limiter.succeeded(keys);
    return null;
  };

  /** The account's own password, sent with changes that need it. */
  const yourPassword = z.string().min(1, 'Confirm with your password').max(256);

  const auth = new Hono();

  /** Everything the app needs to decide what to show: who, where, and whether setup is due. */
  auth.get('/state', (c) => {
    const { user, trust } = access(c);
    const users = accounts.countUsers();
    return c.json({
      user: user ? { id: user.id, username: user.username } : null,
      // Only consulted for setup: signing in is required everywhere.
      onHomeNetwork: trust.onHomeNetwork,
      // The whole reasoning — which proxy, which address — for someone signed
      // in or at home. A stranger on the internet only needs to know it is
      // not the home network; the details describe how this server is set up.
      reason: user || trust.onHomeNetwork ? trust.reason : 'Not on the home network',
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
      throw new ApiError('forbidden', `The first account can only be created from the home network. ${trust.reason}.`);
    }
    // Before the body, and before the slow hash `createFirstUser` starts with:
    // once there is an account this route has nothing left to do, and must not
    // be a way to make the server hash passwords for anyone who asks.
    if (accounts.countUsers() > 0) throw new ApiError('conflict', 'This server already has an administrator. Log in instead.');
    const { username, password } = await body(c, credentials);
    const user = await accounts.createFirstUser(username, password).catch(rethrow);
    const { token } = accounts.createSession(user.id, trust.clientIp, c.req.header('user-agent') ?? null);
    accounts.markLoggedIn(user.id);
    writeCookie(c, token);
    audit.record({ at: now(), kind: 'auth.setup', actor: actor('person', username), resourceKind: 'account', resource: user.id, summary: `${username} created the first account`, detail: { clientIp: trust.clientIp } });
    return c.json({ user: { id: user.id, username: user.username } }, 201);
  });

  auth.post('/login', async (c) => {
    const { trust } = access(c);
    const { username, password } = await body(c, credentials);
    const keys = limiterKeys(trust.clientIp, username, trust.onHomeNetwork);

    const tooMany = limiter.admit(c, keys, 'Too many failed attempts.');
    if (tooMany) return tooMany;

    const user = await accounts.verifyLogin(username, password);
    if (!user) {
      audit.record({ at: now(), kind: 'auth.login-failed', actor: actor('person', username), summary: `Failed login for ${username}`, detail: { clientIp: trust.clientIp, reason: trust.reason } });
      // One message for both: which half was wrong is what a guesser wants to know.
      return c.json({ error: 'That username and password do not match.' }, 401);
    }

    limiter.succeeded(keys);
    // Whatever session this browser held before, it holds this one instead.
    accounts.endSession(getCookie(c, SESSION_COOKIE));
    const { token } = accounts.createSession(user.id, trust.clientIp, c.req.header('user-agent') ?? null);
    writeCookie(c, token);
    audit.record({ at: now(), kind: 'auth.login', actor: actor('person', user.username), resourceKind: 'account', resource: user.id, summary: `${user.username} logged in`, detail: { clientIp: trust.clientIp, reason: trust.reason } });
    return c.json({ user: { id: user.id, username: user.username } });
  });

  auth.post('/logout', (c) => {
    const { user } = access(c);
    accounts.endSession(getCookie(c, SESSION_COOKIE));
    clearCookie(c);
    if (user) audit.record({ at: now(), kind: 'auth.logout', actor: actor('person', user.username), resourceKind: 'account', resource: user.id, summary: `${user.username} logged out` });
    return c.json({ ok: true });
  });

  /** Your own password. Needs the current one: a borrowed, unlocked browser should not be enough. */
  auth.post('/password', async (c) => {
    const user = requireUser(c);
    const { current, next: password } = await body(c, z.object({ current: yourPassword, next: z.string().min(1).max(256) }));
    const refused = await confirmIdentity(c, user, current);
    if (refused) return refused;
    await accounts.setPassword(user.id, password, getCookie(c, SESSION_COOKIE)).catch(rethrow);
    audit.record({ at: now(), kind: 'user.password', actor: actor('person', user.username), resourceKind: 'account', resource: user.id, summary: `${user.username} changed their password; their other sessions were signed out` });
    return c.json({ ok: true });
  });

  const users = new Hono();

  users.get('/', (c) => {
    requireUser(c);
    return c.json({ users: accounts.listUsers() });
  });

  users.post('/', async (c) => {
    const signedIn = requireUser(c);
    const { username, password, yourPassword: confirmation } = await body(c, credentials.extend({ yourPassword }));
    const refused = await confirmIdentity(c, signedIn, confirmation);
    if (refused) return refused;
    const user = await accounts.createUser(username, password, signedIn.username).catch(rethrow);
    audit.record({ at: now(), kind: 'user.created', actor: actor('person', signedIn.username), resourceKind: 'account', resource: user.id, summary: `${signedIn.username} added ${user.username}` });
    return c.json({ user }, 201);
  });

  users.delete('/:id', async (c) => {
    const signedIn = requireUser(c);
    const target = accounts.getUser(c.req.param('id'));
    if (!target) throw new ApiError('not-found', 'No such user');
    const { yourPassword: confirmation } = await body(c, z.object({ yourPassword }));
    const refused = await confirmIdentity(c, signedIn, confirmation);
    if (refused) return refused;
    try {
      accounts.deleteUser(target.id);
    } catch (error) {
      rethrow(error);
    }
    forgetNodesOf(target.id);
    if (target.id === signedIn.id) clearCookie(c);
    audit.record({ at: now(), kind: 'user.removed', actor: actor('person', signedIn.username), resourceKind: 'account', resource: target.id, summary: `${signedIn.username} removed ${target.username}` });
    return c.json({ ok: true });
  });

  /**
   * Someone else's password. Signs them out everywhere, which is usually why it
   * is being reset.
   *
   * Never your own: that is `/auth/password`, which wants the current one.
   * This route used to take your own id as well, and was then a way around it.
   */
  users.post('/:id/password', async (c) => {
    const signedIn = requireUser(c);
    const target = accounts.getUser(c.req.param('id'));
    if (!target) throw new ApiError('not-found', 'No such user');
    if (target.id === signedIn.id) {
      throw new ApiError('invalid', 'Change your own password under “Change your password”; it needs your current one.');
    }
    const { password, yourPassword: confirmation } = await body(c, z.object({ password: z.string().min(1).max(256), yourPassword }));
    const refused = await confirmIdentity(c, signedIn, confirmation);
    if (refused) return refused;
    await accounts.setPassword(target.id, password).catch(rethrow);
    audit.record({ at: now(), kind: 'user.password', actor: actor('person', signedIn.username), resourceKind: 'account', resource: target.id, summary: `${signedIn.username} set a new password for ${target.username}; their sessions were signed out` });
    return c.json({ ok: true });
  });

  /**
   * The signed-in person's password, asked for again by a route outside
   * these — before a secret leaves the server — counted as `confirmIdentity`
   * counts it: the refusal to answer, or null when it is theirs.
   */
  const confirm = async (c: Context, password: string | undefined): Promise<Response | null> => {
    if (!password) throw new ApiError('forbidden', 'Confirm with your password: a secret leaves the server only for the person it is theirs to give');
    return confirmIdentity(c, requireUser(c), password);
  };

  return { gate, forgery, auth, users, access, requireUser, confirm };
}

/** Account problems are the caller's to fix, so they are refusals with the reason — not failures. */
function rethrow(error: unknown): never {
  if (error instanceof AccountError) throw new ApiError('invalid', error.message);
  throw error;
}
