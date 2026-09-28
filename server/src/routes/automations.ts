import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { AutomationChanges, AutomationView, NewAutomation, RecipeView } from '@kraftverk/api-contract';
import { meetsNeed, outletsOf, savedDeviceId, validateConfig, type ConfigValues, type SavedDeviceId } from '@kraftverk/device-sdk';
import { CONFIRMATION } from '@kraftverk/gateway';

import { RECIPES, recipeOf, type AutomationRecord } from '../automations/recipes.ts';
import { isTimeZone } from '../automations/time.ts';
import { auditDevice, body, type AppDeps } from './shared.ts';

/**
 * Automations (docs/ARCHITECTURE.md step 14): what recipes there are, and the
 * automations made from them.
 *
 * A new automation observes: it decides and says what it would have done. It
 * acts only once armed, and arming is a deliberate act, confirmed — from then
 * on it switches things with nobody watching. Its commands still go through the
 * gateway, as any command does.
 */

const roles = z.record(z.string().min(1).max(40), z.string().min(1).max(80));
const params = z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean()]));

export function automationRoutes({ automations, engine, catalog, sessions }: AppDeps): Hono {
  const api = new Hono();

  const view = (automation: AutomationRecord): AutomationView => {
    const recipe = recipeOf(automation.recipe);
    const name = (role: string) => {
      const id = automation.roles[role];
      return (id && catalog.get(savedDeviceId(id))?.name) || 'a device you no longer have';
    };
    return {
      ...automation,
      recipeLabel: recipe?.label ?? automation.recipe,
      sentence: recipe?.describe(automation, name) ?? automation.recipe,
      problems: engine.roleProblems(automation),
    };
  };

  /** Checks what is asked of a recipe: every role filled by a device that fits, and settings its schema accepts. */
  const validated = (recipeId: string, input: { roles: Record<string, string>; params: Record<string, unknown> }) => {
    const recipe = recipeOf(recipeId);
    if (!recipe) throw new HTTPException(400, { message: `There is no recipe called "${recipeId}"` });
    const filled: Record<string, SavedDeviceId> = {};
    for (const [role, spec] of Object.entries(recipe.roles)) {
      const id = input.roles[role];
      const device = id ? catalog.active(savedDeviceId(id)) : null;
      if (!device) throw new HTTPException(400, { message: `${spec.label}: choose one of your devices` });
      const type = sessions.typeOf(device);
      if (!meetsNeed(spec, type?.capabilities ?? [])) throw new HTTPException(400, { message: `${spec.label}: ${device.name} cannot do that` });
      // Filled through a part — a station's outlet — the part must be one it has.
      const others = (spec.oneOf ?? []).filter((capability) => capability !== spec.target?.capability);
      if (spec.target && type && !others.some((capability) => type.capabilities.includes(capability))) {
        const chosen = input.params[spec.target.param];
        const parts = outletsOf(type.telemetry).map((outlet) => outlet.id);
        if (typeof chosen !== 'string' || !parts.includes(chosen)) {
          throw new HTTPException(400, { message: `${spec.label}: choose which of ${device.name}'s outlets (${parts.join(', ')})` });
        }
      }
      filled[role] = device.id;
    }
    const extra = Object.keys(input.roles).filter((role) => !recipe.roles[role]);
    if (extra.length) throw new HTTPException(400, { message: `This recipe has no role called ${extra.join(', ')}` });
    const checked = validateConfig(recipe.params, input.params);
    if (!checked.ok) throw new HTTPException(400, { message: checked.issues.map((issue) => issue.message).join('; ') });
    return { roles: filled, params: checked.value as ConfigValues };
  };

  api.get('/automations/recipes', (c) =>
    c.json({
      recipes: RECIPES.map(({ id, label, description, roles: recipeRoles, params: schema }): RecipeView => ({ id, label, description, roles: recipeRoles, params: schema })),
    })
  );

  api.get('/automations', (c) => c.json({ automations: automations.list().map(view) }));

  api.post('/automations', async (c) => {
    const input: NewAutomation = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(80), recipe: z.string().min(1).max(40), roles, params, timeZone: z.string().min(1).max(64) }).strict()
    );
    if (!isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const checked = validated(input.recipe, input);
    const created = automations.create({ name: input.name, recipe: input.recipe, roles: checked.roles, params: checked.params, timeZone: input.timeZone });
    auditDevice(c, 'automation.created', created.id, `Made the automation "${created.name}", observing`, { recipe: created.recipe, roles: created.roles, params: created.params });
    return c.json(view(created));
  });

  api.patch('/automations/:id', async (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current) throw new HTTPException(404, { message: 'No such automation' });
    const input: AutomationChanges = await body(
      c,
      z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          roles: roles.optional(),
          params: params.optional(),
          timeZone: z.string().min(1).max(64).optional(),
          mode: z.enum(['off', 'observe', 'armed']).optional(),
          confirmation: z.string().max(20).optional(),
        })
        .strict()
    );
    if (input.timeZone && !isTimeZone(input.timeZone)) throw new HTTPException(400, { message: `"${input.timeZone}" is not a time zone` });
    const checked = input.roles || input.params ? validated(current.recipe, { roles: input.roles ?? current.roles, params: input.params ?? current.params }) : null;

    // Arming — and changing what an armed one does — is a deliberate act.
    const armedAfter = input.mode === 'armed' || (input.mode === undefined && current.mode === 'armed');
    const needsConfirming = armedAfter && (current.mode !== 'armed' || checked !== null);
    if (needsConfirming && input.confirmation !== CONFIRMATION) {
      return c.json(
        { error: 'An armed automation switches things on its own, with nobody watching. Confirm to arm it.', needsConfirmation: true },
        409
      );
    }
    if (armedAfter) {
      const problems = engine.roleProblems({ ...current, ...(checked ?? {}) });
      if (problems.length) throw new HTTPException(409, { message: `It cannot act as it is: ${problems.join('; ')}` });
    }

    const updated = automations.update(current.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(checked ?? {}),
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    })!;
    const said = input.mode && input.mode !== current.mode ? { off: 'Turned off', observe: 'Set to observe only', armed: 'Armed: it now acts on its own' }[input.mode] : 'Changed';
    auditDevice(c, input.mode === 'armed' ? 'automation.armed' : 'automation.changed', updated.id, `${said}: "${updated.name}"`, {
      before: { mode: current.mode, roles: current.roles, params: current.params },
      after: { mode: updated.mode, roles: updated.roles, params: updated.params },
    });
    return c.json(view(updated));
  });

  api.delete('/automations/:id', (c) => {
    const current = automations.get(c.req.param('id'));
    if (!current || !automations.delete(current.id)) throw new HTTPException(404, { message: 'No such automation' });
    auditDevice(c, 'automation.deleted', current.id, `Deleted the automation "${current.name}"`);
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
