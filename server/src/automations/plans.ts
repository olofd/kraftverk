import { HTTPException } from 'hono/http-exception';

import type { AutomationDraft, AutomationDraftView, AutomationView, Rehearsal, RoleBinding } from '@kraftverk/api-contract';
import {
  capabilitiesOf,
  checkBinding,
  checkRule,
  describeRule,
  describeSteps,
  describeTriggers,
  inlineParams,
  isAutomationRole,
  meetsNeed,
  partName,
  partsOf,
  problemPlace,
  savedDeviceId,
  takesSteps,
  validateConfig,
  writtenAttribute,
  type AutomationId,
  type BoundPart,
  type Rule,
  type RuleVocabulary,
  type Value,
} from '@kraftverk/device-sdk';

import type { DeviceCatalog } from '../devices/catalog.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import { db } from '../history/db.ts';
import { CHAIN_LIMIT, quoted, type AutomationEngine, type AutomationRecord } from './engine.ts';
import type { AutomationLibrary } from './library.ts';
import { rehearse } from './rehearse.ts';
import type { AutomationStore } from './store.ts';

/**
 * What an automation is made of, checked the one way whoever makes it — a
 * person building it in the app, or an assistant — and how it reads and
 * rehearses (docs/AUTOMATION-EDITOR.md). The routes and the assistant's
 * tools both come here.
 */

/** How far back a rehearsal reaches: as long as minute samples are kept. */
export const REHEARSAL_MAX_HOURS = 14 * 24;

export type PlanDeps = { catalog: DeviceCatalog; sessions: DeviceSessionManager; library: AutomationLibrary; engine: AutomationEngine; automations: AutomationStore };

/** A draft checked: what is wrong with it, and what fills its roles as far as it could be read. */
export type Checked = { problems: string[]; roles: Record<string, RoleBinding>; starts: Record<string, AutomationId> };

/** Whether something could be a rule at all: the checker reads further only into one that is. */
const looksLikeRule = (rule: unknown): rule is Rule => {
  const candidate = rule as Partial<Rule> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.roles === 'object' &&
    candidate.roles !== null &&
    typeof candidate.params === 'object' &&
    candidate.params !== null &&
    typeof candidate.params.fields === 'object' &&
    Array.isArray(candidate.when) &&
    Array.isArray(candidate.then) &&
    (candidate.otherwise === undefined || Array.isArray(candidate.otherwise))
  );
};

const NOT_A_RULE = 'That is not a rule: it needs roles, settings, triggers and steps';

