import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { PASSWORD_MIN } from '@kraftverk/api-contract';
import type { SqlDatabase } from '@kraftverk/store';

/**
 * Accounts and their sign-in sessions, in the server's own database: the
 * people who may use this node's HTTP entrance.
 *
 * Small on purpose. Every account is an administrator; a session is a random
 * token in an httpOnly cookie, stored here only as its hash; passwords are
 * argon2id, which Bun has built in. There is nothing here a person would want
 * to configure, and nothing an attacker would be glad to find.
 */

export type User = {
  id: string;
  username: string;
  createdAt: string;
  createdBy: string | null;
  lastLoginAt: string | null;
};

type Session = {
  user: User;
  expiresAt: string;
  /** The expiry just moved, so the cookie carrying it should be sent again. */
  renewed: boolean;
};

/** How long a session lasts without use. Using it pushes the end back. */
export const SESSION_LIFETIME_MS = 30 * 86_400_000;

/** Renewed at most this often, so a busy dashboard is not a database write per poll. */
const RENEW_AFTER_MS = 3_600_000;

const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;

const PASSWORD_MAX = 256;

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  created_by: string | null;
  last_login_at: string | null;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  createdAt: row.created_at,
  createdBy: row.created_by,
  lastLoginAt: row.last_login_at,
});

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * At most two password hashes at once.
 *
 * argon2id is deliberately expensive — 64 MB and tens of milliseconds each —
 * which is what makes guessing slow. Unbounded, it also makes a burst of
 * login attempts a way to exhaust a small NAS's memory. Queued instead: a
 * flood gets slower, and the server stays up.
 */
const HASH_SLOTS = 2;

let hashesRunning = 0;

const hashQueue: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (hashesRunning >= HASH_SLOTS) await new Promise<void>((resolve) => hashQueue.push(resolve));
  hashesRunning++;
  try {
    return await work();
  } finally {
    hashesRunning--;
    hashQueue.shift()?.();
  }
}

const hashPassword = (password: string) => slot(() => Bun.password.hash(password, { algorithm: 'argon2id' }));

const checkPassword = (password: string, hash: string) =>
  slot(() => Bun.password.verify(password, hash)).catch(() => false);

export class AccountError extends Error {}

/** Why a proposed username or password is not acceptable, or null. */
function credentialProblem(username: string, password: string): string | null {
  if (!USERNAME.test(username)) {
    return 'A username is 1–64 letters, digits, dots, dashes, underscores or @';
  }
  if (password.length < PASSWORD_MIN) {
    return `A password needs at least ${PASSWORD_MIN} characters — this login may be all that stands between the internet and your devices`;
  }
  if (password.length > PASSWORD_MAX) return `A password can be at most ${PASSWORD_MAX} characters`;
  return null;
}

export class Accounts {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  countUsers(): number {
    return this.#db.query<{ n: number }, []>('SELECT COUNT(*) n FROM users').get()?.n ?? 0;
  }

  listUsers(): User[] {
    return this.#db.query<UserRow, []>('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(toUser);
  }

  getUser(id: string): User | null {
    const row = this.#db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?').get(id);
    return row ? toUser(row) : null;
  }

