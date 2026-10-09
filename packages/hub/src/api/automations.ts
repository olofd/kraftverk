import { ApiError, type AutomationView, type Caller, type KraftverkApi, type RecipeView } from '@kraftverk/api-contract';
import { describeSteps, hasConditions, keepsSo, takesSteps, type AutomationDraft, type RuleSteps } from '@kraftverk/automation';
import { RunRefusal, type AutomationRecord } from '@kraftverk/automation-engine';
import { isTimeZone, type AutomationId, type Value } from '@kraftverk/device-sdk';
import { subjectOf } from '@kraftverk/gateway';

import type { Hub } from '../node/hub.ts';
import { actorOf, intentOf } from './caller.ts';
import { checkKey } from './scope.ts';

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
  const { checked, draftView, rehearsed, copied } = hub.drafts;
  const actor = actorOf(caller);
  /** Who asks, by their person id: their own shortcuts. None for an assistant, or a server's account not yet anyone's. */
  const me = caller.kind === 'person' ? (caller.id ?? null) : null;
  /** An automation as this caller sees it: with its place on their own home page. */
  const view = (automation: AutomationRecord): AutomationView => ({ ...hub.drafts.view(automation), homePlace: me ? hub.shortcuts.placeOf(me, automation.id) : null });
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

  const pick = ({ steps, whenSteps }: RuleSteps) => ({ steps, whenSteps });
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
              ...pick(describeSteps(recipe, defaults, (role) => lowerFirst(recipe.roles[role]?.label ?? role), library)),
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
        if (input.timeZone) zoned(input.timeZone);
        if (input.homeId && !hub.places.home(input.homeId)) throw new ApiError('invalid', 'No such home');
        if (input.madeFrom && !library.recipe(input.madeFrom)) throw new ApiError('invalid', `There is no recipe called "${input.madeFrom}"`);
        if (input.key !== undefined) checkKey(input.key, automations.keyTaken(input.key), 'automation', 'start-charging');
        const result = checked(input, null);
        refuseProblems(result.problems);
        if (input.recheckMinutes && !keepsSo(input.rule)) throw new ApiError('invalid', KEEPS_SO_ONLY);
        const created = automations.create({
          ...(input.key !== undefined ? { key: input.key } : {}),
          name: input.name,
          rule: input.rule,
          madeFrom: input.madeFrom ?? null,
          roles: result.roles,
          groups: result.groups,
          starts: result.starts,
          scripts: result.scripts,
          world: result.world,
          homeId: input.homeId ?? null,
          timeZone: input.timeZone ?? null,
          recheckMinutes: input.recheckMinutes ?? null,
        });
        // An assistant's is a proposal: it watches until a person lets it act.
        const proposed = caller.kind === 'agent';
        record(proposed ? 'automation.proposed' : 'automation.created', created.id, proposed ? `An assistant proposed "${created.name}", only watching: ${view(created).sentence}` : `Made the automation "${created.name}", only watching on its own`, {
          madeFrom: created.madeFrom,
          rule: created.rule,
          roles: created.roles,
          groups: created.groups,
          starts: created.starts,
          world: created.world,
          recheckMinutes: created.recheckMinutes,
        });
        engine.poke(created.id);
        moved(created.id);
        return view(created);
      },

      async update(id, input) {
        const current = automationOf(id);
        // Its place on the caller's own home page: theirs alone, and no change to the automation.
        if (input.homePlace !== undefined) {
          if (!me) throw new ApiError('forbidden', 'Only a person has a home page of their own');
          const was = hub.shortcuts.placeOf(me, current.id);
          hub.shortcuts.place(me, current.id, input.homePlace);
          if ((was === null) !== (input.homePlace === null))
            record('automation.placed', current.id, `${input.homePlace === null ? 'Taken off' : 'Put on'} ${hub.people.get(me)?.name ?? 'their'}'s home page: "${current.name}"`, { before: { homePlace: was }, after: { homePlace: input.homePlace } });
          const { homePlace: _homePlace, ...rest } = input;
          if (!Object.values(rest).some((value) => value !== undefined)) {
            moved(current.id);
            return view(current);
          }
          input = rest;
        }
        if (input.timeZone) zoned(input.timeZone);
        if (input.homeId && !hub.places.home(input.homeId)) throw new ApiError('invalid', 'No such home');
        if (input.key !== undefined && input.key !== current.key) checkKey(input.key, automations.keyTaken(input.key, current.id), 'automation', 'start-charging');
        // A new rule comes with what fills its roles: all of them together, or none.
        const rebuilt = input.rule !== undefined || input.roles !== undefined || input.groups !== undefined || input.starts !== undefined;
        if (rebuilt && (!input.rule || !input.roles || !input.groups || !input.starts)) throw new ApiError('invalid', 'A new rule comes with what fills its roles: rule, roles, groups and starts together');
        // Who and where filled anew, or another home — whose rooms are what it may name: checked again, as a new rule is.
        const homeChanged = input.homeId !== undefined && input.homeId !== current.homeId;
        const recheck = rebuilt || input.world !== undefined || input.scripts !== undefined || homeChanged;
        const result = recheck
          ? checked(
              {
                rule: input.rule ?? current.rule,
                roles: input.roles ?? current.roles,
                groups: input.groups ?? current.groups,
                starts: input.starts ?? current.starts,
                // Scripts are filled with the rule: a new rule that says none has none.
                scripts: input.scripts ?? (rebuilt ? {} : current.scripts),
                world: input.world ?? current.world,
                homeId: input.homeId !== undefined ? input.homeId : current.homeId,
              } satisfies AutomationDraft,
              current.id
            )
          : null;
        if (result) refuseProblems(result.problems);
        const nextRule = input.rule ?? current.rule;
        const nextRecheck = input.recheckMinutes !== undefined ? input.recheckMinutes : current.recheckMinutes;
        if (nextRecheck && !keepsSo(nextRule)) throw new ApiError('invalid', KEEPS_SO_ONLY);
        // Another home is another place to act: what it does changes as a new rule does.
        const changedRule = result ? { rule: nextRule, roles: result.roles, groups: result.groups, starts: result.starts, scripts: result.scripts, world: result.world } : null;

        // Letting it act — and changing what one that acts does — is a deliberate act.
        const armedAfter = input.mode === 'act' || (input.mode === undefined && current.mode === 'act');
        // How often it keeps things so changes what it does, too.
        const recheckChanged = input.recheckMinutes !== undefined && input.recheckMinutes !== current.recheckMinutes;
        const needsConfirming = armedAfter && (current.mode !== 'act' || changedRule !== null || recheckChanged);
        const { confirmation, ...changes } = input;
        const subject = subjectOf({ automation: current.id, changes, by: actor });
        if (needsConfirming && !hub.yes.lettingAct.accept(confirmation, subject)) {
          // What the yes is to, in words: letting it act, keeping things so while it does, or changing what it does.
          const said =
            current.mode !== 'act'
              ? 'It will switch things on its own, with nobody watching.'
              : recheckChanged && changedRule === null
                ? input.recheckMinutes
                  ? `It acts on its own: every ${input.recheckMinutes} min it will switch back what was switched by hand against it.`
                  : 'It acts on its own: from now on, what is switched by hand stays until a condition comes true again.'
                : 'It acts on its own: what it does will change.';
          throw new ApiError('needs-yes', said, { needsConfirmation: hub.yes.lettingAct.ask(subject) });
        }
        if (armedAfter) {
          const problems = engine.roleProblems({ ...current, ...(changedRule ?? {}) });
          if (problems.length) throw new ApiError('conflict', `It cannot act as it is: ${problems.join('; ')}`);
        }

        // What it watches, or how it may act, changed: its conditions start afresh, and one already true is its edge.
        // A new name, or how often it keeps things so, changes neither: what it did stands.
        const startsAfresh = changedRule !== null || (input.mode !== undefined && input.mode !== current.mode);
        if (startsAfresh) engine.reset(current.id);
        const updated = automations.update(current.id, {
          ...(input.name ? { name: input.name } : {}),
          ...(input.key ? { key: input.key } : {}),
          ...(changedRule ?? {}),
          ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
          ...(input.homeId !== undefined ? { homeId: input.homeId } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          // The yes it acts on is the person's who gave it: what its scripts do, they do for them.
          ...(needsConfirming ? { actingFor: caller.kind === 'person' ? (caller.id ?? null) : null } : {}),
          ...(input.recheckMinutes !== undefined ? { recheckMinutes: input.recheckMinutes } : {}),
        })!;
        const said =
          input.mode && input.mode !== current.mode
            ? { off: 'Turned off', watch: 'Set to only watch on its own', act: 'Let act on its own' }[input.mode]
            : input.key !== undefined && input.key !== current.key && !changedRule && !input.name
              ? `Known in configuration as ${input.key}`
              : 'Changed';
        record(input.mode === 'act' && current.mode !== 'act' ? 'automation.let-act' : 'automation.changed', updated.id, `${said}: "${updated.name}"`, {
          before: { key: current.key, mode: current.mode, rule: current.rule, roles: current.roles, starts: current.starts, recheckMinutes: current.recheckMinutes },
          after: { key: updated.key, mode: updated.mode, rule: updated.rule, roles: updated.roles, starts: updated.starts, recheckMinutes: updated.recheckMinutes },
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
        const asker = intent.by;
        if (asker.kind === 'automation') throw new ApiError('forbidden', 'A script cannot start an automation');
        const run = await engine.startAsked(current.id, { ...asker, kind: asker.kind }).catch((error: unknown) => {
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
