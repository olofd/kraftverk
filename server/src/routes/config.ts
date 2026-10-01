import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { configJsonSchema, writeConfig } from '@kraftverk/config';

import { actorOf } from '../auth/routes.ts';
import { exportConfig, serverVocabulary } from '../config/export.ts';
import { PASSPHRASE_MIN } from '../config/seal.ts';
import { audit } from '../history/db.ts';
import { body, type AppDeps } from './shared.ts';

/*
  Configuration (docs/CONFIG.md): the JSON Schema an editor checks a file
  against — open to whoever asks, as an editor cannot log in, and so with no
  key of anything you have in it — the vocabulary the app's own editor checks
  with, an export of what you have, and the snapshot kept beside the
  database.
*/

/** The schema's path: open, beside the way in (`auth/routes.ts`). */
export const SCHEMA_PATH = '/api/config/schema.json';

export function configRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  /** The installed types, their settings, ways and secrets — nothing you have. */
  api.get('/config/schema.json', (c) => {
    const { devices: _devices, automations: _automations, ...installed } = serverVocabulary(deps);
    c.header('cache-control', 'no-cache');
    return c.json(configJsonSchema({ ...installed, devices: [], automations: [] }));
  });

  /** What a configuration may name here — the installed types, and the keys of what you have: what the app's editor checks against. */
  api.get('/config/vocabulary', (c) => c.json(serverVocabulary(deps)));

  /**
   * What you have, as a configuration file: everything, or the devices and
   * automations chosen by key — and what could not go in. Secrets left out,
   * sealed with a passphrase, or in plain text where their owner allowed it.
   */
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
    if (input.secrets === 'sealed' && (input.passphrase ?? '').length < PASSPHRASE_MIN) {
      throw new HTTPException(400, { message: `A passphrase is at least ${PASSPHRASE_MIN} characters: an export travels` });
    }
    const exported = exportConfig(deps, { ...input, secrets: input.secrets });
    const origin = new URL(c.req.url).origin;
    const text = writeConfig(exported.document, {
      ...exported.context,
      schemaUrl: `${origin}${SCHEMA_PATH}`,
      heading: [`Exported from kraftverk, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, ...exported.notes.map((note) => `- ${note}`)].join('\n'),
    });
    if (input.secrets !== 'none') {
      audit({
        at: new Date().toISOString(),
        kind: 'config.exported',
        actor: actorOf(c),
        summary: `Exported the configuration with its secrets ${input.secrets === 'sealed' ? 'sealed with a passphrase' : 'in plain text'}`,
        detail: { devices: Object.keys(exported.document.devices), automations: Object.keys(exported.document.automations) },
      });
    }
    return c.json({ text, notes: exported.notes });
  });

  /** The configuration kept beside the database: where, and when it was last written. */
  api.get('/config/snapshot', (c) => c.json({ path: deps.snapshot?.path ?? null, writtenAt: deps.snapshot?.writtenAt ?? null }));

  return api;
}