  async createUser(username: string, password: string, createdBy: string | null): Promise<User> {
    const problem = credentialProblem(username, password);
    if (problem) throw new AccountError(problem);
    if (this.#db.query('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new AccountError(`There is already a user called ${username}`);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const hash = await hashPassword(password);
    try {
      this.#db
        .query(
          `INSERT INTO users (id, username, password_hash, created_at, created_by, password_changed_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, username, hash, now, createdBy, now);
    } catch (error) {
      // The same name added twice at once: both passed the check above while
      // the first was still hashing.
      if (String(error).includes('UNIQUE')) throw new AccountError(`There is already a user called ${username}`);
      throw error;
    }
    return this.getUser(id)!;
  }

  /**
   * Creates the first account — and only the first.
   *
   * The count and the insert happen in one transaction, so two browsers racing
   * through the setup screen cannot both become the first administrator.
   */
  async createFirstUser(username: string, password: string): Promise<User> {
    const problem = credentialProblem(username, password);
    if (problem) throw new AccountError(problem);
    // Hashed before the transaction: it is slow, and a transaction must not be.
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    const id = randomUUID();

    const created = this.#db.transaction(() => {
      if (this.countUsers() > 0) return false;
      this.#db
        .query(
          `INSERT INTO users (id, username, password_hash, created_at, created_by, password_changed_at)
           VALUES (?, ?, ?, ?, NULL, ?)`
        )
        .run(id, username, hash, now, now);
      return true;
    })();

    if (!created) throw new AccountError('This server already has an administrator. Log in instead.');
    return this.getUser(id)!;
  }

  /**
   * A hash of nothing, verified against when the username does not exist, so a
   * wrong name takes as long to refuse as a wrong password — and the response
   * time does not reveal which names are accounts.
   */
  #decoy: Promise<string> | null = null;

  async verifyLogin(username: string, password: string): Promise<User | null> {
    const row = this.#db.query<UserRow, [string]>('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) {
      this.#decoy ??= hashPassword(randomBytes(16).toString('hex'));
      await checkPassword(password, await this.#decoy);
      return null;
    }
    const ok = await checkPassword(password, row.password_hash);
    if (!ok) return null;
    this.#db.query('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return toUser({ ...row, last_login_at: new Date().toISOString() });
  }

  /** Whether this is the account's password — to confirm a change, which is not a login. */
  async passwordMatches(userId: string, password: string): Promise<boolean> {
    const row = this.#db.query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?').get(userId);
    return row ? checkPassword(password, row.password_hash) : false;
  }

  /**
   * Sets a password, and signs the account out everywhere else.
   *
   * A password is changed because the old one may be known to someone; leaving
   * their sessions running would make the change decorative.
   */
  async setPassword(userId: string, password: string, keepSessionToken?: string): Promise<void> {
    const user = this.getUser(userId);
    if (!user) throw new AccountError('No such user');
    const problem = credentialProblem(user.username, password);
    if (problem) throw new AccountError(problem);

    const hash = await hashPassword(password);
    this.#db
      .query('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
      .run(hash, new Date().toISOString(), userId);

    const keep = keepSessionToken ? hashToken(keepSessionToken) : '';
    this.#db.query('DELETE FROM login_session WHERE user_id = ? AND token_hash <> ?').run(userId, keep);
  }

  /** Deletes an account and its sessions. The last account cannot be deleted. */
  deleteUser(userId: string): void {
    // One transaction, so two removals at once cannot both pass the count check.
    this.#db.transaction(() => {
      if (!this.getUser(userId)) throw new AccountError('No such user');
      if (this.countUsers() <= 1) {
        throw new AccountError('The last account cannot be removed: nobody could then log in from outside the home network');
      }
      this.#db.query('DELETE FROM login_session WHERE user_id = ?').run(userId);
      // The nodes it joined from go with it, and every way they held: no other account may speak for them.
      this.#db.query('DELETE FROM node WHERE account_id = ? AND self = 0').run(userId);
      this.#db.query('DELETE FROM users WHERE id = ?').run(userId);
    })();
  }

  createSession(userId: string, clientIp: string | null, userAgent: string | null): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_LIFETIME_MS).toISOString();
    this.#db
      .query(
        `INSERT INTO login_session (token_hash, user_id, created_at, last_seen_at, expires_at, client_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(hashToken(token), userId, new Date(now).toISOString(), new Date(now).toISOString(), expiresAt, clientIp, userAgent?.slice(0, 300) ?? null);
    return { token, expiresAt };
  }

  /**
   * The session a token belongs to, renewed if it is due — or null.
   *
   * Expired sessions are deleted as they are found, and the rest in passing, so
   * the table does not keep every sign-in there has ever been.
   */
  readSession(token: string | undefined | null): Session | null {
    if (!token) return null;
    const hash = hashToken(token);
    const row = this.#db
      .query<{ user_id: string; last_seen_at: string; expires_at: string }, [string]>(
        'SELECT user_id, last_seen_at, expires_at FROM login_session WHERE token_hash = ?'
      )
      .get(hash);
    if (!row) return null;

    const now = Date.now();
    if (Date.parse(row.expires_at) <= now) {
      this.#db.query('DELETE FROM login_session WHERE token_hash = ?').run(hash);
      return null;
    }

    const user = this.getUser(row.user_id);
    if (!user) {
      this.#db.query('DELETE FROM login_session WHERE token_hash = ?').run(hash);
      return null;
    }

    if (now - Date.parse(row.last_seen_at) <= RENEW_AFTER_MS) {
      return { user, expiresAt: row.expires_at, renewed: false };
    }
    const expiresAt = new Date(now + SESSION_LIFETIME_MS).toISOString();
    this.#db
      .query('UPDATE login_session SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
      .run(new Date(now).toISOString(), expiresAt, hash);
    this.#db.query('DELETE FROM login_session WHERE expires_at <= ?').run(new Date(now).toISOString());
    return { user, expiresAt, renewed: true };
  }

  /**
   * Whether a session still stands — not ended, not expired, its account still
   * there — without renewing it: for something held open on it, a live stream,
   * that must close when the session does rather than keep it alive.
   */
  sessionAlive(token: string | undefined | null): boolean {
    if (!token) return false;
    const row = this.#db
      .query<{ user_id: string; expires_at: string }, [string]>('SELECT user_id, expires_at FROM login_session WHERE token_hash = ?')
      .get(hashToken(token));
    return row !== null && Date.parse(row.expires_at) > Date.now() && this.getUser(row.user_id) !== null;
  }

  endSession(token: string | undefined | null): void {
    if (token) this.#db.query('DELETE FROM login_session WHERE token_hash = ?').run(hashToken(token));
  }

  /** For sign-ins that did not go through `verifyLogin` — creating the first account signs you in. */
  markLoggedIn(userId: string): void {
    this.#db.query('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
  }

  /** Signs an account out everywhere. Returns how many sessions ended. */
  endAllSessions(userId: string): number {
    return this.#db.query('DELETE FROM login_session WHERE user_id = ?').run(userId).changes;
  }

  findUserByName(username: string): User | null {
    const row = this.#db.query<UserRow, [string]>('SELECT * FROM users WHERE username = ?').get(username);
    return row ? toUser(row) : null;
  }
}
