import type { Context } from 'hono';

/**
 * Slows down guessing.
 *
 * Counted twice — per client address and per username — because the two
 * attacks look different: one machine trying many names, and many machines
 * trying one. Five failures are free; after that each one locks the key for
 * twice as long as the last, from a minute up to fifteen. A success clears both.
 * Checking your current password, to change it, is counted the same way: a
 * borrowed session must not be a way to guess it without limit.
 *
 * In memory, deliberately. A restart forgets the count, which costs an
 * attacker nothing they could not get by waiting, and keeps a login attempt
 * from being a database write.
 */

const FREE_FAILURES = 5;
const FIRST_LOCK_MS = 60_000;
const LONGEST_LOCK_MS = 15 * 60_000;
/** A key with no failure for this long is forgotten. */
const FORGET_AFTER_MS = 60 * 60_000;
/** Two keys per attempt; this is thousands of distinct attackers' worth. */
export const MAX_ENTRIES = 10_000;

type Entry = { failures: number; lockedUntil: number; lastFailure: number };

export class LoginLimiter {
  #entries = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  /** Milliseconds until any of these keys may try again; 0 if all may. */
  wait(keys: string[]): number {
    const now = this.now();
    this.#forget(now);
    return Math.max(0, ...keys.map((key) => (this.#entries.get(key)?.lockedUntil ?? 0) - now));
  }

  /**
   * The answer while any of these keys must wait: 429, saying `what` and for
   * how long, and `Retry-After`; null when all may try.
   */
  refuse(c: Context, keys: string[], what: string): Response | null {
    const wait = this.wait(keys);
    if (wait <= 0) return null;
    c.header('Retry-After', String(Math.ceil(wait / 1000)));
    return c.json({ error: `${what} Try again in ${Math.ceil(wait / 60_000)} min.` }, 429);
  }

  /**
   * Lets an attempt in, or answers 429 as `refuse` does. One let in is
   * counted as failed before its password is checked, and cleared by
   * `succeeded`: many sent at once are each counted, so they cannot all slip
   * past the lock while the first of them is still being hashed.
   */
  admit(c: Context, keys: string[], what: string): Response | null {
    const refused = this.refuse(c, keys, what);
    if (!refused) this.failed(keys);
    return refused;
  }

  failed(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const entry = this.#entries.get(key) ?? { failures: 0, lockedUntil: 0, lastFailure: 0 };
      entry.failures++;
      entry.lastFailure = now;
      const over = entry.failures - FREE_FAILURES;
      if (over > 0) entry.lockedUntil = now + Math.min(LONGEST_LOCK_MS, FIRST_LOCK_MS * 2 ** (over - 1));
      this.#entries.set(key, entry);
    }
    this.#cap(now);
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Keeps the table bounded without letting an attacker empty it.
   *
   * A flood of made-up names from many addresses would otherwise grow it
   * without limit — or, with a naive cap, push out the one lock that matters.
   * So unlocked entries go first, oldest first, and a lock is only ever
   * evicted when the table is nothing but locks, and then the one closest to
   * expiring anyway.
   */
  #cap(now: number): void {
    if (this.#entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= MAX_ENTRIES) return;
      if (entry.lockedUntil <= now) this.#entries.delete(key);
    }
    while (this.#entries.size > MAX_ENTRIES) {
      let soonest: string | null = null;
      let soonestAt = Infinity;
      for (const [key, entry] of this.#entries) {
        if (entry.lockedUntil < soonestAt) {
          soonest = key;
          soonestAt = entry.lockedUntil;
        }
      }
      if (soonest === null) return;
      this.#entries.delete(soonest);
    }
  }

  succeeded(keys: string[]): void {
    for (const key of keys) this.#entries.delete(key);
  }

  #forget(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastFailure > FORGET_AFTER_MS && entry.lockedUntil <= now) this.#entries.delete(key);
    }
  }
}

/**
 * The two keys a login attempt is counted under.
 *
 * The address is an IPv6 caller's /64, not the full address: one home
 * connection is handed a whole /64, so counting single addresses would give
 * every attacker eighteen quintillion fresh starts.
 *
 * The username is counted separately for the home network. Otherwise anyone
 * on the internet who knows your username could keep it locked, and lock you
 * out of your own server from your own sofa. Guessing from the home network is
 * still slowed, by its own count and by the address.
 */
export const limiterKeys = (clientIp: string | null, username: string, onHomeNetwork: boolean) => [
  `ip:${addressKey(clientIp)}`,
  `user${onHomeNetwork ? '@home' : ''}:${username.toLowerCase()}`,
];

function addressKey(ip: string | null): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  // Expand `::` so the first four groups are the /64 whatever the spelling.
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
