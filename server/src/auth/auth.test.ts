import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import { closeDb, db } from '../history/db.ts';
import { hostAllowed, hostGuard, hostName } from './host.ts';
import { LoginLimiter, MAX_ENTRIES } from './limiter.ts';
import { CLIENT_HEADER, createAuth, SESSION_COOKIE } from './routes.ts';
import {
  AccountError,
  countUsers,
  createFirstUser,
  createSession,
  createUser,
  deleteUser,
  readSession,
  setPassword,
  verifyLogin,
} from './store.ts';
import { assessTrust, CLIENT_IP_HEADER, EXPOSURE_HEADER, isPrivate, normaliseIp, ProxyDirectory } from './trust.ts';

/**
 * Accounts, sessions, and who may skip the login.
 *
 * Written the way an attacker would probe it: every path that should be
 * refused is tried, and the happy paths are there mostly to prove the refusals
 * are refusing for the right reason rather than because nothing works.
 */

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-auth-'));
const PROXY = '172.20.0.9';
const PASSWORD = 'correct horse battery staple';

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
});

afterAll(() => {
  closeDb();
  delete process.env.KRAFTVERK_DB;
  rmSync(dir, { recursive: true, force: true });
});

function emptyAccounts() {
  db().exec('DELETE FROM users; DELETE FROM sessions; DELETE FROM app_state;');
}

// --- deciding the home network -----------------------------------------------

describe('assessTrust', () => {
  const proxies = new Set([PROXY]);
  const judge = (socketIp: string | null, headers: Record<string, string> = {}) =>
    assessTrust({ socketIp, headers: new Headers(headers), proxies });

  test('a direct caller on a private address is on the home network', () => {
    for (const ip of ['192.168.50.58', '10.0.0.4', '172.16.1.1', '127.0.0.1', '::1', '::ffff:192.168.50.58', 'fd12::1']) {
      expect(judge(ip).onHomeNetwork).toBe(true);
    }
  });

  test('a direct caller on any other address is not', () => {
    for (const ip of ['203.0.113.50', '8.8.8.8', '100.64.1.1', '169.254.1.1', 'fe80::1', '2001:db8::1', '172.32.0.1']) {
      expect(judge(ip).onHomeNetwork).toBe(false);
    }
  });

  test('an unknown address is not trusted', () => {
    expect(judge(null).onHomeNetwork).toBe(false);
    expect(judge('not an ip').onHomeNetwork).toBe(false);
  });

  test('a private caller that came through a proxy nobody vouched for is not trusted', () => {
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host']) {
      expect(judge('192.168.50.1', { [header]: '203.0.113.50' }).onHomeNetwork).toBe(false);
    }
  });

  test('a caller cannot stamp itself as the home network', () => {
    expect(judge('192.168.50.58', { [EXPOSURE_HEADER]: 'lan' }).onHomeNetwork).toBe(false);
    expect(judge('203.0.113.50', { [EXPOSURE_HEADER]: 'lan' }).onHomeNetwork).toBe(false);
  });

  test('the web container is believed about its entrances, and only that way round', () => {
    expect(judge(PROXY, { [EXPOSURE_HEADER]: 'lan' }).onHomeNetwork).toBe(true);
    expect(judge(PROXY, { [EXPOSURE_HEADER]: 'public' }).onHomeNetwork).toBe(false);
    expect(judge(PROXY).onHomeNetwork).toBe(false);
    expect(judge(PROXY, { [EXPOSURE_HEADER]: 'LAN' }).onHomeNetwork).toBe(false);
  });

  test('the client address is the web container’s word only when it came from the web container', () => {
    expect(judge(PROXY, { [EXPOSURE_HEADER]: 'public', [CLIENT_IP_HEADER]: '203.0.113.50' }).clientIp).toBe('203.0.113.50');
    expect(judge('192.168.50.58', { [CLIENT_IP_HEADER]: '1.2.3.4' }).clientIp).toBe('192.168.50.58');
  });

  test('address helpers', () => {
    expect(normaliseIp('[::1]')).toBe('::1');
    expect(normaliseIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(normaliseIp('fe80::1%eth0')).toBe('fe80::1');
    expect(isPrivate('192.169.0.1')).toBe(false);
  });

  test('the proxy directory resolves names and takes literal addresses', async () => {
    const directory = new ProxyDirectory('localhost, 172.20.0.9 , not-a-host.invalid');
    await directory.refresh();
    expect(directory.addresses.has('172.20.0.9')).toBe(true);
    expect([...directory.addresses].some((ip) => ip === '127.0.0.1' || ip === '::1')).toBe(true);
  });
});

