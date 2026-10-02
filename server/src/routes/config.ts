import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { ConfigSnapshotView } from '@kraftverk/api-contract';

import { actorOf } from '../auth/routes.ts';
import { body, homeFor, type AppDeps } from './shared.ts';

/*
  Configuration (docs/CONFIG.md), over HTTP: the JSON Schema an editor checks
  a file against — open to whoever asks, as an editor cannot log in, and so
  with no key of anything you have in it — the vocabulary the app's own
  editor checks with, an export, an import's plan and its apply, and the copy
  kept beside the database. What each does is the hub's (`Configuration`).
*/

/** The schema's path: open, beside the way in (`auth/routes.ts`). */
export const SCHEMA_PATH = '/api/config/schema.json';

export function configRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  /** Open, as an editor cannot log in: it names nothing you have, so no one in particular asks for it. */
  api.get('/config/schema.json', (c) => {
    c.header('cache-control', 'no-cache');
    return c.json(deps.hub.configuration.schema());
  });

  api.get('/config/vocabulary', async (c) => c.json(await homeFor(deps, c).configuration.vocabulary()));

  api.post('/config/export', async (c) => {
    const input = await body(
      c,
      z
        .object({
          devices: z.array(z.string().min(1).max(63)).max(500).optional(),
          automations: z.array(z.string().min(1).max(63)).max(500).optional(),
          secrets: z.enum(['none', 'sealed', 'plain']).default('none'),
          passphrase: z.string().max(200).optional(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).configuration.export(input, { schemaUrl: `${new URL(c.req.url).origin}${SCHEMA_PATH}` }));
  });

  /** `restored`: the copy the last restore was made from, kept aside — to import again with its answers, when the restore could not do it all. */
  api.post('/config/plan', async (c) => {
    const input = await body(
      c,
      z
        .object({
          text: z.string().min(1).max(2_000_000).optional(),
          restored: z.literal(true).optional(),
          from: z.enum(['this-node', 'copy']).optional(),
          mode: z.enum(['merge', 'replace']).default('merge'),
          passphrase: z.string().max(200).optional(),
        })
        .strict()
        .refine((given) => [given.text, given.restored, given.from].filter((each) => each !== undefined).length === 1, 'A file’s text, the restored copy, or a home kept elsewhere: one of them')
    );
    if (input.restored) {
      const text = deps.snapshot?.restoredCopy() ?? null;
      if (text === null) throw new HTTPException(404, { message: 'There is no restored copy to import again' });
      // Its secrets are this server's own, sealed with its key: opened as only the server's own copy may be, not through the API.
      return c.json(await deps.hub.configuration.plan(text, { mode: input.mode, kept: true }, actorOf(c)));
    }
    // A home kept elsewhere is an app's: the home says it has none.
    if (input.from) return c.json(await homeFor(deps, c).configuration.plan({ from: input.from, mode: input.mode }));
    return c.json(await homeFor(deps, c).configuration.plan({ text: input.text!, mode: input.mode, passphrase: input.passphrase }));
  });

  /** What a home kept beside this one has, to bring in: an app's alone, so a server's says none. */
  api.get('/config/elsewhere', async (c) => c.json(await homeFor(deps, c).configuration.elsewhere()));

  api.post('/config/apply', async (c) => {
    const input = await body(
      c,
      z
        .object({
          plan: z.string().min(1).max(40),
          include: z.object({ devices: z.array(z.string().max(63)).max(500).optional(), automations: z.array(z.string().max(63)).max(500).optional() }).strict().optional(),
          secrets: z.record(z.string().max(200), z.string().min(1).max(4096)).optional(),
          rebind: z.record(z.string().max(200), z.string().min(1).max(200)).optional(),
          confirmation: z.string().max(64).optional(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).configuration.apply(input));
  });

  /** The configuration kept beside the database: where, when it was last written, and what restoring it last did. */
  api.get('/config/snapshot', (c) => c.json({ path: deps.snapshot?.path ?? null, writtenAt: deps.snapshot?.writtenAt ?? null, restored: deps.snapshot?.restored ?? null } satisfies ConfigSnapshotView));

  return api;
}
