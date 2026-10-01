import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { configJsonSchema, writeConfig } from '@kraftverk/config';
import { Confirmations, subjectOf } from '@kraftverk/gateway';

import { actorOf } from '../auth/routes.ts';
import { plans } from '../automations/plans.ts';
import { exportConfig, serverVocabulary } from '../config/export.ts';
import { applyImport, ImportError, keptPlan, planImport, type ImportDeps } from '../config/import.ts';
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
  const { checked } = plans({ catalog: deps.catalog, sessions: deps.sessions, library: deps.library, engine: deps.engine, automations: deps.automations });
  const importing: ImportDeps = { ...deps, checked };
  /** A yes to what an import sets acting or takes away: a token bound to the plan, what is chosen, and the person, once. */
  const confirming = new Confirmations();

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

  /**
   * What importing a file would do — nothing yet done: its problems with their
   * lines, what becomes of each device, link, automation and home value, and
   * what it still needs. `replace`: what the file does not have is removed.
   */
  api.post('/config/plan', async (c) => {
    const input = await body(c, z.object({ text: z.string().min(1).max(2_000_000), mode: z.enum(['merge', 'replace']).default('merge'), passphrase: z.string().max(200).optional() }).strict());
    return c.json(planImport(importing, input.text, { mode: input.mode, passphrase: input.passphrase, by: actorOf(c) }));
  });

  /**
   * Applies a plan with its answers — secrets it did not carry, a device of
   * yours for each role naming one you do not have, only some of it — in one
   * transaction. What it sets acting on its own, or removes, is confirmed: a
   * 409 with `needsConfirmation`, sent back as `confirmation`.
   */
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
    const by = actorOf(c);
    const plan = keptPlan(input.plan, by);
    if (!plan) throw new HTTPException(404, { message: 'That plan has gone: read the file again' });
    // What it asks a yes to is asked whatever part of it is applied: a yes is not narrowed by the person's own choice of what to leave out.
    const asked = plan.needs.confirm;
    const subject = subjectOf({ plan: input.plan, include: input.include ?? null, by });
    if (asked.length && !confirming.accept(input.confirmation, subject)) {
      return c.json({ error: asked.join('. '), needsConfirmation: confirming.ask(subject) }, 409);
    }
    try {
      const applied = await applyImport(importing, input.plan, by, { include: input.include, secrets: input.secrets, rebind: input.rebind });
      audit({
        at: new Date().toISOString(),
        kind: 'config.imported',
        actor: by,
        summary: `Imported a configuration: ${[
          applied.devices.added.length && `${applied.devices.added.length} devices added`,
          applied.devices.changed.length && `${applied.devices.changed.length} changed`,
          applied.devices.removed.length && `${applied.devices.removed.length} removed`,
          applied.automations.added.length && `${applied.automations.added.length} automations added`,
          applied.automations.changed.length && `${applied.automations.changed.length} changed`,
          applied.automations.removed.length && `${applied.automations.removed.length} deleted`,
        ]
          .filter(Boolean)
          .join(', ') || 'nothing changed'}`,
        detail: applied,
      });
      deps.bus.publish({ kind: 'changed', deviceId: null });
      for (const key of [...applied.automations.added, ...applied.automations.changed]) {
        const automation = deps.automations.byKey(key);
        if (automation) deps.bus.publish({ kind: 'automation', automationId: automation.id });
      }
      return c.json(applied);
    } catch (error) {
      if (error instanceof ImportError) return c.json({ error: error.message, problems: error.problems }, error.status);
      return c.json({ error: (error as Error).message, problems: [] }, 400);
    }
  });

  /** The configuration kept beside the database: where, when it was last written, and what restoring it last did. */
  api.get('/config/snapshot', (c) => c.json({ path: deps.snapshot?.path ?? null, writtenAt: deps.snapshot?.writtenAt ?? null, restored: deps.snapshot?.restored ?? null }));

  return api;
}
