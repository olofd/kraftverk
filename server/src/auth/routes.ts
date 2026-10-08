import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { ApiError, CLIENT_HEADER, CONFIG_SCHEMA_PATH, type PersonView } from '@kraftverk/api-contract';
import { actor } from '@kraftverk/device-sdk';
import { checkSignIn, newChallenge, type Challenge, type PublicJwk, type SignIn, type Statement } from '@kraftverk/identity';
import type { AuditLog } from '@kraftverk/store';
import { body } from '../routes/parse.ts';
import { LoginLimiter, limiterKeys } from './limiter.ts';
import { AccountError, credentialProblem, SESSION_LIFETIME_MS, type Accounts, type User } from './accounts.ts';
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
const OPEN = new Set(['/api/auth/state', '/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/challenge', '/api/auth/key', '/api/join', `/api${CONFIG_SCHEMA_PATH}`]);

/**
 * The health check, for the container's own healthcheck — which runs inside
 * the container, on loopback. Open to that and to a session; not to the
 * network, which has no need to know the server is up.
 */
const HEALTH = '/api/health';

/** Who a request is: a person — signed in with a login's password, or by their own key — or no one. */
export type Signed = { personId: string; name: string; user: User | null };

export type Access = {
  trust: Trust;
  signed: Signed | null;
};

const accessByRequest = new WeakMap<Request, Access>();

/** The signed-in person's name: what a caller is named by. */
export function usernameOf(c: Context): string {
  return accessByRequest.get(c.req.raw)?.signed?.name ?? 'unknown';
}

/** The signed-in person, once the gate has let the request through. */
export function personOf(c: Context): string | null {
  return accessByRequest.get(c.req.raw)?.signed?.personId ?? null;
}

/** The login a person signed in with, if a password opened their session. */
export function userOf(c: Context): User | null {
  return accessByRequest.get(c.req.raw)?.signed?.user ?? null;
}

type AuthDeps = {
  proxies: ProxyDirectory;
  /** The accounts that may sign in, and their sessions. */
  accounts: Accounts;
  /** The home's timeline: sign-ins, failures and account changes are on it. */
  audit: Pick<AuditLog, 'record'>;
  /** The nodes a person joined from, forgotten with their login, and every way they held: no one else may speak for them. */
  forgetNodesOf: (personId: string) => void;
  /** The family this node serves, as signing in needs it (docs/PLAN-WORLD-MODEL.md §10.5). */
  family: {
    /** This node's id: what a key's challenge names. */
    nodeId: () => string;
    /** A person a login is made for: in the family, with no key yet, an admin — every account on a server is. */
    newPerson: (name: string) => string;
    /** What the family calls a person; null for one it does not know. */
    nameOf: (personId: string) => string | null;
    /** The member a key is, and its public half: while it is not revoked. */
    keyHolder: (keyId: string) => { personId: string; publicJwk: PublicJwk } | null;
    /** A keyless person claimed by their own chain: the id the family knows them by from now. */
    claim: (personId: string, chain: Statement[]) => PersonView;
    /** A person gone from the family with their login. */
    leave: (personId: string) => void;
  };
  limiter?: LoginLimiter;
};

/** How long a key's challenge may be answered in. */
const CHALLENGE_MS = 120_000;

