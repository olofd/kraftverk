import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The passphrase that authorises wiping the database.
 *
 * A file rather than an environment variable, so it can be rotated without
 * restarting the server and so it never appears in a process listing or a
 * `docker inspect`. It lives beside the database it protects, in the directory
 * that is already gitignored.
 *
 * **Absent means disabled.** Not "matches anything", not "matches the empty
 * string" — the route is simply not available, because a destructive endpoint
 * that unlocks itself when its key is missing is worse than no endpoint. The
 * same applies to a file that is empty or whitespace: somebody has created it
 * without deciding what the secret is, and that is not consent.
 */

const SECRET_FILE = () =>
  process.env.KRAFTVERK_RESET_SECRET_FILE ||
  resolve(import.meta.dirname, '../../data/reset-secret');

/** The configured secret, or null when the reset route should not exist. */
export async function resetSecret(): Promise<string | null> {
  const raw = await readFile(SECRET_FILE(), 'utf8').catch(() => null);
  if (raw === null) return null;

  const trimmed = raw.trim();
  // A short secret is a typo or a placeholder, not a decision — and it guards
  // the one thing here that cannot be undone.
  return trimmed.length >= RESET_SECRET_MIN ? trimmed : null;
}

export const RESET_SECRET_MIN = 16;

/**
 * Compares in constant time.
 *
 * `===` on secrets leaks their length and their common prefix through timing.
 * `timingSafeEqual` wants equal lengths, so it compares a digest of each: the
 * same size whatever was typed, which says nothing about the secret's length
 * either.
 */
export function secretMatches(supplied: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

/** Where the secret is expected, for an error message that can be acted on. */
export const resetSecretPath = (): string => SECRET_FILE();
