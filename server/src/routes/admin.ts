import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { RESET_SECRET_MIN, resetSecret, resetSecretPath, secretMatches } from '../admin/reset.ts';
import { LoginLimiter, limiterKeys } from '../auth/limiter.ts';
import type { createAuth } from '../auth/routes.ts';
import { audit, recentAudit, resetDatabase } from '../history/db.ts';
import { body, type AppDeps } from './shared.ts';

/** Erasing everything, and the audit timeline. */
export function adminRoutes(
  { catalog, sessions, sampler }: AppDeps,
  accounts: ReturnType<typeof createAuth>
): Hono {
  const admin = new Hono();

  /** Wrong reset passphrases, counted apart from logins: a typo here should not lock anyone out. */
  const resetGuesses = new LoginLimiter();

  /**
   * Whether this server will accept a reset at all. The app asks before
   * offering the control, so nobody sees a button that cannot work. It reports
   * only *that* a secret exists, never any part of it.
   */
  admin.get('/admin/reset', async (c) => c.json({ available: (await resetSecret()) !== null, secretFile: resetSecretPath() }));

  /**
   * Empties the database.
   *
   * Every device, every sample, every connection and its secrets, every link
   * and the whole audit timeline. Accounts stay, so the
   * server is never left unclaimed. It cannot be undone from here.
   *
   * Needs a signed-in account *and* a passphrase kept in a file on the server:
   * a stolen session alone should not be enough. Anyone who can edit that file
   * could delete the database directly, so the passphrase is not a boundary
   * against them — it is there so that this takes more than an account.
   */
  admin.post('/admin/reset', async (c) => {
    const who = accounts.requireUser(c).username;
    const expected = await resetSecret();
    if (!expected) {
      throw new HTTPException(404, {
        message: `Resetting is not enabled. Write a passphrase of at least ${RESET_SECRET_MIN} characters to ${resetSecretPath()} on the server to enable it.`,
      });
    }

    // Guessing is counted, by account and by address, like a login: a wrong
    // passphrase must cost something on the one route that erases everything.
    const { trust } = accounts.access(c);
    const keys = limiterKeys(trust.clientIp, who, trust.onHomeNetwork);
    const wait = resetGuesses.wait(keys);
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return c.json({ error: `Too many wrong passphrases. Try again in ${Math.ceil(wait / 60_000)} min.` }, 429);
    }

    const { secret } = await body(c, z.object({ secret: z.string().max(1024) }));
    if (!secretMatches(secret, expected)) {
      resetGuesses.failed(keys);
      audit({ at: new Date().toISOString(), kind: 'database.reset-refused', actor: who, summary: `${who} gave a wrong reset passphrase`, detail: { clientIp: trust.clientIp } });
      // Deliberately says nothing about length or how close it was.
      throw new HTTPException(403, { message: 'That is not the reset passphrase' });
    }
    resetGuesses.succeeded(keys);

    /*
      Order matters. Sessions are closed first so nothing is mid-poll against a
      device that is about to stop existing, and the sampler is stopped so it
      cannot write a row into the table being emptied.
    */
    sampler.stop();
    await sessions.closeAll();

    const { tables, rows } = resetDatabase();

    // The first entry in the new timeline, written after the wipe on purpose.
    audit({ at: new Date().toISOString(), kind: 'database.reset', actor: who, summary: `The database was reset: ${rows} rows across ${tables.length} tables`, detail: { tables } });
    console.log(`[admin] database reset — ${rows} rows across ${tables.length} tables`);

    // Back to the state a fresh install boots into: no devices, so no sessions.
    await sessions.sync(catalog.list());
    sampler.start();

    return c.json({ ok: true, tables, rows });
  });

  admin.get('/audit', (c) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(1000).default(100) })
      .parse({ limit: c.req.query('limit') ?? 100 });
    return c.json(recentAudit(limit));
  });

  return admin;
}
