import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { RecipeView } from '@kraftverk/api-contract';
import { isTimeZone } from '@kraftverk/device-sdk';
import { Confirmations, subjectOf } from '@kraftverk/gateway';

import { actorOf } from '../auth/routes.ts';
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

export function automationRoutes({ automations, engine, library, catalog, sessions }: AppDeps): Hono {
  const api = new Hono();
  /** Arming is confirmed as a command is: a token bound to this automation, these changes and this person, once. */
  const arming = new Confirmations();
  const { view, validated, rehearsed } = plans({ catalog, sessions, library, engine });

  api.get('/automations/recipes', (c) =>
    c.json({
      recipes: library.recipes().map(({ recipe, from }): RecipeView => ({ id: recipe.id, label: recipe.label, description: recipe.description, from, roles: recipe.roles, params: recipe.params })),
    })
  );

  api.get('/automations', (c) => c.json({ automations: automations.list().map(view) }));

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
      z.object({ name: z.string().trim().min(1).max(80), recipe: z.string().min(1).max(120), roles, params, timeZone: z.string().min(1).max(64) }).strict()
    );
    if (!isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const checked = validated(input.recipe, input);
    const created = automations.create({ name: input.name, recipe: input.recipe, roles: checked.roles, params: checked.params, timeZone: input.timeZone });
    auditAbout(c, 'automation.created', 'automation', created.id, `Made the automation "${created.name}", observing`, { recipe: created.recipe, roles: created.roles, params: created.params });
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
          confirmation: z.string().max(64).optional(),
        })
        .strict()
    );
    if (input.timeZone && !isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const validRecipe = input.roles || input.params ? validated(current.recipe, { roles: input.roles ?? current.roles, params: input.params ?? current.params }) : null;
    const checked = validRecipe ? { roles: validRecipe.roles, params: validRecipe.params } : null;

    // Arming — and changing what an armed one does — is a deliberate act.
    const armedAfter = input.mode === 'armed' || (input.mode === undefined && current.mode === 'armed');
    const needsConfirming = armedAfter && (current.mode !== 'armed' || checked !== null);
    const { confirmation, ...changes } = input;
    const subject = subjectOf({ automation: current.id, changes, by: actorOf(c) });
    if (needsConfirming && !arming.accept(confirmation, subject)) {
      return c.json(
        { error: 'An armed automation switches things on its own, with nobody watching. Confirm to arm it.', needsConfirmation: arming.ask(subject) },
        409
      );
    }
    if (armedAfter) {
      const problems = engine.roleProblems({ ...current, ...(checked ?? {}) });
      if (problems.length) throw new HTTPException(409, { message: `It cannot act as it is: ${problems.join('; ')}` });
    }

    // What it watches may have changed: its conditions start afresh.
    engine.reset(current.id);
    const updated = automations.update(current.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(checked ?? {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    })!;
    const said = input.mode && input.mode !== current.mode ? { off: 'Turned off', observe: 'Set to observe only', armed: 'Armed: it now acts on its own' }[input.mode] : 'Changed';
    auditAbout(c, input.mode === 'armed' ? 'automation.armed' : 'automation.changed', 'automation', updated.id, `${said}: "${updated.name}"`, {
      before: { mode: current.mode, roles: current.roles, params: current.params },
      after: { mode: updated.mode, roles: updated.roles, params: updated.params },
    });
    return c.json(view(updated));
  });

  api.delete('/automations/:id', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current || !automations.delete(current.id)) throw new HTTPException(404, { message: 'No such automation' });
    engine.reset(current.id);
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
