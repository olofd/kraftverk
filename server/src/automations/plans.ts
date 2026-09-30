import { HTTPException } from 'hono/http-exception';

import type { AutomationView, Rehearsal, RoleBinding } from '@kraftverk/api-contract';
import { capabilitiesOf, describeRule, describeTriggers, meetsNeed, partName, partsOf, savedDeviceId, startsWhenAsked, takesSteps, validateConfig, type ConfigValues, type Value } from '@kraftverk/device-sdk';

import type { DeviceCatalog } from '../devices/catalog.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import { db } from '../history/db.ts';
import type { AutomationEngine, AutomationRecord } from './engine.ts';
import type { AutomationLibrary } from './library.ts';
import { rehearse } from './rehearse.ts';

/**
 * What an automation is made of, checked the one way whoever makes it — a
 * person in the app, or an assistant proposing one — and how it reads and
 * rehearses. The routes and the assistant's tools both come here.
 */

/** How far back a rehearsal reaches: as long as minute samples are kept. */
export const REHEARSAL_MAX_HOURS = 14 * 24;

export type PlanDeps = { catalog: DeviceCatalog; sessions: DeviceSessionManager; library: AutomationLibrary; engine: AutomationEngine };

export function plans({ catalog, sessions, library, engine }: PlanDeps) {
  /** "Garage station", or "Garage station — AC outlets": how a role's part is named, as everywhere else. */
  const roleName = (binding: RoleBinding | undefined): string => {
    const record = binding ? catalog.get(binding.device) : null;
    if (!binding || !record) return 'a device you no longer have';
    return partName(record.name, binding.part, partsOf(record.description).find((candidate) => candidate.id === binding.part)?.label);
  };

  const view = (automation: AutomationRecord): AutomationView => {
    const recipe = library.recipe(automation.recipe);
    const name = (role: string) => roleName(automation.roles[role]);
    const { lookedAt: _lookedAt, ...shown } = automation;
    return {
      ...shown,
      recipeLabel: recipe?.label ?? automation.recipe,
      sentence: recipe ? describeRule(recipe, automation.params as Record<string, Value>, name, library) : automation.recipe,
      when: recipe ? describeTriggers(recipe, automation.params as Record<string, Value>, name, library) : [],
      now: engine.judge(automation),
      nextLookAt: engine.nextLookAt(automation),
      problems: engine.roleProblems(automation),
      ...engine.steps(automation),
      takesSteps: recipe ? takesSteps(recipe) : false,
      startsWhenAsked: recipe ? startsWhenAsked(recipe) : false,
      // The engine's word while it runs — fresher than the row, which it writes after.
      running: engine.running(automation.id) ?? automation.running,
    };
  };

  /** Checks what is asked of a recipe: every role filled by a part of one of your devices that fits, and settings its schema accepts. */
  const validated = (recipeId: string, input: { roles: Record<string, { device: string; part: string }>; params: Record<string, unknown> }) => {
    const recipe = library.recipe(recipeId);
    if (!recipe) throw new HTTPException(400, { message: `There is no recipe called "${recipeId}"` });
    const filled: Record<string, RoleBinding> = {};
    for (const [role, spec] of Object.entries(recipe.roles)) {
      const binding = input.roles[role];
      const device = binding ? catalog.active(savedDeviceId(binding.device)) : null;
      if (!binding || !device) throw new HTTPException(400, { message: `${spec.label}: choose one of your devices` });
      const description = sessions.description(device);
      if (!partsOf(description).some((part) => part.id === binding.part)) throw new HTTPException(400, { message: `${spec.label}: ${device.name} has no part "${binding.part}"` });
      if (!meetsNeed(spec, capabilitiesOf(description, binding.part))) throw new HTTPException(400, { message: `${spec.label}: that part of ${device.name} cannot do that` });
      filled[role] = { device: device.id, part: binding.part };
    }
    const extra = Object.keys(input.roles).filter((role) => !recipe.roles[role]);
    if (extra.length) throw new HTTPException(400, { message: `This recipe has no role called ${extra.join(', ')}` });
    const checked = validateConfig(recipe.params, input.params);
    if (!checked.ok) throw new HTTPException(400, { message: checked.issues.map((issue) => issue.message).join('; ') });
    return { recipe, roles: filled, params: checked.value as ConfigValues };
  };

  /** A rule rehearsed on the last hours of history: when it would have run, and what it would have done. */
  const rehearsed = (recipeId: string, automation: { roles: Record<string, RoleBinding>; params: ConfigValues; timeZone: string }, hours: number): Promise<Rehearsal> => {
    const recipe = library.recipe(recipeId);
    if (!recipe) throw new HTTPException(400, { message: `There is no recipe called "${recipeId}"` });
    const to = new Date();
    const from = new Date(to.getTime() - Math.min(hours, REHEARSAL_MAX_HOURS) * 3_600_000);
    return rehearse(recipe, automation, {
      device: (binding) => {
        const record = catalog.get(binding.device);
        return record ? { name: roleName(binding), description: sessions.description(record) } : null;
      },
      samples: (deviceId, key, start, end) =>
        db().query<{ at: string; value: number | null; text: string | null }, [string, string, string, string]>('SELECT at, value, text FROM sample WHERE device_id = ? AND key = ? AND at >= ? AND at <= ? ORDER BY at').all(deviceId, key, start, end),
      events: (deviceId, part, event, start, end) =>
        db()
          .query<{ at: string }, [string, string, string, string, string]>('SELECT at FROM device_event WHERE device_id = ? AND part = ? AND event = ? AND at >= ? AND at <= ? ORDER BY at')
          .all(deviceId, part, event, start, end)
          .map((row) => row.at),
    }, { from, to });
  };

  return { view, validated, rehearsed, roleName };
}