// --- DNS rebinding -------------------------------------------------------------

describe('host guard', () => {
  const configured = new Set(['home.example.net']);

  test('names that cannot be rebound are accepted', () => {
    for (const host of ['192.168.50.140:8080', '127.0.0.1', '[::1]:3333', 'localhost:3333', 'diskstation.local', 'kraftverk', 'kraftverk:3333', 'app.localhost']) {
      expect(hostAllowed(host, configured)).toBe(true);
    }
  });

  test('a configured public name is accepted', () => {
    expect(hostAllowed('home.example.net', configured)).toBe(true);
    expect(hostAllowed('HOME.example.net:443', configured)).toBe(true);
  });

  test('any other name is refused — a rebinding page arrives under its own name', () => {
    for (const host of ['evil.example', 'home.example.net.evil.example', '192.168.50.140.nip.io', 'sub.home.example.net', '', 'a:b:c']) {
      expect(hostAllowed(host, configured)).toBe(false);
    }
    expect(hostAllowed(undefined, configured)).toBe(false);
  });

  test('hostName strips ports and brackets', () => {
    expect(hostName('Example.COM:8080')).toBe('example.com');
    expect(hostName('[fd00::1]:443')).toBe('fd00::1');
  });
});

// --- slowing down guessing ------------------------------------------------------

describe('LoginLimiter', () => {
  test('five failures are free, then each locks for twice as long', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    const keys = ['user:olof'];
    for (let i = 0; i < 5; i++) limiter.failed(keys);
    expect(limiter.wait(keys)).toBe(0);
    limiter.failed(keys);
    expect(limiter.wait(keys)).toBe(60_000);
    now += 60_000;
    limiter.failed(keys);
    expect(limiter.wait(keys)).toBe(120_000);
  });

  test('never locks for more than fifteen minutes', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < 40; i++) limiter.failed(['k']);
    expect(limiter.wait(['k'])).toBe(15 * 60_000);
  });

  test('a success clears the count', () => {
    const limiter = new LoginLimiter(() => 0);
    for (let i = 0; i < 9; i++) limiter.failed(['k']);
    limiter.succeeded(['k']);
    expect(limiter.wait(['k'])).toBe(0);
  });

  test('a flood of made-up names cannot push out a real lock', () => {
    const now = 1_000;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < 6; i++) limiter.failed(['user:target']);
    for (let i = 0; i < MAX_ENTRIES + 500; i++) limiter.failed([`user:noise-${i}`]);
    expect(limiter.size).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(limiter.wait(['user:target'])).toBeGreaterThan(0);
  });
});

// --- accounts and sessions ------------------------------------------------------

