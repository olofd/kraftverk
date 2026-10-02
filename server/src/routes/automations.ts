import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { AutomationDraft, AutomationKit, AutomationRuns, RecipeView, RunLog } from '@kraftverk/api-contract';
import { automationId, isTimeZone, KEY, savedDeviceId, type AutomationId, type Value } from '@kraftverk/device-sdk';
import { describeSteps, takesSteps, type Rule } from '@kraftverk/automation';
import { Confirmations, subjectOf } from '@kraftverk/gateway';

import { actorOf } from '../auth/routes.ts';
import { RunRefusal, runLogCsv } from '@kraftverk/automation-engine';
import { hasConditions, plans, REHEARSAL_MAX_HOURS } from '@kraftverk/hub';

import { db } from '../platform/database.ts';
import { auditAbout, body, type AppDeps } from './shared.ts';

/**
 * Automations (docs/AUTOMATIONS.md, docs/AUTOMATION-EDITOR.md): the recipes
 * to start from, and the automations their owners build.
 *
 * Each owns its rule. A new one only watches on its own: it decides and says
 * what it would have done. It acts on its own only once let act, which is a
 * deliberate act, confirmed — from then on it switches things with nobody
 * watching. Played, it runs now, whatever its mode. Its commands and settings
 * go through the gateway, as any do.
 */

const roles = z.record(z.string().min(1).max(40), z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80) }).strict());
const starts = z.record(z.string().min(1).max(40), z.string().min(1).max(80));
/** A rule is checked by the language, not by its shape here: `plans.checked` says everything wrong with it. */
const rule = z.record(z.string(), z.unknown());
/** Minutes between looks that keep things so, a day at most; null, never. */
const recheckMinutes = z.number().int().min(1).max(1440).nullable();
const draft = z.object({ rule, roles, starts }).strict();

/** A draft as the checker takes it: its devices' and automations' ids as ids. */
const asDraft = (input: { rule: Record<string, unknown>; roles: Record<string, { device: string; part: string }>; starts: Record<string, string> }): AutomationDraft => ({
  rule: input.rule as unknown as Rule,
  roles: Object.fromEntries(Object.entries(input.roles).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }])),
  starts: Object.fromEntries(Object.entries(input.starts).map(([role, id]) => [role, automationId(id)])),
});

