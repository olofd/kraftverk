import { ApiError, type AutomationDraft, type Caller, type KraftverkApi, type RecipeView } from '@kraftverk/api-contract';
import { describeSteps, hasConditions, keepsSo, takesSteps } from '@kraftverk/automation';
import { RunRefusal, type AutomationRecord } from '@kraftverk/automation-engine';
import { isTimeZone, KEY, type AutomationId, type Value } from '@kraftverk/device-sdk';
import { subjectOf } from '@kraftverk/gateway';

import type { Hub } from '../hub.ts';
import { actorOf, intentOf } from './caller.ts';

/*
  Automations (docs/AUTOMATIONS.md, docs/AUTOMATION-EDITOR.md), as
  everything that uses a home asks for them: the recipes to start from, and
  the automations their owners build.

  Each owns its rule. A new one only watches on its own: it decides and says
  what it would have done. It acts on its own only once let act, which is a
  deliberate act, confirmed — from then on it switches things with nobody
  watching. Played, it runs now, whatever its mode. Its commands and settings
  go through the gateway, as any do.
*/

/** Keeping things so is looking again at a condition that still holds, to do at once what it did: for such a rule alone. */
const KEEPS_SO_ONLY = 'Only an automation that waits for a condition, and does what it does at once, can keep things so: a sequence is started, not kept';

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A run refused — off, already running, a chain too deep — is a conflict, in the engine's words. */
const refusing = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof RunRefusal) throw new ApiError('conflict', error.message);
    throw error;
  }
};

