import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError, CONFIG_SCHEMA_PATH, type ConfigSnapshotView } from '@kraftverk/api-contract';
import { actor } from '@kraftverk/device-sdk';

import { usernameOf } from '../auth/routes.ts';
import { familyFor, type AppDeps, type ConfirmPassword } from './context.ts';
import { body } from './parse.ts';

/*
  Configuration (docs/CONFIG.md), over HTTP: the JSON Schema an editor checks
  a file against — open to whoever asks, as an editor cannot log in, and so
  with no key of anything you have in it — the vocabulary the app's own
  editor checks with, an export, an import's plan and its apply, and the copy
  kept beside the database. What each does is the hub's (`Configuration`).
*/

export function configurationRoutes(deps: AppDeps, confirm: ConfirmPassword): Hono {
  const api = new Hono();
  /** Open, as an editor cannot log in: it names nothing you have, so no one in particular asks for it. */
  api.get(CONFIG_SCHEMA_PATH, (c) => {
    c.header('cache-control', 'no-cache');
    return c.json(deps.hub.configuration.schema());
  });

  api.get('/config/vocabulary', async (c) => c.json(await familyFor(deps, c).configuration.vocabulary()));

  api.post('/config/export', async (c) => {
    const input = await body(
      c,
      z
        .object({
          devices: z.array(z.string().min(1).max(63)).max(500).optional(),
          automations: z.array(z.string().min(1).max(63)).max(500).optional(),
          secrets: z.enum(['none', 'sealed', 'plain']).default('none'),
          passphrase: z.string().max(200).optional(),
          yourPassword: z.string().max(256).optional(),
        })
        .strict()
    );
    /*
      Secrets leave — sealed with a passphrase the asker chose, which seals
      nothing from them, or plain — only for the account's own password: a
      borrowed session is not a way to carry off the keys to the house.
    */
    const { yourPassword, ...request } = input;
    if (request.secrets !== 'none') {
      const refused = await confirm(c, yourPassword);
      if (refused) return refused;
    }
    return c.json(await familyFor(deps, c).configuration.export(request, { schemaUrl: `${new URL(c.req.url).origin}/api${CONFIG_SCHEMA_PATH}` }));
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
      if (!deps.snapshot) throw new ApiError('not-found', 'There is no restored copy to import again');
      return c.json(await deps.snapshot.planAgain(input.mode, actor('person', usernameOf(c))));
    }
    // A home kept beside this one: where there is none, the home says so.
    if (input.from) return c.json(await familyFor(deps, c).configuration.plan({ from: input.from, mode: input.mode }));
    return c.json(await familyFor(deps, c).configuration.plan({ text: input.text!, mode: input.mode, passphrase: input.passphrase }));
  });

  /** What a home kept beside this one has, to bring in: where there is none, the home says so. */
  api.get('/config/elsewhere', async (c) => c.json(await familyFor(deps, c).configuration.elsewhere()));

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
    return c.json(await familyFor(deps, c).configuration.apply(input));
  });

  /** The configuration kept beside the database: where, when it was last written, and what restoring it last did. */
  api.get('/config/snapshot', (c) => c.json({ path: deps.snapshot?.path ?? null, writtenAt: deps.snapshot?.writtenAt ?? null, restored: deps.snapshot?.restored ?? null } satisfies ConfigSnapshotView));

  return api;
}