export function automationRoutes({ automations, engine, library, catalog, sessions, bus }: AppDeps): Hono {
  /** An automation made, changed or deleted, said on the live stream: every open app reads it again. No device list does. */
  const moved = (automationId: AutomationId) => bus.publish({ kind: 'automation', automationId });
  const api = new Hono();
  /** Letting it act is confirmed as a command is: a token bound to this automation, these changes and this person, once. */
  const arming = new Confirmations();
  const { view, checked, draftView, rehearsed } = plans({ db: db(), catalog, sessions, library, engine, automations });

  /** A draft that cannot be kept: every problem, in one answer. */
  const refuseProblems = (problems: string[]) => {
    if (problems.length) throw new HTTPException(400, { message: problems.join('; ') });
  };

  api.get('/automations/recipes', (c) =>
    c.json({
      recipes: library.recipes().map(({ recipe, from }): RecipeView => {
        const defaults = Object.fromEntries(Object.entries(recipe.params.fields).map(([key, field]) => [key, ('default' in field ? field.default : null) as Value]));
        const { id, label, description, sentence: _sentence, ...rest } = recipe;
        return {
          id,
          label,
          description,
          from,
          hasConditions: hasConditions(recipe),
          takesSteps: takesSteps(recipe),
          // Its steps as starting from it shows them: each role by its label, each setting at its default.
          steps: describeSteps(recipe, defaults, (role) => lowerFirst(recipe.roles[role]?.label ?? role), library).steps,
          rule: rest,
        };
      }),
      functions: library.functions().map(({ id, label, description, needs, args, returns }) => ({ id, label, description, needs, args, returns })),
    } satisfies AutomationKit)
  );

  /**
   * A draft, as its owner builds it: everything wrong with it, and how it
   * reads — nothing kept. `self`: the automation it is, when it is one
   * already, so a chain back to it is seen.
   */
  api.post('/automations/draft', async (c) => {
    const input = await body(c, draft.extend({ self: z.string().min(1).max(80).nullable().optional() }).strict());
    const self = input.self ? (automations.get(input.self)?.id ?? null) : null;
    return c.json(draftView(asDraft(input), self));
  });

  /** Every automation — or, with `?device=`, those a device fills a role of: what its page lists. */
  api.get('/automations', (c) => {
    const device = c.req.query('device');
    return c.json({ automations: (device ? automations.usingDevice(device) : automations.list()).map(view) });
  });

  /** One automation, as its own page shows it. */
  api.get('/automations/:id', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    return c.json(view(current));
  });

  /** Its runs, the latest first, each with every step it took. */
  api.get('/automations/:id/runs', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(c.req.query('limit') ?? 50);
    return c.json({ runs: automations.runs(current.id, limit) } satisfies AutomationRuns);
  });

  /**
   * One of its runs with its log: every value its devices gave while it ran,
   * second by second, and whether each could be reached — to read back what
   * happened. `?format=csv`: the same, with its steps, as one table in time
   * order, to download.
   */
  api.get('/automations/:id/runs/:runId/log', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    const log = engine.runLog(current, c.req.param('runId'));
    if (!log) throw new HTTPException(404, { message: 'No such run' });
    if (c.req.query('format') !== 'csv') return c.json(log satisfies RunLog);
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${current.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'run'} ${log.run.at.slice(0, 19).replace(/:/g, '-')}.csv"`);
    return c.body(runLogCsv(log));
  });

  /**
   * Plays it: it runs now, for real, whatever its mode — refused when it is
   * off, or already running. Answered as it stands once begun: one that
   * takes steps goes on taking them. On the timeline, with who started it.
   */
  api.post('/automations/:id/start', async (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    try {
      const run = await engine.startAsked(current.id, { name: actorOf(c), actor: 'user' });
      auditAbout(c, 'automation.started', 'automation', current.id, `Started "${current.name}"`, { run: run.id });
      return c.json(view(automations.get(current.id) ?? current));
    } catch (error) {
      if (error instanceof RunRefusal) throw new HTTPException(409, { message: error.message });
      throw error;
    }
  });

  /** Stops its run: the step it is in ends, and what it does if stopped — switching back off — runs. */
  api.post('/automations/:id/stop', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    try {
      engine.stopAsked(current.id, actorOf(c));
      auditAbout(c, 'automation.stopping', 'automation', current.id, `Stopped "${current.name}"`);
      return c.json(view(automations.get(current.id) ?? current));
    } catch (error) {
      if (error instanceof RunRefusal) throw new HTTPException(409, { message: error.message });
      throw error;
    }
  });

  /**
   * A draft rehearsed on what happened, before it is kept: when it would
   * have run in the last hours on its own, and what it would have done.
   * Nothing is sent and nothing is kept.
   */
  api.post('/automations/rehearse', async (c) => {
    const input = await body(c, draft.extend({ timeZone: z.string().min(1).max(64), hours: z.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7) }).strict());
    if (!isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const result = checked(asDraft(input), null);
    refuseProblems(result.problems);
    return c.json(await rehearsed({ rule: input.rule as unknown as Rule, roles: result.roles, timeZone: input.timeZone }, input.hours));
  });

  api.get('/automations/:id/rehearse', async (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    const hours = z.coerce.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7).parse(c.req.query('hours') ?? 24 * 7);
    return c.json(await rehearsed(current, hours));
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
    if (!isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    if (input.madeFrom && !library.recipe(input.madeFrom)) throw new HTTPException(400, { message: `There is no recipe called "${input.madeFrom}"` });
    if (input.key !== undefined && !KEY.test(input.key)) throw new HTTPException(400, { message: 'A key is lowercase letters, digits and dashes: "start-charging"' });
    if (input.key !== undefined && automations.keyTaken(input.key)) throw new HTTPException(409, { message: `Another automation is known by "${input.key}"` });
    const result = checked(asDraft(input), null);
    refuseProblems(result.problems);
    const kept = input.rule as unknown as Rule;
    if (input.recheckMinutes && !keepsSo(kept)) throw new HTTPException(400, { message: KEEPS_SO_ONLY });
    const created = automations.create({
      ...(input.key !== undefined ? { key: input.key } : {}),
      name: input.name,
      rule: kept,
      madeFrom: input.madeFrom ?? null,
      roles: result.roles,
      starts: result.starts,
      timeZone: input.timeZone,
      recheckMinutes: input.recheckMinutes ?? null,
    });
    auditAbout(c, 'automation.created', 'automation', created.id, `Made the automation "${created.name}", only watching on its own`, {
      madeFrom: created.madeFrom,
      rule: created.rule,
      roles: created.roles,
      starts: created.starts,
      recheckMinutes: created.recheckMinutes,
    });
    engine.poke(created.id);
    moved(created.id);
    return c.json(view(created));
  });

  api.patch('/automations/:id', async (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
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
          mode: z.enum(['off', 'observe', 'armed']).optional(),
          recheckMinutes: recheckMinutes.optional(),
          homePlace: z.number().int().min(0).max(1000).nullable().optional(),
          confirmation: z.string().max(64).optional(),
        })
        .strict()
    );
    if (input.timeZone && !isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    if (input.key !== undefined && input.key !== current.key) {
      if (!KEY.test(input.key)) throw new HTTPException(400, { message: 'A key is lowercase letters, digits and dashes: "start-charging"' });
      if (automations.keyTaken(input.key, current.id)) throw new HTTPException(409, { message: `Another automation is known by "${input.key}"` });
    }
    const rebuilt = input.rule !== undefined || input.roles !== undefined || input.starts !== undefined;
    if (rebuilt && (!input.rule || !input.roles || !input.starts)) throw new HTTPException(400, { message: 'A new rule comes with what fills its roles: rule, roles and starts together' });
    const result = rebuilt ? checked(asDraft({ rule: input.rule!, roles: input.roles!, starts: input.starts! }), current.id) : null;
    if (result) refuseProblems(result.problems);
    const nextRule = result ? (input.rule as unknown as Rule) : current.rule;
    const nextRecheck = input.recheckMinutes !== undefined ? input.recheckMinutes : current.recheckMinutes;
    if (nextRecheck && !keepsSo(nextRule)) throw new HTTPException(400, { message: KEEPS_SO_ONLY });
    const changedRule = result ? { rule: nextRule, roles: result.roles, starts: result.starts } : null;

    // Letting it act — and changing what one that acts does — is a deliberate act.
    const armedAfter = input.mode === 'armed' || (input.mode === undefined && current.mode === 'armed');
    // How often it keeps things so changes what it does, too.
    const recheckChanged = input.recheckMinutes !== undefined && input.recheckMinutes !== current.recheckMinutes;
    const needsConfirming = armedAfter && (current.mode !== 'armed' || changedRule !== null || recheckChanged);
    const { confirmation, ...changes } = input;
    const subject = subjectOf({ automation: current.id, changes, by: actorOf(c) });
    if (needsConfirming && !arming.accept(confirmation, subject)) {
      // What the yes is to, in words: letting it act, keeping things so while it does, or changing what it does.
      const error =
        current.mode !== 'armed'
          ? 'It will switch things on its own, with nobody watching.'
          : recheckChanged && changedRule === null
            ? input.recheckMinutes
              ? `It acts on its own: every ${input.recheckMinutes} min it will switch back what was switched by hand against it.`
              : 'It acts on its own: from now on, what is switched by hand stays until a condition comes true again.'
            : 'It acts on its own: what it does will change.';
      return c.json({ error, needsConfirmation: arming.ask(subject) }, 409);
    }
    if (armedAfter) {
      const problems = engine.roleProblems({ ...current, ...(changedRule ?? {}) });
      if (problems.length) throw new HTTPException(409, { message: `It cannot act as it is: ${problems.join('; ')}` });
    }

    // What it watches, or how it may act, changed: its conditions start afresh, and one already true is its edge.
    // A new name, its place on the home page, or how often it keeps things so, changes neither: what it did stands.
    const startsAfresh = changedRule !== null || (input.mode !== undefined && input.mode !== current.mode);
    if (startsAfresh) engine.reset(current.id);
    let updated = automations.update(current.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.key ? { key: input.key } : {}),
      ...(changedRule ?? {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.recheckMinutes !== undefined ? { recheckMinutes: input.recheckMinutes } : {}),
    })!;
    if (input.homePlace !== undefined) updated = automations.placeOnHome(current.id, input.homePlace)!;
    const said =
      input.mode && input.mode !== current.mode
        ? { off: 'Turned off', observe: 'Set to only watch on its own', armed: 'Let act on its own' }[input.mode]
        : input.key !== undefined && input.key !== current.key && !changedRule && !input.name
          ? `Known in configuration as ${input.key}`
          : input.homePlace !== undefined && !changedRule && !input.name
          ? input.homePlace === null
            ? 'Taken off the home page'
            : 'Put on the home page'
          : 'Changed';
    auditAbout(c, input.mode === 'armed' && current.mode !== 'armed' ? 'automation.armed' : 'automation.changed', 'automation', updated.id, `${said}: "${updated.name}"`, {
      before: { key: current.key, mode: current.mode, rule: current.rule, roles: current.roles, starts: current.starts, recheckMinutes: current.recheckMinutes, homePlace: current.homePlace },
      after: { key: updated.key, mode: updated.mode, rule: updated.rule, roles: updated.roles, starts: updated.starts, recheckMinutes: updated.recheckMinutes, homePlace: updated.homePlace },
    });
    // Its conditions, looked at now, after the change is on the timeline: let act while one holds, it acts at once.
    if (startsAfresh) engine.poke(updated.id);
    moved(updated.id);
    return c.json(view(updated));
  });

  api.delete('/automations/:id', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    // The automations that start it are told: one of their roles has nothing to start now.
    const starting = automations.list().filter((other) => Object.values(other.starts).includes(current.id));
    if (!automations.delete(current.id)) throw new HTTPException(404, { message: 'No such automation' });
    engine.forget(current.id);
    auditAbout(c, 'automation.deleted', 'automation', current.id, `Deleted the automation "${current.name}"`);
    moved(current.id);
    for (const other of starting) moved(other.id);
    return c.json({ ok: true });
  });

  /** What it would do now: decided, never acted on and never recorded, whatever its mode. */
  api.post('/automations/:id/check', async (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    return c.json(await engine.run(current, { check: true }));
  });

  return api;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Keeping things so is looking again at a condition that still holds, to do at once what it did: for such a rule alone. */
const keepsSo = (rule: Rule): boolean => hasConditions(rule) && !takesSteps(rule);
const KEEPS_SO_ONLY = 'Only an automation that waits for a condition, and does what it does at once, can keep things so: a sequence is started, not kept';