export function automationsApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'automations'> {
  const { automations, engine, library } = hub;
  const { view, checked, draftView, rehearsed, copied } = hub.plans;
  const actor = actorOf(caller);
  const intent = intentOf(caller);

  const record = (kind: string, automation: AutomationId, summary: string, detail?: unknown) =>
    hub.audit.record({ at: new Date().toISOString(), kind, actor, resourceKind: 'automation', resource: automation, summary, detail });
  /** An automation made, changed or deleted, said on the live stream: every open screen reads it again. No device list does. */
  const moved = (automationId: AutomationId) => hub.bus.publish({ kind: 'automation', automationId });
  const automationOf = (id: string): AutomationRecord => {
    const found = automations.get(id);
    if (!found) throw new ApiError('not-found', 'No such automation');
    return found;
  };
  /** A draft that cannot be kept: every problem, in one answer. */
  const refuseProblems = (problems: string[]) => {
    if (problems.length) throw new ApiError('invalid', problems.join('; '));
  };
  const zoned = (timeZone: string) => {
    if (!isTimeZone(timeZone)) throw new ApiError('invalid', `"${timeZone}" is not a time zone`);
  };

  return {
    automations: {
      async kit() {
        return {
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
        };
      },

      /** A draft, as its owner builds it: everything wrong with it, and how it reads — nothing kept. */
      draft: async (draft, self) => draftView(draft, self ? (automations.get(self)?.id ?? null) : null),

      list: async (filter) => (filter?.device ? automations.usingDevice(filter.device) : automations.list()).map(view),
      get: async (id) => view(automationOf(id)),

      async create(input) {
        zoned(input.timeZone);
        if (input.madeFrom && !library.recipe(input.madeFrom)) throw new ApiError('invalid', `There is no recipe called "${input.madeFrom}"`);
        if (input.key !== undefined && !KEY.test(input.key)) throw new ApiError('invalid', 'A key is lowercase letters, digits and dashes: "start-charging"');
        if (input.key !== undefined && automations.keyTaken(input.key)) throw new ApiError('conflict', `Another automation is known by "${input.key}"`);
        const result = checked(input, null);
        refuseProblems(result.problems);
        if (input.recheckMinutes && !keepsSo(input.rule)) throw new ApiError('invalid', KEEPS_SO_ONLY);
        const created = automations.create({
          ...(input.key !== undefined ? { key: input.key } : {}),
          name: input.name,
          rule: input.rule,
          madeFrom: input.madeFrom ?? null,
          roles: result.roles,
          starts: result.starts,
          timeZone: input.timeZone,
          recheckMinutes: input.recheckMinutes ?? null,
        });
        // An assistant's is a proposal: it watches until a person lets it act.
        const proposed = caller.kind === 'agent';
        record(proposed ? 'automation.proposed' : 'automation.created', created.id, proposed ? `An assistant proposed "${created.name}", only watching: ${view(created).sentence}` : `Made the automation "${created.name}", only watching on its own`, {
          madeFrom: created.madeFrom,
          rule: created.rule,
          roles: created.roles,
          starts: created.starts,
          recheckMinutes: created.recheckMinutes,
        });
        engine.poke(created.id);
        moved(created.id);
        return view(created);
      },

      async update(id, input) {
        const current = automationOf(id);
        if (input.timeZone) zoned(input.timeZone);
        if (input.key !== undefined && input.key !== current.key) {
          if (!KEY.test(input.key)) throw new ApiError('invalid', 'A key is lowercase letters, digits and dashes: "start-charging"');
          if (automations.keyTaken(input.key, current.id)) throw new ApiError('conflict', `Another automation is known by "${input.key}"`);
        }
        // A new rule comes with what fills its roles: the three together, or none.
        const rebuilt = input.rule !== undefined || input.roles !== undefined || input.starts !== undefined;
        if (rebuilt && (!input.rule || !input.roles || !input.starts)) throw new ApiError('invalid', 'A new rule comes with what fills its roles: rule, roles and starts together');
        const result = rebuilt ? checked({ rule: input.rule!, roles: input.roles!, starts: input.starts! } satisfies AutomationDraft, current.id) : null;
        if (result) refuseProblems(result.problems);
        const nextRule = result ? input.rule! : current.rule;
        const nextRecheck = input.recheckMinutes !== undefined ? input.recheckMinutes : current.recheckMinutes;
        if (nextRecheck && !keepsSo(nextRule)) throw new ApiError('invalid', KEEPS_SO_ONLY);
        const changedRule = result ? { rule: nextRule, roles: result.roles, starts: result.starts } : null;

        // Letting it act — and changing what one that acts does — is a deliberate act.
        const armedAfter = input.mode === 'act' || (input.mode === undefined && current.mode === 'act');
        // How often it keeps things so changes what it does, too.
        const recheckChanged = input.recheckMinutes !== undefined && input.recheckMinutes !== current.recheckMinutes;
        const needsConfirming = armedAfter && (current.mode !== 'act' || changedRule !== null || recheckChanged);
        const { confirmation, ...changes } = input;
        const subject = subjectOf({ automation: current.id, changes, by: actor });
        if (needsConfirming && !hub.yes.arming.accept(confirmation, subject)) {
          // What the yes is to, in words: letting it act, keeping things so while it does, or changing what it does.
          const said =
            current.mode !== 'act'
              ? 'It will switch things on its own, with nobody watching.'
              : recheckChanged && changedRule === null
                ? input.recheckMinutes
                  ? `It acts on its own: every ${input.recheckMinutes} min it will switch back what was switched by hand against it.`
                  : 'It acts on its own: from now on, what is switched by hand stays until a condition comes true again.'
                : 'It acts on its own: what it does will change.';
          throw new ApiError('needs-yes', said, { needsConfirmation: hub.yes.arming.ask(subject) });
        }
        if (armedAfter) {
          const problems = engine.roleProblems({ ...current, ...(changedRule ?? {}) });
          if (problems.length) throw new ApiError('conflict', `It cannot act as it is: ${problems.join('; ')}`);
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
            ? { off: 'Turned off', watch: 'Set to only watch on its own', act: 'Let act on its own' }[input.mode]
            : input.key !== undefined && input.key !== current.key && !changedRule && !input.name
              ? `Known in configuration as ${input.key}`
              : input.homePlace !== undefined && !changedRule && !input.name
                ? input.homePlace === null
                  ? 'Taken off the home page'
                  : 'Put on the home page'
                : 'Changed';
        record(input.mode === 'act' && current.mode !== 'act' ? 'automation.armed' : 'automation.changed', updated.id, `${said}: "${updated.name}"`, {
          before: { key: current.key, mode: current.mode, rule: current.rule, roles: current.roles, starts: current.starts, recheckMinutes: current.recheckMinutes, homePlace: current.homePlace },
          after: { key: updated.key, mode: updated.mode, rule: updated.rule, roles: updated.roles, starts: updated.starts, recheckMinutes: updated.recheckMinutes, homePlace: updated.homePlace },
        });
        // Its conditions, looked at now, after the change is on the timeline: let act while one holds, it acts at once.
        if (startsAfresh) engine.poke(updated.id);
        moved(updated.id);
        return view(updated);
      },

      async delete(id) {
        const current = automationOf(id);
        // The automations that start it are told: one of their roles has nothing to start now.
        const starting = automations.list().filter((other) => Object.values(other.starts).includes(current.id));
        if (!automations.delete(current.id)) throw new ApiError('not-found', 'No such automation');
        engine.forget(current.id);
        record('automation.deleted', current.id, `Deleted the automation "${current.name}"`);
        moved(current.id);
        for (const other of starting) moved(other.id);
      },

      /**
       * Plays it: it runs now, for real, whatever its mode — refused when it is
       * off, or already running; an assistant may start only one let act.
       * Answered as it stands once begun: one that takes steps goes on taking
       * them. On the timeline, with who started it.
       */
      async start(id) {
        const current = automationOf(id);
        const run = await engine.startAsked(current.id, { name: intent.by, actor: intent.actor }).catch((error: unknown) => {
          throw error instanceof RunRefusal ? new ApiError('conflict', error.message) : error;
        });
        record('automation.started', current.id, `Started "${current.name}"`, { run: run.id });
        return view(automations.get(current.id) ?? current);
      },

      /** Stops its run: the step it is in ends, and what it does if stopped — switching back off — runs. */
      async stop(id) {
        const current = automationOf(id);
        refusing(() => engine.stopAsked(current.id, intent.by));
        record('automation.stopping', current.id, `Stopped "${current.name}"`);
        return view(automations.get(current.id) ?? current);
      },

      /** What it would do now: decided, never acted on and never recorded, whatever its mode. */
      check: async (id) => engine.run(automationOf(id), { check: true }),

      runs: async (id, limit = 50) => automations.runs(automationOf(id).id, limit),

      async runLog(id, runId) {
        const log = engine.runLog(automationOf(id), runId);
        if (!log) throw new ApiError('not-found', 'No such run');
        return log;
      },

      /**
       * A rule rehearsed on what happened: when it would have run in the last
       * hours on its own, and what it would have done. A draft is checked
       * first. Nothing is sent and nothing is kept.
       */
      async rehearse(subject, hours = 24 * 7) {
        if ('automation' in subject) return rehearsed(automationOf(subject.automation), hours);
        zoned(subject.timeZone);
        const result = checked(subject.draft, null);
        refuseProblems(result.problems);
        return rehearsed({ rule: subject.draft.rule, roles: result.roles, timeZone: subject.timeZone }, hours);
      },

      /** A recipe copied into a rule of its own: what an assistant proposes, as the app starts from one. */
      fromRecipe: async (recipe, params) => copied(recipe, params),
    },
  };
}
