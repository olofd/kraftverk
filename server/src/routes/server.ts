import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError, type VersionInfo } from '@kraftverk/api-contract';

import { LoginLimiter, limiterKeys } from '../auth/limiter.ts';
import type { createAuth } from '../auth/routes.ts';
import { SERVER } from '../config.ts';
import { RESET_SECRET_MIN, resetSecret, secretMatches } from '../platform/reset-secret.ts';
import type { AppDeps } from './context.ts';
import { body, query } from './parse.ts';

/**
 * What is the server's own, not the home's: whether it is up, what it is,
 * what it has said lately, and erasing the home it keeps.
 */
export function serverRoutes(deps: AppDeps, auth: ReturnType<typeof createAuth>): Hono {
  const { config, serverLog, startedAt } = deps;
  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true }));

  api.get('/version', (c) => {
    const info: VersionInfo = {
      ...SERVER,
      runtime: `bun ${Bun.version}`,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      readOnly: config.readOnly,
    };
    return c.json(info);
  });

  /**
   * What the server has said lately — the same lines as its console, which in
   * a container nobody is watching. `?level=warn` for problems only. The full
   * record is in daily files, named here, for a shell on the server.
   */
  api.get('/diagnostics/log', (c) => {
    const { limit, level } = query(
      c,
      z.object({
        limit: z.coerce.number().int().min(1).max(2000).default(500),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      })
    );
    return c.json({ dir: serverLog.dir, lines: serverLog.recent(limit, level) });
  });

  /** Wrong reset passphrases, counted apart from logins: a typo here should not lock anyone out. */
  const resetGuesses = new LoginLimiter();

  /**
   * Whether this server will accept a reset at all. The app asks before
   * offering the control, so nobody sees a button that cannot work. It reports
   * only *that* a secret exists, never any part of it.
   */
  api.get('/admin/reset', async (c) => c.json({ available: (await resetSecret(config.resetSecretFile)) !== null, secretFile: config.resetSecretFile }));

  /**
   * Empties the home: every device, every sample, every connection and its
   * secrets, every link and the whole timeline. Accounts stay, so the server
   * is never left unclaimed. It cannot be undone from here.
   *
   * Needs a signed-in account *and* a passphrase kept in a file on the server:
   * a stolen session alone should not be enough. Anyone who can edit that file
   * could delete the database directly, so the passphrase is not a boundary
   * against them — it is there so that this takes more than an account.
   */
  api.post('/admin/reset', async (c) => {
    const who = auth.requireUser(c).username;
    const expected = await resetSecret(config.resetSecretFile);
    if (!expected) throw new ApiError('not-found', `Resetting is not enabled. Write a passphrase of at least ${RESET_SECRET_MIN} characters to ${config.resetSecretFile} on the server to enable it.`);

    // Guessing is counted, by account and by address, like a login: a wrong
    // passphrase must cost something on the one route that erases everything.
    const { trust } = auth.access(c);
    const keys = limiterKeys(trust.clientIp, who, trust.onHomeNetwork);
    const tooMany = resetGuesses.refuse(c, keys, 'Too many wrong passphrases.');
    if (tooMany) return tooMany;

    const { secret } = await body(c, z.object({ secret: z.string().max(1024) }));
    if (!secretMatches(secret, expected)) {
      resetGuesses.failed(keys);
      deps.hub.audit.record({ at: new Date().toISOString(), kind: 'database.reset-refused', actor: who, summary: `${who} gave a wrong reset passphrase`, detail: { clientIp: trust.clientIp } });
      // Deliberately says nothing about length or how close it was.
      throw new ApiError('forbidden', 'That is not the reset passphrase');
    }
    resetGuesses.succeeded(keys);

    // What emptying the home stops and starts again is the home's.
    const { tables, rows } = await deps.hub.reset(who);
    console.log(`[admin] database reset — ${rows} rows across ${tables.length} tables`);
    return c.json({ ok: true, tables, rows });
  });

  return api;
}