describe('accounts', () => {
  beforeEach(emptyAccounts);

  test('only one of two racing setups becomes the first administrator', async () => {
    const results = await Promise.allSettled([createFirstUser('first', PASSWORD), createFirstUser('second', PASSWORD)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(countUsers()).toBe(1);
  });

  test('weak or malformed credentials are refused', async () => {
    await expect(createFirstUser('olof', 'short')).rejects.toBeInstanceOf(AccountError);
    await expect(createFirstUser('olof dahlbom', PASSWORD)).rejects.toBeInstanceOf(AccountError);
    await expect(createFirstUser('x'.repeat(65), PASSWORD)).rejects.toBeInstanceOf(AccountError);
    await expect(createFirstUser('olof', 'p'.repeat(257))).rejects.toBeInstanceOf(AccountError);
  });

  test('names are unique regardless of case', async () => {
    await createFirstUser('Olof', PASSWORD);
    await expect(createUser('olof', PASSWORD, 'Olof')).rejects.toBeInstanceOf(AccountError);
  });

  test('login checks the password, and a wrong name looks like a wrong password', async () => {
    await createFirstUser('olof', PASSWORD);
    expect((await verifyLogin('olof', PASSWORD))?.username).toBe('olof');
    expect(await verifyLogin('OLOF', PASSWORD)).not.toBeNull();
    expect(await verifyLogin('olof', `${PASSWORD}x`)).toBeNull();
    expect(await verifyLogin('nobody', PASSWORD)).toBeNull();
  });

  test('the password is stored only as an argon2id hash', async () => {
    await createFirstUser('olof', PASSWORD);
    const { password_hash } = db().query<{ password_hash: string }, []>('SELECT password_hash FROM users').get()!;
    expect(password_hash.startsWith('$argon2id$')).toBe(true);
    expect(password_hash).not.toContain(PASSWORD);
  });

  test('a session token is stored only as its hash', async () => {
    const user = await createFirstUser('olof', PASSWORD);
    const { token } = createSession(user.id, null, null);
    const stored = db().query<{ token_hash: string }, []>('SELECT token_hash FROM sessions').get()!;
    expect(stored.token_hash).not.toBe(token);
    expect(readSession(token)?.user.id).toBe(user.id);
    expect(readSession('forged')).toBeNull();
  });

  test('an expired session is refused and removed', async () => {
    const user = await createFirstUser('olof', PASSWORD);
    const { token } = createSession(user.id, null, null);
    db().query('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    expect(readSession(token)).toBeNull();
    expect(db().query<{ n: number }, []>('SELECT COUNT(*) n FROM sessions').get()!.n).toBe(0);
  });

  test('changing a password signs the account out everywhere else', async () => {
    const user = await createFirstUser('olof', PASSWORD);
    const here = createSession(user.id, null, null).token;
    const elsewhere = createSession(user.id, null, null).token;
    await setPassword(user.id, 'an entirely new passphrase', here);
    expect(readSession(here)).not.toBeNull();
    expect(readSession(elsewhere)).toBeNull();
    expect(await verifyLogin('olof', PASSWORD)).toBeNull();
  });

  test('the last account cannot be removed', async () => {
    const user = await createFirstUser('olof', PASSWORD);
    expect(() => deleteUser(user.id)).toThrow(AccountError);
    const other = await createUser('anna', PASSWORD, 'olof');
    deleteUser(other.id);
    expect(countUsers()).toBe(1);
  });
});

// --- the whole thing, as the server wires it ----------------------------------

describe('the gate', () => {
  let app: Hono;

  beforeAll(async () => {
    const proxies = new ProxyDirectory(PROXY);
    await proxies.refresh();
    const accounts = createAuth({ proxies, limiter: new LoginLimiter() });

    app = new Hono();
    app.use('/api/*', hostGuard(new Set(['home.example.net'])));
    const api = new Hono();
    api.use('*', accounts.forgery);
    api.use('*', accounts.gate);
    api.route('/auth', accounts.auth);
    api.route('/users', accounts.users);
    api.get('/health', (c) => c.json({ ok: true }));
    api.get('/devices', (c) => c.json({ devices: [] }));
    api.post('/grid/relay', (c) => c.json({ switched: true }));
    app.route('/api', api);
  });

  beforeEach(emptyAccounts);

  type Call = { from?: string; method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; host?: string };

  /** A request as the server would see it, from a given socket address. */
  async function call(path: string, { from = '192.168.50.58', method = 'GET', body, cookie, headers = {}, host = '192.168.50.140:3333' }: Call = {}) {
    const request = new Request(`http://${host}/api${path}`, {
      method,
      headers: {
        host,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { [CLIENT_HEADER]: 'test' } : {}),
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const response = await app.fetch(request, { requestIP: () => ({ address: from }) });
    const setCookie = response.headers.get('set-cookie') ?? '';
    const token = /kraftverk_session=([^;]*)/.exec(setCookie)?.[1] || undefined;
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null, setCookie, token };
  }

  const PUBLIC = '203.0.113.50';
  const viaPublicEntrance = { from: PROXY, headers: { [EXPOSURE_HEADER]: 'public', [CLIENT_IP_HEADER]: PUBLIC }, host: 'home.example.net' };
  const viaLanEntrance = { from: PROXY, headers: { [EXPOSURE_HEADER]: 'lan', [CLIENT_IP_HEADER]: '192.168.50.58' }, host: '192.168.50.140:8080' };

  test('the health check answers this machine and a session — not the network', async () => {
    expect((await call('/health', { from: '127.0.0.1', host: '127.0.0.1:3333' })).status).toBe(200);
    expect((await call('/health', { from: '::1', host: 'localhost:3333' })).status).toBe(200);
    expect((await call('/health', { from: PUBLIC })).status).toBe(401);
    expect((await call('/health')).status).toBe(401); // the LAN
    expect((await call('/health', viaLanEntrance)).status).toBe(401);
    // Loopback that came through a proxy is not this machine asking.
    expect((await call('/health', { from: '127.0.0.1', headers: { 'x-forwarded-for': PUBLIC } })).status).toBe(401);
    await createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    expect((await call('/health', { cookie: login.token })).status).toBe(200);
  });

  test('a fresh server cannot be claimed from the internet', async () => {
    const attempt = await call('/auth/setup', { ...viaPublicEntrance, method: 'POST', body: { username: 'mallory', password: PASSWORD } });
    expect(attempt.status).toBe(403);
    expect(countUsers()).toBe(0);
    const state = await call('/auth/state', viaPublicEntrance);
    expect(state.body).toMatchObject({ setupRequired: true, canSetup: false, onHomeNetwork: false });
    expect((await call('/devices', viaPublicEntrance)).body).toMatchObject({ loginRequired: true, setupRequired: true });
  });

  test('a fresh server is set up before it is used — the home network included', async () => {
    const before = await call('/devices');
    expect(before.status).toBe(401);
    expect(before.body).toMatchObject({ loginRequired: true, setupRequired: true });
    expect((await call('/auth/state')).body).toMatchObject({ onHomeNetwork: true, canSetup: true });
    // Reads as well as writes: nothing but the way in.
    expect((await call('/grid/relay', { method: 'POST', body: { on: false } })).status).toBe(401);
  });

  test('from the home network, the first account is created and signed in', async () => {
    const setup = await call('/auth/setup', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    expect(setup.status).toBe(201);
    expect(setup.setCookie).toContain('HttpOnly');
    expect(setup.setCookie).toContain('SameSite=Lax');
    expect(setup.setCookie).toContain('Path=/api');
    expect(setup.setCookie).not.toContain('Secure'); // plain http on the LAN
    const again = await call('/auth/setup', { method: 'POST', body: { username: 'second', password: PASSWORD } });
    expect(again.status).toBe(400);
  });

  test('the home network needs a login too — reads as well as writes, every way in', async () => {
    await createFirstUser('olof', PASSWORD);
    for (const via of [{}, viaLanEntrance, { from: '127.0.0.1', host: 'localhost:3333' }]) {
      expect((await call('/devices', via)).status).toBe(401);
      expect((await call('/grid/relay', { ...via, method: 'POST', body: { on: false } })).status).toBe(401);
    }
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    expect((await call('/devices', { cookie: login.token })).status).toBe(200);
  });

  test('the internet needs a login, however it dresses up', async () => {
    await createFirstUser('olof', PASSWORD);
    expect((await call('/devices', viaPublicEntrance)).status).toBe(401);
    expect((await call('/devices', { from: PUBLIC })).status).toBe(401);
    // Claims to be the LAN entrance, but did not come from the web container.
    expect((await call('/devices', { from: PUBLIC, headers: { [EXPOSURE_HEADER]: 'lan' } })).status).toBe(401);
    // A LAN address that came through some other proxy.
    expect((await call('/devices', { from: '192.168.50.1', headers: { 'x-forwarded-for': PUBLIC } })).status).toBe(401);
  });

  test('logging in from outside works, over a Secure cookie', async () => {
    await createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { ...viaPublicEntrance, method: 'POST', body: { username: 'olof', password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.setCookie).toContain('Secure');
    expect((await call('/devices', { ...viaPublicEntrance, cookie: login.token })).status).toBe(200);

    const logout = await call('/auth/logout', { ...viaPublicEntrance, method: 'POST', cookie: login.token });
    expect(logout.status).toBe(200);
    expect((await call('/devices', { ...viaPublicEntrance, cookie: login.token })).status).toBe(401);
  });

  test('a wrong password and an unknown name get the same answer', async () => {
    await createFirstUser('olof', PASSWORD);
    const wrong = await call('/auth/login', { ...viaPublicEntrance, method: 'POST', body: { username: 'olof', password: 'nope nope nope' } });
    const unknown = await call('/auth/login', { ...viaPublicEntrance, method: 'POST', body: { username: 'nobody', password: 'nope nope nope' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  test('guessing is slowed down', async () => {
    await createFirstUser('olof', PASSWORD);
    const attempt = () =>
      call('/auth/login', { ...viaPublicEntrance, headers: { ...viaPublicEntrance.headers, [CLIENT_IP_HEADER]: '203.0.113.7' }, method: 'POST', body: { username: 'guessme', password: 'wrong wrong wrong' } });
    // Five free failures; the sixth failure starts the lock, so the seventh try is refused unheard.
    for (let i = 0; i < 6; i++) expect((await attempt()).status).toBe(401);
    const refused = await attempt();
    expect(refused.status).toBe(429);
    expect(String(refused.body?.error)).toContain('Try again');
  });

  test('a write without the client header is refused, even with a session and on the LAN', async () => {
    await createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    const request = new Request('http://192.168.50.140:3333/api/grid/relay', {
      method: 'POST',
      headers: { host: '192.168.50.140:3333', 'content-type': 'text/plain', cookie: `${SESSION_COOKIE}=${login.token}` },
      body: '{"on":false}',
    });
    const response = await app.fetch(request, { requestIP: () => ({ address: '192.168.50.58' }) });
    expect(response.status).toBe(403);
  });

  test('a login is also a write, and cannot be forged from another site', async () => {
    await createFirstUser('olof', PASSWORD);
    const request = new Request('http://192.168.50.140:3333/api/auth/login', {
      method: 'POST',
      headers: { host: '192.168.50.140:3333', 'content-type': 'text/plain' },
      body: JSON.stringify({ username: 'olof', password: PASSWORD }),
    });
    expect((await app.fetch(request, { requestIP: () => ({ address: '192.168.50.58' }) })).status).toBe(403);
  });

  test('a DNS-rebinding page is refused before anything else happens', async () => {
    await createFirstUser('olof', PASSWORD);
    const rebound = await call('/devices', { host: 'evil.example' });
    expect(rebound.status).toBe(421);
    const claim = await call('/auth/setup', { host: 'evil.example:3333', method: 'POST', body: { username: 'x', password: PASSWORD } });
    expect(claim.status).toBe(421);
  });

  test('managing accounts needs a real login, even on the trusted home network', async () => {
    await createFirstUser('olof', PASSWORD);
    expect((await call('/users')).status).toBe(401);
    expect((await call('/users', { method: 'POST', body: { username: 'backdoor', password: PASSWORD } })).status).toBe(401);

    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    const added = await call('/users', { method: 'POST', cookie: login.token, body: { username: 'anna', password: PASSWORD } });
    expect(added.status).toBe(201);
    const list = await call('/users', { cookie: login.token });
    expect((list.body?.users as unknown[]).length).toBe(2);
    expect(JSON.stringify(list.body)).not.toContain('argon2');
  });

  test('changing your own password needs the current one', async () => {
    await createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    const wrong = await call('/auth/password', { method: 'POST', cookie: login.token, body: { current: 'not it at all', next: 'a brand new passphrase' } });
    expect(wrong.status).toBe(403);
    const right = await call('/auth/password', { method: 'POST', cookie: login.token, body: { current: PASSWORD, next: 'a brand new passphrase' } });
    expect(right.status).toBe(200);
  });
});
