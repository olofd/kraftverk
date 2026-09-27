/**
 * Slows down guessing.
 *
 * Counted twice — per client address and per username — because the two
 * attacks look different: one machine trying many names, and many machines
 * trying one. Five failures are free; after that each one locks the key for
 * twice as long as the last, from a minute up to fifteen. A success clears both.
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

/** The two keys a login attempt is counted under. */
export const limiterKeys = (clientIp: string | null, username: string) => [
  `ip:${clientIp ?? 'unknown'}`,
  `user:${username.toLowerCase()}`,
];
