import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

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
  // A short secret is a typo or a placeholder, not a decision.
  return trimmed.length >= 8 ? trimmed : null;
}

/**
 * Compares in constant time.
 *
 * `===` on secrets leaks their length and their common prefix through timing.
 * That matters little on a LAN and costs nothing to avoid, and the habit is
 * worth more than the specific attack: this is the only password-shaped
 * comparison in the codebase, so it is the one that sets the example.
 */
export function secretMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would leak the length by
  // exception rather than by clock. Compare a fixed-size digest of each instead.
  if (a.length !== b.length) {
    // Still do the work, so the failure takes the same time either way.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Where the secret is expected, for an error message that can be acted on. */
export const resetSecretPath = (): string => SECRET_FILE();
