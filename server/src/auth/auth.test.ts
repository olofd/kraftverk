import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import { AuditLog, resetDatabase } from '@kraftverk/store';

import { answerError } from '../app.ts';
import { openDatabase } from '../platform/database.ts';
import { hostAllowed, hostGuard, hostName } from './host.ts';
import { LoginLimiter, limiterKeys, MAX_ENTRIES } from './limiter.ts';
import { CLIENT_HEADER } from '@kraftverk/api-contract';
import { createAuth, SESSION_COOKIE } from './routes.ts';
import { AccountError, Accounts, HASH_WAITING } from './accounts.ts';
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

// A database of these tests' own, and the accounts in it.
const { database } = openDatabase(join(dir, 'test.db'));
const accounts = new Accounts(database);
const audit = new AuditLog(database);

afterAll(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

function emptyAccounts() {
  database.exec('DELETE FROM users; DELETE FROM login_session; DELETE FROM home_setting;');
}

// --- deciding the home network -----------------------------------------------

describe('assessTrust', () => {
  const proxies = new Set([PROXY]);
  const judge = (socketIp: string | null, headers: Record<string, string> = {}) =>
    assessTrust({ socketIp, headers: new Headers(headers), proxies });

  test('a direct caller on a private address is on the home network', () => {
    for (const ip of ['192.168.1.58', '10.0.0.4', '172.16.1.1', '127.0.0.1', '::1', '::ffff:192.168.1.58', 'fd12::1']) {
      expect(judge(ip).onHomeNetwork).toBe(true);
    }
  });

  test('a request addressed by a public name is never the home network, however it arrived', () => {
    // A reverse proxy pointed straight at the server, adding no forwarding headers.
    expect(judge('172.17.0.1', { host: 'home.example.net' }).onHomeNetwork).toBe(false);
    // …or at the web app's home-network entrance by mistake.
    expect(judge(PROXY, { host: 'home.example.net:8080', [EXPOSURE_HEADER]: 'lan' }).onHomeNetwork).toBe(false);
    // …or by the router's public address: port 8080 forwarded on the router,
    // reached by a scanner that adds nothing at all.
    for (const host of ['198.51.100.7:8080','203.0.113.9', '[2001:db8::5]:8080', '[::ffff:203.0.113.9]:8080']) {
      expect(judge('192.168.1.1', { host }).onHomeNetwork).toBe(false);
      expect(judge(PROXY, { host, [EXPOSURE_HEADER]: 'lan' }).onHomeNetwork).toBe(false);
    }
    // Local names and addresses are still home.
    for (const host of ['192.168.1.140:8080', '127.0.0.1:3333', '[::1]:3333', 'localhost:3333', 'diskstation.local', 'diskstation', '[fd12::1]:8080']) {
      expect(judge('192.168.1.58', { host }).onHomeNetwork).toBe(true);
      expect(judge(PROXY, { host, [EXPOSURE_HEADER]: 'lan' }).onHomeNetwork).toBe(true);
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
      expect(judge('192.168.1.1', { [header]: '203.0.113.50' }).onHomeNetwork).toBe(false);
    }
  });

  test('a caller cannot stamp itself as the home network', () => {
    expect(judge('192.168.1.58', { [EXPOSURE_HEADER]: 'lan' }).onHomeNetwork).toBe(false);
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
    expect(judge('192.168.1.58', { [CLIENT_IP_HEADER]: '1.2.3.4' }).clientIp).toBe('192.168.1.58');
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
    for (const host of ['192.168.1.140:8080', '127.0.0.1', '[::1]:3333', 'localhost:3333', 'diskstation.local', 'kraftverk', 'kraftverk:3333', 'app.localhost']) {
      expect(hostAllowed(host, configured)).toBe(true);
    }
  });

  test('a configured public name is accepted', () => {
    expect(hostAllowed('home.example.net', configured)).toBe(true);
    expect(hostAllowed('HOME.example.net:443', configured)).toBe(true);
  });

  test('any other name is refused — a rebinding page arrives under its own name', () => {
    for (const host of ['evil.example', 'home.example.net.evil.example', '192.168.1.140.nip.io', 'sub.home.example.net', '', 'a:b:c']) {
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
    const results = await Promise.allSettled([accounts.createFirstUser('first', PASSWORD), accounts.createFirstUser('second', PASSWORD)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(accounts.countUsers()).toBe(1);
  });

  test('weak or malformed credentials are refused', async () => {
    await expect(accounts.createFirstUser('olof', 'short')).rejects.toBeInstanceOf(AccountError);
    await expect(accounts.createFirstUser('olof dahlbom', PASSWORD)).rejects.toBeInstanceOf(AccountError);
    await expect(accounts.createFirstUser('x'.repeat(65), PASSWORD)).rejects.toBeInstanceOf(AccountError);
    await expect(accounts.createFirstUser('olof', 'p'.repeat(257))).rejects.toBeInstanceOf(AccountError);
  });

  test('a flood of passwords to check is told the server is busy, not queued without end', async () => {
    const user = await accounts.createFirstUser('olof', PASSWORD);
    const checks = await Promise.allSettled(Array.from({ length: HASH_WAITING + 20 }, () => accounts.passwordMatches(user.id, 'wrong wrong wrong')));
    const busy = checks.filter((check) => check.status === 'rejected');
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((check) => (check as PromiseRejectedResult).reason?.kind === 'unavailable')).toBe(true);
    // The rest were heard, and answered as a wrong password is.
    expect(checks.filter((check) => check.status === 'fulfilled').every((check) => (check as PromiseFulfilledResult<boolean>).value === false)).toBe(true);
  });

  test('names are unique regardless of case', async () => {
    await accounts.createFirstUser('Olof', PASSWORD);
    await expect(accounts.createUser('olof', PASSWORD, 'Olof')).rejects.toBeInstanceOf(AccountError);
  });

  test('login checks the password, and a wrong name looks like a wrong password', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    expect((await accounts.verifyLogin('olof', PASSWORD))?.username).toBe('olof');
    expect(await accounts.verifyLogin('OLOF', PASSWORD)).not.toBeNull();
    expect(await accounts.verifyLogin('olof', `${PASSWORD}x`)).toBeNull();
    expect(await accounts.verifyLogin('nobody', PASSWORD)).toBeNull();
  });

  test('the password is stored only as an argon2id hash', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const { password_hash } = database.query<{ password_hash: string }, []>('SELECT password_hash FROM users').get()!;
    expect(password_hash.startsWith('$argon2id$')).toBe(true);
    expect(password_hash).not.toContain(PASSWORD);
  });

  test('a session token is stored only as its hash', async () => {
    const user = await accounts.createFirstUser('olof', PASSWORD);
    const { token } = accounts.createSession(user.id, null, null);
    const stored = database.query<{ token_hash: string }, []>('SELECT token_hash FROM login_session').get()!;
    expect(stored.token_hash).not.toBe(token);
    expect(accounts.readSession(token)?.user.id).toBe(user.id);
    expect(accounts.readSession('forged')).toBeNull();
  });

  test('an expired session is refused and removed', async () => {
    const user = await accounts.createFirstUser('olof', PASSWORD);
    const { token } = accounts.createSession(user.id, null, null);
    database.query('UPDATE login_session SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    expect(accounts.readSession(token)).toBeNull();
    expect(database.query<{ n: number }, []>('SELECT COUNT(*) n FROM login_session').get()!.n).toBe(0);
  });

  test('changing a password signs the account out everywhere else', async () => {
    const user = await accounts.createFirstUser('olof', PASSWORD);
    const here = accounts.createSession(user.id, null, null).token;
    const elsewhere = accounts.createSession(user.id, null, null).token;
    await accounts.setPassword(user.id, 'an entirely new passphrase', here);
    expect(accounts.readSession(here)).not.toBeNull();
    expect(accounts.readSession(elsewhere)).toBeNull();
    expect(await accounts.verifyLogin('olof', PASSWORD)).toBeNull();
  });

  test('the last account cannot be removed', async () => {
    const user = await accounts.createFirstUser('olof', PASSWORD);
    expect(() => accounts.deleteUser(user.id)).toThrow(AccountError);
    const other = await accounts.createUser('anna', PASSWORD, 'olof');
    accounts.deleteUser(other.id);
    expect(accounts.countUsers()).toBe(1);
  });
});

// --- the whole thing, as the server wires it ----------------------------------

describe('the gate', () => {
  let app: Hono;

  beforeAll(async () => {
    const proxies = new ProxyDirectory(PROXY);
    await proxies.refresh();
    const auth = createAuth({ proxies, accounts, audit, limiter: new LoginLimiter() });

    app = new Hono();
    app.use('/api/*', hostGuard(new Set(['home.example.net'])));
    const api = new Hono();
    api.use('*', auth.forgery);
    api.use('*', auth.gate);
    api.route('/auth', auth.auth);
    api.route('/users', auth.users);
    api.get('/health', (c) => c.json({ ok: true }));
    api.get('/devices', (c) => c.json({ devices: [] }));
    api.post('/grid/relay', (c) => c.json({ switched: true }));
    app.route('/api', api);
    app.onError(answerError);
  });

  beforeEach(emptyAccounts);

  type Call = { from?: string; method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; host?: string };

  /** A request as the server would see it, from a given socket address. */
  async function call(path: string, { from = '192.168.1.58', method = 'GET', body, cookie, headers = {}, host = '192.168.1.140:3333' }: Call = {}) {
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
  const viaLanEntrance = { from: PROXY, headers: { [EXPOSURE_HEADER]: 'lan', [CLIENT_IP_HEADER]: '192.168.1.58' }, host: '192.168.1.140:8080' };

  test('the health check answers this machine and a session — not the network', async () => {
    expect((await call('/health', { from: '127.0.0.1', host: '127.0.0.1:3333' })).status).toBe(200);
    expect((await call('/health', { from: '::1', host: 'localhost:3333' })).status).toBe(200);
    expect((await call('/health', { from: PUBLIC })).status).toBe(401);
    expect((await call('/health')).status).toBe(401); // the LAN
    expect((await call('/health', viaLanEntrance)).status).toBe(401);
    // Loopback that came through a proxy is not this machine asking.
    expect((await call('/health', { from: '127.0.0.1', headers: { 'x-forwarded-for': PUBLIC } })).status).toBe(401);
    await accounts.createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    expect((await call('/health', { cookie: login.token })).status).toBe(200);
  });

  test('a fresh server cannot be claimed from the internet', async () => {
    const attempt = await call('/auth/setup', { ...viaPublicEntrance, method: 'POST', body: { username: 'mallory', password: PASSWORD } });
    expect(attempt.status).toBe(403);
    expect(accounts.countUsers()).toBe(0);
    const state = await call('/auth/state', viaPublicEntrance);
    expect(state.body).toMatchObject({ setupRequired: true, canSetup: false, onHomeNetwork: false });
    expect((await call('/devices', viaPublicEntrance)).body).toMatchObject({ loginRequired: true, setupRequired: true });
  });

  test('a fresh server cannot be claimed through the home-network entrance by its public name', async () => {
    const misrouted = { ...viaLanEntrance, host: 'home.example.net' };
    expect((await call('/auth/state', misrouted)).body).toMatchObject({ canSetup: false, onHomeNetwork: false });
    expect((await call('/auth/setup', { ...misrouted, method: 'POST', body: { username: 'x', password: PASSWORD } })).status).toBe(403);
    expect(accounts.countUsers()).toBe(0);
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
    expect(again.status).toBe(409);
    expect(accounts.countUsers()).toBe(1);
  });

  test('the home network needs a login too — reads as well as writes, every way in', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    for (const via of [{}, viaLanEntrance, { from: '127.0.0.1', host: 'localhost:3333' }]) {
      expect((await call('/devices', via)).status).toBe(401);
      expect((await call('/grid/relay', { ...via, method: 'POST', body: { on: false } })).status).toBe(401);
    }
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    expect((await call('/devices', { cookie: login.token })).status).toBe(200);
  });

  test('the internet needs a login, however it dresses up', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    expect((await call('/devices', viaPublicEntrance)).status).toBe(401);
    expect((await call('/devices', { from: PUBLIC })).status).toBe(401);
    // Claims to be the LAN entrance, but did not come from the web container.
    expect((await call('/devices', { from: PUBLIC, headers: { [EXPOSURE_HEADER]: 'lan' } })).status).toBe(401);
    // A LAN address that came through some other proxy.
    expect((await call('/devices', { from: '192.168.1.1', headers: { 'x-forwarded-for': PUBLIC } })).status).toBe(401);
  });

  test('logging in from outside works, over a Secure cookie', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { ...viaPublicEntrance, method: 'POST', body: { username: 'olof', password: PASSWORD } });
    expect(login.status).toBe(200);
    expect(login.setCookie).toContain('Secure');
    expect((await call('/devices', { ...viaPublicEntrance, cookie: login.token })).status).toBe(200);

    const logout = await call('/auth/logout', { ...viaPublicEntrance, method: 'POST', cookie: login.token });
    expect(logout.status).toBe(200);
    expect((await call('/devices', { ...viaPublicEntrance, cookie: login.token })).status).toBe(401);
  });

  test('a wrong password and an unknown name get the same answer', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const wrong = await call('/auth/login', { ...viaPublicEntrance, method: 'POST', body: { username: 'olof', password: 'nope nope nope' } });
    const unknown = await call('/auth/login', { ...viaPublicEntrance, method: 'POST', body: { username: 'nobody', password: 'nope nope nope' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  test('guessing is slowed down', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const attempt = () =>
      call('/auth/login', { ...viaPublicEntrance, headers: { ...viaPublicEntrance.headers, [CLIENT_IP_HEADER]: '203.0.113.7' }, method: 'POST', body: { username: 'guessme', password: 'wrong wrong wrong' } });
    // Five free failures; the sixth failure starts the lock, so the seventh try is refused unheard.
    for (let i = 0; i < 6; i++) expect((await attempt()).status).toBe(401);
    const refused = await attempt();
    expect(refused.status).toBe(429);
    expect(String(refused.body?.error)).toContain('Try again');
  });

  test('guesses sent all at once are counted as they come, not after their hashes', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const attempt = () =>
      call('/auth/login', { ...viaPublicEntrance, headers: { ...viaPublicEntrance.headers, [CLIENT_IP_HEADER]: '203.0.113.8' }, method: 'POST', body: { username: 'all-at-once', password: 'wrong wrong wrong' } });
    const answers = await Promise.all(Array.from({ length: 20 }, attempt));
    // As many heard as one after another would be — five free and the one that locks — and the rest refused unheard.
    expect(answers.filter((answer) => answer.status === 401)).toHaveLength(6);
    expect(answers.filter((answer) => answer.status === 429)).toHaveLength(14);
  });

  test('a write without the client header is refused, even with a session and on the LAN', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    const request = new Request('http://192.168.1.140:3333/api/grid/relay', {
      method: 'POST',
      headers: { host: '192.168.1.140:3333', 'content-type': 'text/plain', cookie: `${SESSION_COOKIE}=${login.token}` },
      body: '{"on":false}',
    });
    const response = await app.fetch(request, { requestIP: () => ({ address: '192.168.1.58' }) });
    expect(response.status).toBe(403);
  });

  test('a login is also a write, and cannot be forged from another site', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const request = new Request('http://192.168.1.140:3333/api/auth/login', {
      method: 'POST',
      headers: { host: '192.168.1.140:3333', 'content-type': 'text/plain' },
      body: JSON.stringify({ username: 'olof', password: PASSWORD }),
    });
    expect((await app.fetch(request, { requestIP: () => ({ address: '192.168.1.58' }) })).status).toBe(403);
  });

  test('a DNS-rebinding page is refused before anything else happens', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const rebound = await call('/devices', { host: 'evil.example' });
    expect(rebound.status).toBe(421);
    const claim = await call('/auth/setup', { host: 'evil.example:3333', method: 'POST', body: { username: 'x', password: PASSWORD } });
    expect(claim.status).toBe(421);
  });

  test('managing accounts needs a real login, even on the trusted home network', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    expect((await call('/users')).status).toBe(401);
    expect((await call('/users', { method: 'POST', body: { username: 'backdoor', password: PASSWORD } })).status).toBe(401);

    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    const added = await call('/users', { method: 'POST', cookie: login.token, body: { username: 'anna', password: PASSWORD, yourPassword: PASSWORD } });
    expect(added.status).toBe(201);
    const list = await call('/users', { cookie: login.token });
    expect((list.body?.users as unknown[]).length).toBe(2);
    expect(JSON.stringify(list.body)).not.toContain('argon2');
  });

  test('a borrowed session cannot add, remove or take over accounts', async () => {
    const olof = await accounts.createFirstUser('olof', PASSWORD);
    const anna = await accounts.createUser('anna', PASSWORD, 'olof');
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    const as = (path: string, method: string, body: Record<string, unknown>) => call(path, { method, cookie: login.token, body });

    // Without your own password, nothing.
    expect((await as('/users', 'POST', { username: 'backdoor', password: PASSWORD })).status).toBe(400);
    expect((await as('/users', 'POST', { username: 'backdoor', password: PASSWORD, yourPassword: 'a wrong guess' })).status).toBe(403);
    expect((await as(`/users/${anna.id}/password`, 'POST', { password: 'known to the thief now' })).status).toBe(400);
    expect((await as(`/users/${anna.id}`, 'DELETE', { yourPassword: 'a wrong guess' })).status).toBe(403);
    expect(accounts.countUsers()).toBe(2);

    // Your own password is never set here, even with the right confirmation:
    // that is /auth/password, which wants the current one.
    expect((await as(`/users/${olof.id}/password`, 'POST', { password: 'known to the thief now', yourPassword: PASSWORD })).status).toBe(400);

    // With it, all of them.
    expect((await as(`/users/${anna.id}/password`, 'POST', { password: 'a brand new passphrase', yourPassword: PASSWORD })).status).toBe(200);
    expect((await as(`/users/${anna.id}`, 'DELETE', { yourPassword: PASSWORD })).status).toBe(200);
    expect(accounts.countUsers()).toBe(1);
  });

  test('confirming with your password cannot be used to guess it', async () => {
    await accounts.createFirstUser('sam', PASSWORD);
    const login = await call('/auth/login', { from: '192.168.1.78', method: 'POST', body: { username: 'sam', password: PASSWORD } });
    const guess = (yourPassword: string) =>
      call('/users', { from: '192.168.1.78', method: 'POST', cookie: login.token, body: { username: 'backdoor', password: PASSWORD, yourPassword } });
    for (let i = 0; i < 6; i++) expect((await guess(`guess number ${i}`)).status).toBe(403);
    expect((await guess(PASSWORD)).status).toBe(429);
    expect(accounts.countUsers()).toBe(1);
  });

  test('a fresh server cannot be claimed through a port forwarded on the router', async () => {
    // A scanner reaching the home-network entrance by the router's public address.
    const forwarded = { ...viaLanEntrance, host: '198.51.100.7:8080', headers: { ...viaLanEntrance.headers, [CLIENT_IP_HEADER]: PUBLIC } };
    expect((await call('/auth/state', forwarded)).body).toMatchObject({ canSetup: false, onHomeNetwork: false });
    expect((await call('/auth/setup', { ...forwarded, method: 'POST', body: { username: 'x', password: PASSWORD } })).status).toBe(403);
    expect(accounts.countUsers()).toBe(0);
  });

  test('changing your own password needs the current one', async () => {
    await accounts.createFirstUser('olof', PASSWORD);
    const login = await call('/auth/login', { method: 'POST', body: { username: 'olof', password: PASSWORD } });
    const wrong = await call('/auth/password', { method: 'POST', cookie: login.token, body: { current: 'not it at all', next: 'a brand new passphrase' } });
    expect(wrong.status).toBe(403);
    const right = await call('/auth/password', { method: 'POST', cookie: login.token, body: { current: PASSWORD, next: 'a brand new passphrase' } });
    expect(right.status).toBe(200);
  });

  test('a borrowed session cannot guess the current password without limit', async () => {
    await accounts.createFirstUser('pat', PASSWORD);
    const from = '192.168.1.77';
    const login = await call('/auth/login', { from, method: 'POST', body: { username: 'pat', password: PASSWORD } });
    const guess = (current: string) => call('/auth/password', { from, method: 'POST', cookie: login.token, body: { current, next: 'a brand new passphrase' } });
    for (let i = 0; i < 6; i++) expect((await guess(`guess number ${i}`)).status).toBe(403);
    // Locked: even the right one is not heard.
    expect((await guess(PASSWORD)).status).toBe(429);
  });

  test('someone on the internet who knows your username cannot lock you out at home', async () => {
    await accounts.createFirstUser('kim', PASSWORD);
    const outside = (ip: string, password: string) =>
      call('/auth/login', { ...viaPublicEntrance, headers: { ...viaPublicEntrance.headers, [CLIENT_IP_HEADER]: ip }, method: 'POST', body: { username: 'kim', password } });
    for (let i = 0; i < 6; i++) expect((await outside('203.0.113.9', 'wrong wrong wrong')).status).toBe(401);
    // Outside, the name is locked — whichever address tries next.
    expect((await outside('203.0.113.10', PASSWORD)).status).toBe(429);
    // At home it is not.
    expect((await call('/auth/login', { from: '192.168.1.90', method: 'POST', body: { username: 'kim', password: PASSWORD } })).status).toBe(200);
  });
});

