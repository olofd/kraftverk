import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { AutomationRuns, RecipeView } from '@kraftverk/api-contract';
import { describeSteps, isTimeZone, startsWhenAsked, takesSteps, type Recipe, type Value } from '@kraftverk/device-sdk';
import { Confirmations, subjectOf } from '@kraftverk/gateway';

import { actorOf } from '../auth/routes.ts';
import { RunRefusal } from '../automations/engine.ts';
import { plans, REHEARSAL_MAX_HOURS } from '../automations/plans.ts';
import { auditAbout, body, type AppDeps } from './shared.ts';

/**
 * Automations (docs/ARCHITECTURE.md step 14): what recipes there are, and the
 * automations made from them.
 *
 * A new automation observes: it decides and says what it would have done. It
 * acts only once armed, and arming is a deliberate act, confirmed — from then
 * on it switches things with nobody watching. Its commands still go through the
 * gateway, as any command does.
 */

const roles = z.record(z.string().min(1).max(40), z.object({ device: z.string().min(1).max(80), part: z.string().min(1).max(80) }).strict());
const params = z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean()]));
/** Minutes between looks that keep things so, a day at most; null, never. */
const recheckMinutes = z.number().int().min(1).max(1440).nullable();

export function automationRoutes({ automations, engine, library, catalog, sessions }: AppDeps): Hono {
  const api = new Hono();
  /** Arming is confirmed as a command is: a token bound to this automation, these changes and this person, once. */
  const arming = new Confirmations();
  const { view, validated, rehearsed } = plans({ catalog, sessions, library, engine });

  api.get('/automations/recipes', (c) =>
    c.json({
      recipes: library.recipes().map(({ recipe, from }): RecipeView => {
        const defaults = Object.fromEntries(Object.entries(recipe.params.fields).map(([key, field]) => [key, ('default' in field ? field.default : null) as Value]));
        return {
          id: recipe.id,
          label: recipe.label,
          description: recipe.description,
          from,
          hasConditions: recipe.when.some((trigger) => 'becomes' in trigger),
          startsWhenAsked: startsWhenAsked(recipe),
          takesSteps: takesSteps(recipe),
          // Its steps as making one shows them: each role by its label, each setting at its default.
          steps: describeSteps(recipe, defaults, (role) => lowerFirst(recipe.roles[role]?.label ?? role), library).steps,
          roles: recipe.roles,
          params: recipe.params,
        };
      }),
    })
  );

  /** Every automation — or, with `?device=`, those a device fills a role of: what its page can start. */
  api.get('/automations', (c) => {
    const device = c.req.query('device');
    return c.json({ automations: (device ? automations.usingDevice(device) : automations.list()).map(view) });
  });

  /** Its runs, the latest first, each with every step it took. */
  api.get('/automations/:id/runs', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(c.req.query('limit') ?? 50);
    return c.json({ runs: automations.runs(current.id, limit) } satisfies AutomationRuns);
  });

  /**
   * Starts one that is started when asked (docs/SEQUENCES.md): one that acts
   * takes its steps from now on, and is answered as it stands once begun;
   * one that only watches answers with what it would do. On the timeline,
   * with who started it.
   */
  api.post('/automations/:id/start', async (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    const by = actorOf(c);
    try {
      const run = await engine.startAsked(current.id, by);
      if (run.outcome !== 'would-act') auditAbout(c, 'automation.started', 'automation', current.id, `Started "${current.name}"`, { run: run.id });
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
   * A rule rehearsed on what happened, before it is made or after: when it
   * would have run in the last hours, and what it would have done. Nothing is
   * sent and nothing is kept.
   */
  api.post('/automations/rehearse', async (c) => {
    const input = await body(
      c,
      z.object({ recipe: z.string().min(1).max(120), roles, params, timeZone: z.string().min(1).max(64), hours: z.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7) }).strict()
    );
    if (!isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const checked = validated(input.recipe, input);
    return c.json(await rehearsed(input.recipe, { roles: checked.roles, params: checked.params, timeZone: input.timeZone }, input.hours));
  });

  api.get('/automations/:id/rehearse', async (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    const hours = z.coerce.number().min(1).max(REHEARSAL_MAX_HOURS).default(24 * 7).parse(c.req.query('hours') ?? 24 * 7);
    return c.json(await rehearsed(current.recipe, current, hours));
  });

  api.post('/automations', async (c) => {
    const input = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(80), recipe: z.string().min(1).max(120), roles, params, timeZone: z.string().min(1).max(64), recheckMinutes: recheckMinutes.optional() }).strict()
    );
    if (!isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const checked = validated(input.recipe, input);
    if (input.recheckMinutes && !keepsSo(checked.recipe)) throw new HTTPException(400, { message: KEEPS_SO_ONLY });
    const created = automations.create({ name: input.name, recipe: input.recipe, roles: checked.roles, params: checked.params, timeZone: input.timeZone, recheckMinutes: input.recheckMinutes ?? null });
    auditAbout(c, 'automation.created', 'automation', created.id, `Made the automation "${created.name}", only watching`, { recipe: created.recipe, roles: created.roles, params: created.params, recheckMinutes: created.recheckMinutes });
    engine.poke(created.id);
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
          roles: roles.optional(),
          params: params.optional(),
          timeZone: z.string().min(1).max(64).optional(),
          mode: z.enum(['off', 'observe', 'armed']).optional(),
          recheckMinutes: recheckMinutes.optional(),
          confirmation: z.string().max(64).optional(),
        })
        .strict()
    );
    if (input.timeZone && !isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const validRecipe = input.roles || input.params ? validated(current.recipe, { roles: input.roles ?? current.roles, params: input.params ?? current.params }) : null;
    const recipe = library.recipe(current.recipe);
    if (input.recheckMinutes && recipe && !keepsSo(recipe)) throw new HTTPException(400, { message: KEEPS_SO_ONLY });
    const checked = validRecipe ? { roles: validRecipe.roles, params: validRecipe.params } : null;

    // Arming — and changing what an armed one does — is a deliberate act.
    const armedAfter = input.mode === 'armed' || (input.mode === undefined && current.mode === 'armed');
    // How often it keeps things so changes what it does, too.
    const recheckChanged = input.recheckMinutes !== undefined && input.recheckMinutes !== current.recheckMinutes;
    const needsConfirming = armedAfter && (current.mode !== 'armed' || checked !== null || recheckChanged);
    const { confirmation, ...changes } = input;
    const subject = subjectOf({ automation: current.id, changes, by: actorOf(c) });
    if (needsConfirming && !arming.accept(confirmation, subject)) {
      // What the yes is to, in words: letting it act, keeping things so while it does, or changing what it does.
      const error =
        current.mode !== 'armed'
          ? 'It will switch things on its own, with nobody watching.'
          : recheckChanged && checked === null
            ? input.recheckMinutes
              ? `It acts on its own: every ${input.recheckMinutes} min it will switch back what was switched by hand against it.`
              : 'It acts on its own: from now on, what is switched by hand stays until a condition comes true again.'
            : 'It acts on its own: what it does will change.';
      return c.json({ error, needsConfirmation: arming.ask(subject) }, 409);
    }
    if (armedAfter) {
      const problems = engine.roleProblems({ ...current, ...(checked ?? {}) });
      if (problems.length) throw new HTTPException(409, { message: `It cannot act as it is: ${problems.join('; ')}` });
    }

    // What it watches, or how it may act, changed: its conditions start afresh, and one already true is its edge.
    // A new name, or how often it keeps things so, changes neither: what it did stands.
    const startsAfresh = checked !== null || (input.mode !== undefined && input.mode !== current.mode);
    if (startsAfresh) engine.reset(current.id);
    const updated = automations.update(current.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(checked ?? {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.recheckMinutes !== undefined ? { recheckMinutes: input.recheckMinutes } : {}),
    })!;
    const said = input.mode && input.mode !== current.mode ? { off: 'Turned off', observe: 'Set to only watch', armed: 'Let act on its own' }[input.mode] : 'Changed';
    auditAbout(c, input.mode === 'armed' && current.mode !== 'armed' ? 'automation.armed' : 'automation.changed', 'automation', updated.id, `${said}: "${updated.name}"`, {
      before: { mode: current.mode, roles: current.roles, params: current.params, recheckMinutes: current.recheckMinutes },
      after: { mode: updated.mode, roles: updated.roles, params: updated.params, recheckMinutes: updated.recheckMinutes },
    });
    // Its conditions, looked at now, after the change is on the timeline: let act while one holds, it acts at once.
    if (startsAfresh) engine.poke(updated.id);
    return c.json(view(updated));
  });

  api.delete('/automations/:id', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current || !automations.delete(current.id)) throw new HTTPException(404, { message: 'No such automation' });
    engine.forget(current.id);
    auditAbout(c, 'automation.deleted', 'automation', current.id, `Deleted the automation "${current.name}"`);
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
const keepsSo = (recipe: Recipe): boolean => recipe.when.some((trigger) => 'becomes' in trigger) && !takesSteps(recipe);
const KEEPS_SO_ONLY = 'Only an automation that waits for a condition, and does what it does at once, can keep things so: a sequence is started, not kept';