export function createAuth({ proxies, accounts, audit, forgetNodesOf, family, limiter = new LoginLimiter() }: AuthDeps) {
  /** The challenges handed out and not yet answered, by nonce: each answered once, while young. */
  const challenges = new Map<string, Challenge>();
  const sweep = (now: number) => {
    for (const [nonce, challenge] of challenges) if (now - Date.parse(challenge.issuedAt) > CHALLENGE_MS) challenges.delete(nonce);
  };
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
    const signed: Signed | null = session ? { personId: session.personId, name: family.nameOf(session.personId) ?? session.user?.username ?? 'someone', user: session.user } : null;
    const result: Access = { trust: trustOf(c), signed };
    accessByRequest.set(c.req.raw, result);
    return result;
  };

  /**
   * The signed-in person behind a request, or a 401.
   *
   * Throws rather than returning null: every route behind the gate has a
   * person by construction, and one that somehow did not must not carry on as
   * nobody in particular.
   */
  const requireSigned = (c: Context): Signed => {
    const { signed } = access(c);
    if (!signed) throw new HTTPException(401, { message: 'Log in to use this server.' });
    return signed;
  };

  /** The login behind a request: what needs a password to confirm. A person in by their key is told to use it. */
  const requireUser = (c: Context): User => {
    const { user } = requireSigned(c);
    if (!user) throw new ApiError('forbidden', 'That needs your password: sign in with it on this server to do it');
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
    if (access(c).signed) return next();
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
    const { signed, trust } = access(c);
    const users = accounts.countUsers();
    return c.json({
      user: signed ? { id: signed.personId, username: signed.name } : null,
      // Only consulted for setup: signing in is required everywhere.
      onHomeNetwork: trust.onHomeNetwork,
      // The whole reasoning — which proxy, which address — for someone signed
      // in or at home. A stranger on the internet only needs to know it is
      // not the home network; the details describe how this server is set up.
      reason: signed || trust.onHomeNetwork ? trust.reason : 'Not on the home network',
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
    // Checked before the person is made: a refused name or password leaves no one behind.
    const problem = credentialProblem(username, password);
    if (problem) throw new ApiError('invalid', problem);
    const personId = family.newPerson(username);
    const user = await accounts.createFirstUser(username, password, personId).catch(rethrow);
    const { token } = accounts.createSession(user, trust.clientIp, c.req.header('user-agent') ?? null);
    accounts.markLoggedIn(user.id);
    writeCookie(c, token);
    audit.record({ at: now(), kind: 'auth.setup', actor: actor('person', username, personId), resourceKind: 'person', resource: personId, summary: `${username} created the first account`, detail: { clientIp: trust.clientIp } });
    return c.json({ user: { id: personId, username: user.username } }, 201);
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
    const { token } = accounts.createSession(user, trust.clientIp, c.req.header('user-agent') ?? null);
    writeCookie(c, token);
    audit.record({ at: now(), kind: 'auth.login', actor: actor('person', user.username, user.personId), resourceKind: 'person', resource: user.personId, summary: `${user.username} logged in`, detail: { clientIp: trust.clientIp, reason: trust.reason } });
    return c.json({ user: { id: user.personId, username: family.nameOf(user.personId) ?? user.username } });
  });

  /** A challenge for a person's own device to sign: this node, a nonce, now (docs/PLAN-WORLD-MODEL.md §10.5). */
  auth.post('/challenge', (c) => {
    const at = Date.now();
    sweep(at);
    if (challenges.size >= 1000) throw new ApiError('unavailable', 'Too many sign-ins at once: try again in a moment');
    const challenge = newChallenge(family.nodeId(), new Date(at).toISOString());
    challenges.set(challenge.nonce, challenge);
    return c.json(challenge);
  });

  /** Signed in by a key a member holds: the challenge this node gave, answered once, while young. No password crosses. */
  auth.post('/key', async (c) => {
    const { trust } = access(c);
    const signIn = (await body(c, z.object({ person: z.string().max(40), keyId: z.string().max(60), signature: z.string().max(200), challenge: z.object({ node: z.string().max(40), nonce: z.string().max(60), issuedAt: z.string().max(40) }).strict() }).strict())) as SignIn;
    const given = challenges.get(signIn.challenge.nonce);
    challenges.delete(signIn.challenge.nonce);
    const holder = family.keyHolder(signIn.keyId);
    const refused = !given ? 'That is not a challenge this node gave, or it was answered already' : holder?.personId !== signIn.person ? 'That key is not one this family knows for them' : checkSignIn(signIn, { node: given.node, nonce: given.nonce, now: Date.now(), maxAgeMs: CHALLENGE_MS, key: holder.publicJwk });
    if (refused) {
      audit.record({ at: now(), kind: 'auth.key-failed', actor: actor('person', family.nameOf(signIn.person) ?? 'someone', signIn.person), summary: `A sign-in by key was refused: ${refused}`, detail: { clientIp: trust.clientIp } });
      throw new ApiError('signed-out', refused);
    }
    accounts.endSession(getCookie(c, SESSION_COOKIE));
    const { token } = accounts.createSession({ personId: signIn.person, id: null }, trust.clientIp, c.req.header('user-agent') ?? null);
    writeCookie(c, token);
    const name = family.nameOf(signIn.person) ?? 'someone';
    audit.record({ at: now(), kind: 'auth.login', actor: actor('person', name, signIn.person), resourceKind: 'person', resource: signIn.person, summary: `${name} signed in with their device`, detail: { clientIp: trust.clientIp, key: signIn.keyId } });
    return c.json({ user: { id: signIn.person, username: name } });
  });

  /**
   * A login's person claimed by an app's account (docs/PLAN-WORLD-MODEL.md
   * §10.4): someone signed in with their password shows who they are — their
   * chain — and from then on the family knows them by it, their logins and
   * sessions with it. Only a person with no key of their own yet is claimed.
   */
  auth.post('/claim', async (c) => {
    const signed = requireSigned(c);
    const { chain } = await body(c, z.object({ chain: z.array(z.record(z.string(), z.unknown())).min(1).max(1000) }).strict());
    let person: PersonView;
    try {
      person = family.claim(signed.personId, chain as unknown as Statement[]);
    } catch (error) {
      throw new ApiError('invalid', (error as Error).message);
    }
    accounts.relinkPerson(signed.personId, person.id);
    audit.record({ at: now(), kind: 'person.claimed', actor: actor('person', person.name, person.id), resourceKind: 'person', resource: person.id, summary: `${signed.name} is ${person.name} now, by their own account`, detail: { was: signed.personId } });
    return c.json({ user: { id: person.id, username: person.shownAs } });
  });

  auth.post('/logout', (c) => {
    const { signed } = access(c);
    accounts.endSession(getCookie(c, SESSION_COOKIE));
    clearCookie(c);
    if (signed) audit.record({ at: now(), kind: 'auth.logout', actor: actor('person', signed.name, signed.personId), resourceKind: 'person', resource: signed.personId, summary: `${signed.name} logged out` });
    return c.json({ ok: true });
  });

  /** Your own password. Needs the current one: a borrowed, unlocked browser should not be enough. */
  auth.post('/password', async (c) => {
    const user = requireUser(c);
    const { current, next: password } = await body(c, z.object({ current: yourPassword, next: z.string().min(1).max(256) }));
    const refused = await confirmIdentity(c, user, current);
    if (refused) return refused;
    await accounts.setPassword(user.id, password, getCookie(c, SESSION_COOKIE)).catch(rethrow);
    audit.record({ at: now(), kind: 'user.password', actor: actor('person', user.username, user.personId), resourceKind: 'person', resource: user.personId, summary: `${user.username} changed their password; their other sessions were signed out` });
    return c.json({ ok: true });
  });

  const users = new Hono();

  users.get('/', (c) => {
    requireSigned(c);
    return c.json({ users: accounts.listUsers() });
  });

  users.post('/', async (c) => {
    const signedIn = requireUser(c);
    const { username, password, yourPassword: confirmation } = await body(c, credentials.extend({ yourPassword }));
    const refused = await confirmIdentity(c, signedIn, confirmation);
    if (refused) return refused;
    const problem = credentialProblem(username, password);
    if (problem) throw new ApiError('invalid', problem);
    if (accounts.findUserByName(username)) throw new ApiError('invalid', `There is already a user called ${username}`);
    const user = await accounts.createUser(username, password, signedIn.username, family.newPerson(username)).catch(rethrow);
    audit.record({ at: now(), kind: 'user.created', actor: actor('person', signedIn.username, signedIn.personId), resourceKind: 'person', resource: user.personId, summary: `${signedIn.username} added ${user.username}` });
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
    // The person goes from the family with their last login; their own devices' sessions end.
    if (!accounts.listUsers().some((each) => each.personId === target.personId)) {
      family.leave(target.personId);
      accounts.endPersonSessions(target.personId);
      forgetNodesOf(target.personId);
    }
    if (target.id === signedIn.id) clearCookie(c);
    audit.record({ at: now(), kind: 'user.removed', actor: actor('person', signedIn.username, signedIn.personId), resourceKind: 'person', resource: target.personId, summary: `${signedIn.username} removed ${target.username}` });
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
    audit.record({ at: now(), kind: 'user.password', actor: actor('person', signedIn.username, signedIn.personId), resourceKind: 'person', resource: target.personId, summary: `${signedIn.username} set a new password for ${target.username}; their sessions were signed out` });
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

  return { gate, forgery, auth, users, access, requireUser, requireSigned, confirm };
}

/** Account problems are the caller's to fix, so they are refusals with the reason — not failures. */
function rethrow(error: unknown): never {
  if (error instanceof AccountError) throw new ApiError('invalid', error.message);
  throw error;
}