describe('limiterKeys', () => {
  test('an IPv6 caller is counted by its /64, however the address is written', () => {
    const [a] = limiterKeys('2001:db8:1:2::5', 'x', false);
    const [b] = limiterKeys('2001:0db8:0001:0002:ffff:1:2:3', 'x', false);
    const [c] = limiterKeys('2001:db8:1:3::5', 'x', false);
    expect(a).toBe('ip:2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(limiterKeys('::1', 'x', true)[0]).toBe('ip:0:0:0:0::/64');
    expect(limiterKeys('203.0.113.5', 'x', false)[0]).toBe('ip:203.0.113.5');
  });

  test('the username is counted apart at home and away', () => {
    expect(limiterKeys(null, 'Olof', true)[1]).not.toBe(limiterKeys(null, 'olof', false)[1]);
    expect(limiterKeys(null, 'Olof', false)[1]).toBe(limiterKeys(null, 'olof', false)[1]);
  });
});

describe('erasing everything', () => {
  beforeEach(emptyAccounts);

  test('keeps the accounts and their sessions, so the server is never left unclaimed', async () => {
    const user = await accounts.createFirstUser('olof', PASSWORD);
    const { token } = accounts.createSession(user.id, null, null);
    resetDatabase(database);
    expect(accounts.countUsers()).toBe(1);
    expect(accounts.readSession(token)?.user.username).toBe('olof');
  });
});
