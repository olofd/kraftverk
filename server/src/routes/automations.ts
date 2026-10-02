import { Hono } from 'hono';
import { z } from 'zod';

import type { AutomationChanges } from '@kraftverk/api-contract';
import { AUTOMATION_MODES, type AutomationDraft, type Rule } from '@kraftverk/automation';
import { runLogCsv } from '@kraftverk/automation-engine';
import { automationId, fileNameOf, savedDeviceId } from '@kraftverk/device-sdk';
import { REHEARSAL_MAX_HOURS } from '@kraftverk/hub';

import { bindingsOf, homeFor, PART, type AppDeps } from './context.ts';
import { body, query } from './parse.ts';

/**
 * Automations (docs/AUTOMATIONS.md, docs/AUTOMATION-EDITOR.md) over HTTP:
 * what each route takes, checked, handed to the home
 * (`KraftverkApi.automations`), and its answer. Letting one act, or changing
 * one that acts, is refused with 409 and `needsConfirmation` until a person
 * says yes. A run's log is also a file to download, as a table.
 */

const roles = z.record(z.string().min(1).max(40), PART);
const starts = z.record(z.string().min(1).max(40), z.string().min(1).max(80));
/** A rule is checked by the language, not by its shape here: the home says everything wrong with it. */
const rule = z.record(z.string(), z.unknown());
/** Minutes between looks that keep things so, a day at most; null, never. */
const recheckMinutes = z.number().int().min(1).max(1440).nullable();
const draft = z.object({ rule, roles, starts }).strict();

/** What each role starts, its automations' ids as ids. */
const startsOf = (given: Record<string, string>): AutomationDraft['starts'] => Object.fromEntries(Object.entries(given).map(([role, id]) => [role, automationId(id)]));
/** A draft as the home takes it. */
const asDraft = (input: { rule: Record<string, unknown>; roles: Record<string, { device: string; part: string }>; starts: Record<string, string> }): AutomationDraft => ({
  rule: input.rule as unknown as Rule,
  roles: bindingsOf(input.roles),
  starts: startsOf(input.starts),
});

export function automationRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  const id = (raw: string | undefined) => automationId(raw ?? '');

  api.get('/automations/recipes', async (c) => c.json(await homeFor(deps, c).automations.kit()));

  /** A recipe copied into a rule of its own, its settings written into its blocks: what a new automation starts from. */
  api.post('/automations/recipes/:id/copy', async (c) => {
    const { params } = await body(c, z.object({ params: z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).default({}) }).strict());
    return c.json(await homeFor(deps, c).automations.fromRecipe(c.req.param('id'), params));
  });

  api.post('/automations/draft', async (c) => {
    const input = await body(c, draft.extend({ self: z.string().min(1).max(80).nullable().optional() }).strict());
    return c.json(await homeFor(deps, c).automations.draft(asDraft(input), input.self ? automationId(input.self) : null));
  });

  /** Every automation — or, with `?device=`, those a device fills a role of: what its page lists. */
  api.get('/automations', async (c) => {
    const device = c.req.query('device');
    return c.json({ automations: await homeFor(deps, c).automations.list(device ? { device: savedDeviceId(device) } : {}) });
  });

  api.get('/automations/:id', async (c) => c.json(await homeFor(deps, c).automations.get(id(c.req.param('id')))));

  api.get('/automations/:id/runs', async (c) => {
    const { limit } = query(c, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict());
    return c.json({ runs: await homeFor(deps, c).automations.runs(id(c.req.param('id')), limit) });
  });

  /** `?format=csv`: its steps, readings and reachability as one table in time order, to download. */
  api.get('/automations/:id/runs/:runId/log', async (c) => {
    const home = homeFor(deps, c);
    const log = await home.automations.runLog(id(c.req.param('id')), c.req.param('runId'));
    if (c.req.query('format') !== 'csv') return c.json(log);
    const { name } = await home.automations.get(id(c.req.param('id')));
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${fileNameOf(name, log.run.at, 'csv')}"`);
    return c.body(runLogCsv(log));
  });

  api.post('/automations/:id/start', async (c) => c.json(await homeFor(deps, c).automations.start(id(c.req.param('id')))));

  api.post('/automations/:id/stop', async (c) => c.json(await homeFor(deps, c).automations.stop(id(c.req.param('id')))));

  api.post('/automations/rehearse', async (c) => {
    const input = await body(c, draft.extend({ timeZone: z.string().min(1).max(64), hours: z.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7) }).strict());
    return c.json(await homeFor(deps, c).automations.rehearse({ draft: asDraft(input), timeZone: input.timeZone }, input.hours));
  });

  api.get('/automations/:id/rehearse', async (c) => {
    const { hours } = query(c, z.object({ hours: z.coerce.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7) }).strict());
    return c.json(await homeFor(deps, c).automations.rehearse({ automation: id(c.req.param('id')) }, hours));
  });

  api.post('/automations', async (c) => {
    const input = await body(
      c,
      draft
        .extend({
          name: z.string().trim().min(1).max(80),
          key: z.string().trim().min(1).max(63).optional(),
          madeFrom: z.string().min(1).max(120).nullable().optional(),
          timeZone: z.string().min(1).max(64),
          recheckMinutes: recheckMinutes.optional(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).automations.create({ ...input, ...asDraft(input) }));
  });

  api.patch('/automations/:id', async (c) => {
    const input = await body(
      c,
      z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          key: z.string().trim().min(1).max(63).optional(),
          // A new rule comes with what fills its roles: the three together, or none.
          rule: rule.optional(),
          roles: roles.optional(),
          starts: starts.optional(),
          timeZone: z.string().min(1).max(64).optional(),
          mode: z.enum(AUTOMATION_MODES).optional(),
          recheckMinutes: recheckMinutes.optional(),
          homePlace: z.number().int().min(0).max(1000).nullable().optional(),
          confirmation: z.string().max(64).optional(),
        })
        .strict()
    );
    const { rule: given, roles: filled, starts: started, ...rest } = input;
    // What was not sent is not said: the home refuses a rule without what fills its roles.
    const changes: AutomationChanges = {
      ...rest,
      ...(given !== undefined ? { rule: given as unknown as Rule } : {}),
      ...(filled !== undefined ? { roles: bindingsOf(filled) } : {}),
      ...(started !== undefined ? { starts: startsOf(started) } : {}),
    };
    return c.json(await homeFor(deps, c).automations.update(id(c.req.param('id')), changes));
  });

  api.delete('/automations/:id', async (c) => {
    await homeFor(deps, c).automations.delete(id(c.req.param('id')));
    return c.json({ ok: true });
  });

  api.post('/automations/:id/check', async (c) => c.json(await homeFor(deps, c).automations.check(id(c.req.param('id')))));

  return api;
}