export function plans({ catalog, sessions, library, engine, automations }: PlanDeps) {
  /** "Garage station", or "Garage station — AC outlets": how a role's part is named, as everywhere else. */
  const roleName = (binding: RoleBinding | undefined): string => {
    const record = binding ? catalog.get(binding.device) : null;
    if (!binding || !record) return 'a device you no longer have';
    return partName(record.name, binding.part, partsOf(record.description).find((candidate) => candidate.id === binding.part)?.label);
  };

  /** Each role's name as a step says it: a part by its device, an automation in quotes; one not filled yet, by its label, as words in a sentence. */
  const namesOf = (rule: Rule, roles: Record<string, RoleBinding>, starts: Record<string, AutomationId>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(rule.roles).map(([role, spec]) => {
        const unfilled = spec.label.charAt(0).toLowerCase() + spec.label.slice(1);
        if (isAutomationRole(spec)) return [role, starts[role] ? quoted(automations.get(starts[role])?.name ?? null) : unfilled];
        return [role, roles[role] ? roleName(roles[role]) : unfilled];
      })
    );

  /** What the words need: the installed functions, and each setting a step changes as its device names it. */
  const vocabularyOf = (roles: Record<string, RoleBinding>): RuleVocabulary => ({
    fn: (id) => library.fn(id),
    attribute: (role, key) => {
      const binding = roles[role];
      const record = binding ? catalog.get(binding.device) : null;
      return record && binding ? writtenAttribute(sessions.description(record), binding.part, key) : null;
    },
  });

  /** How a rule reads with what fills its roles. */
  const said = (rule: Rule, roles: Record<string, RoleBinding>, starts: Record<string, AutomationId>) => {
    const names = namesOf(rule, roles, starts);
    const name = (role: string) => names[role] ?? (role ? role : 'a part not chosen yet');
    const vocabulary = vocabularyOf(roles);
    return {
      names,
      sentence: describeRule(rule, {}, name, vocabulary),
      when: describeTriggers(rule, {}, name, vocabulary),
      ...describeSteps(rule, {}, name, vocabulary),
      takesSteps: takesSteps(rule),
    };
  };

  const view = (automation: AutomationRecord): AutomationView => {
    const { lookedAt: _lookedAt, madeFrom, ...shown } = automation;
    return {
      ...shown,
      madeFrom: madeFrom ? { id: madeFrom, label: library.recipe(madeFrom)?.label ?? madeFrom } : null,
      ...said(automation.rule, automation.roles, automation.starts),
      now: engine.judge(automation),
      nextLookAt: engine.nextLookAt(automation),
      problems: engine.roleProblems(automation),
      // The engine's word while it runs — fresher than the row, which it writes after.
      running: engine.running(automation.id) ?? automation.running,
    };
  };

  /**
   * A chain it would start that comes back to it, or goes deeper than a chain
   * may: followed through what each automation it starts starts in turn.
   */
  const chainProblems = (self: AutomationId | null, targets: readonly AutomationId[]): string[] => {
    const problems: string[] = [];
    const deepest = (id: AutomationId, seen: readonly AutomationId[]): number => {
      if (seen.includes(id)) {
        problems.push(`Starting ${quoted(automations.get(id)?.name ?? null)} would come back to it: a chain may not start itself`);
        return 0;
      }
      const next = Object.values(automations.get(id)?.starts ?? {});
      return 1 + Math.max(0, ...next.map((one) => deepest(one, [...seen, id])));
    };
    const below = Math.max(0, ...targets.map((target) => deepest(target, self ? [self] : [])));
    if (1 + below > CHAIN_LIMIT) problems.push(`It would start a chain ${1 + below} automations deep: at most ${CHAIN_LIMIT}`);
    return [...new Set(problems)];
  };

  /**
   * Everything wrong with a draft, as its owner builds it — empty when it can
   * be kept: a rule the language accepts, with no settings of its own; every
   * role a part fills filled by a part of one of your devices that can do
   * what it needs, and every setting it changes one that part may be told;
   * every role an automation fills filled by another of yours; and no chain it
   * starts that comes back to it, or goes deeper than a chain may. `self`:
   * the automation it is, when it is one already.
   */
  const checked = (draft: AutomationDraft, self: AutomationId | null): Checked => {
    const roles: Record<string, RoleBinding> = {};
    const starts: Record<string, AutomationId> = {};
    const rule: unknown = draft.rule;
    if (!looksLikeRule(rule)) return { problems: [NOT_A_RULE], roles, starts };
    let language: string[];
    try {
      // Each said where its owner finds it: "Step 5: which setting?", not the language's own path.
      language = checkRule(rule, library).map((problem) => problemPlace(problem, rule));
    } catch {
      return { problems: [NOT_A_RULE], roles, starts };
    }
    const problems = [...language];
    if (Object.keys(rule.params.fields).length) problems.push('An automation has no settings of its own: its values are in its blocks');

    const bound = new Map<string, BoundPart>();
    for (const [role, spec] of Object.entries(rule.roles)) {
      if (isAutomationRole(spec)) {
        const target = draft.starts?.[role];
        const automation = target ? automations.get(target) : null;
        if (!automation) problems.push(`${spec.label}: choose an automation to start`);
        else if (automation.id === self) problems.push(`${spec.label}: an automation does not start itself`);
        else starts[role] = automation.id;
        continue;
      }
      const binding = draft.roles?.[role];
      const device = binding ? catalog.active(savedDeviceId(binding.device)) : null;
      if (!binding || !device) {
        problems.push(`${spec.label}: choose one of your devices`);
        continue;
      }
      const description = sessions.description(device);
      if (!partsOf(description).some((part) => part.id === binding.part)) problems.push(`${spec.label}: ${device.name} has no part "${binding.part}"`);
      else if (!meetsNeed(spec, capabilitiesOf(description, binding.part))) problems.push(`${spec.label}: that part of ${device.name} cannot do that`);
      else {
        roles[role] = { device: device.id, part: binding.part };
        bound.set(role, { name: roleName(roles[role]), description, part: binding.part, capabilities: capabilitiesOf(description, binding.part) });
      }
    }
    for (const role of [...Object.keys(draft.roles ?? {}), ...Object.keys(draft.starts ?? {})]) {
      if (!rule.roles[role]) problems.push(`There is no role called ${role}`);
    }
    // What the filled parts must report, raise and let be written: said once the rule itself holds.
    if (!language.length) {
      const filled = Object.fromEntries(Object.entries(rule.roles).filter(([role, spec]) => !isAutomationRole(spec) && bound.has(role)));
      problems.push(...checkBinding({ ...rule, roles: filled }, (role) => bound.get(role) ?? null));
    }
    problems.push(...chainProblems(self, Object.values(starts)));
    return { problems: [...new Set(problems)], roles, starts };
  };

  /** A draft, checked and said — nothing kept: what the editor shows as its owner builds. */
  const draftView = (draft: AutomationDraft, self: AutomationId | null): AutomationDraftView => {
    const result = checked(draft, self);
    const unsaid = { sentence: '', when: [], steps: [], otherwise: [], takesSteps: false, names: {} };
    if (result.problems[0] === NOT_A_RULE) return { problems: result.problems, ...unsaid };
    try {
      return { problems: result.problems, ...said(draft.rule, result.roles, result.starts) };
    } catch {
      // A rule the checker has problems with may not read: its problems are what to show.
      return { problems: result.problems, ...unsaid };
    }
  };

  /** A rule rehearsed on the last hours of history: when it would have run, and what it would have done. */
  const rehearsed = (automation: Pick<AutomationRecord, 'rule' | 'roles' | 'timeZone'>, hours: number): Promise<Rehearsal> => {
    const to = new Date();
    const from = new Date(to.getTime() - Math.min(hours, REHEARSAL_MAX_HOURS) * 3_600_000);
    return rehearse(
      automation.rule,
      automation,
      {
        device: (binding) => {
          const record = catalog.get(binding.device);
          return record ? { name: roleName(binding), description: sessions.description(record) } : null;
        },
        samples: (deviceId, key, start, end) =>
          db()
            .query<{ at: string; value: number | null; text: string | null }, [string, string, string, string]>('SELECT at, value, text FROM sample WHERE device_id = ? AND key = ? AND at >= ? AND at <= ? ORDER BY at')
            .all(deviceId, key, start, end),
        events: (deviceId, part, event, start, end) =>
          db()
            .query<{ at: string }, [string, string, string, string, string]>('SELECT at FROM device_event WHERE device_id = ? AND part = ? AND event = ? AND at >= ? AND at <= ? ORDER BY at')
            .all(deviceId, part, event, start, end)
            .map((row) => row.at),
      },
      { from, to }
    );
  };

  /**
   * A recipe copied into a rule of its own, its settings — held to their
   * schema — written into its blocks: what an assistant proposes, as the app
   * starts from one.
   */
  const copied = (recipeId: string, params: Record<string, unknown>): Rule => {
    const recipe = library.recipe(recipeId);
    if (!recipe) throw new HTTPException(400, { message: `There is no recipe called "${recipeId}"` });
    const settings = validateConfig(recipe.params, params);
    if (!settings.ok) throw new HTTPException(400, { message: settings.issues.map((issue) => issue.message).join('; ') });
    const { id: _id, label: _label, description: _description, sentence: _sentence, ...rule } = recipe;
    return inlineParams(rule, settings.value as Record<string, Value>);
  };

  return { view, checked, draftView, rehearsed, roleName, copied };
}

/** Whether a rule waits for a condition to come true: only then can it keep things so (`recheckMinutes`). */
export const hasConditions = (rule: Rule): boolean => rule.when.some((trigger) => 'becomes' in trigger);
