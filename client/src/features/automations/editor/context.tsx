import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { AutomationView, DeviceView, FunctionView, RecipeView } from '@kraftverk/api-client';
import { capitalise, describeExpr, describeSteps, describeTriggers, draftOfRecipe, eachAt, eachNames, eachSaid, EMPTY_DRAFT, partOptions, partRole, roleSaid, writtenAttribute, type AutomationDraft, type AutomationFunction, type Expr, type ListPath, type PartOption, type RoleBinding, type RuleVocabulary, type Step, type Trigger } from '@kraftverk/automation';
import { capabilitiesOf, meetsNeed, type CapabilityNeed, type DeviceDescription, type SavedDeviceId } from '@kraftverk/device-sdk';

import { useAnswer } from '../../../components/useAnswer';
import { useFamily } from '../../../state/FamilyProvider';
import type { WorldOptions } from './world';

/** An automation as it is being built (`@kraftverk/automation`'s draft), and its name. */
export type Draft = AutomationDraft & { name: string };

/** An automation built from nothing: no name, no trigger, no step yet. */
export const EMPTY: Draft = { name: '', ...EMPTY_DRAFT };

/** A recipe copied: named as it is, its settings at their defaults written into its blocks, its roles still to fill. */
export const fromRecipe = (recipe: RecipeView): Draft => ({ name: recipe.label, ...draftOfRecipe(recipe.rule) });

/**
 * What every part of the editor works on: the draft and how to change it, the
 * devices and automations it can use, and the functions its conditions may
 * ask. One provider, so a block deep in a sequence changes the draft as the
 * screen does.
 */
export type EditorKit = {
  draft: Draft;
  change: (next: (draft: Draft) => Draft) => void;
  devices: readonly DeviceView[];
  /** The other automations: what a "start" block may start. */
  automations: readonly AutomationView[];
  functions: readonly FunctionView[];
  /** The device a new one was started from: its parts are offered first. */
  prefer?: string | null;
  /** The family's people, places and modes: who and where a block may name. */
  world: WorldOptions;
};

const EditorContext = createContext<EditorKit | null>(null);

/** What the editor needs from the home: the recipes and functions it offers, and the automations a step may start. */
export function useEditorKit() {
  const { api } = useFamily();
  const { value, error } = useAnswer(() => Promise.all([api.automations.kit(), api.automations.list()]), [api]);
  return { kit: value?.[0] ?? null, automations: value?.[1] ?? null, error };
}

export function EditorProvider({ kit, children }: { kit: EditorKit; children: ReactNode }) {
  return <EditorContext.Provider value={kit}>{children}</EditorContext.Provider>;
}

/** The editor's kit, and what it knows how to say and pick. */
export function useEditor() {
  const kit = useContext(EditorContext);
  if (!kit) throw new Error('The editor is used outside its provider');
  const { draft, devices, automations, functions, prefer, world } = kit;

  return useMemo(() => {
    const deviceOf = (binding: RoleBinding | undefined) => (binding ? devices.find((device) => device.id === binding.device) : undefined);
    /** What each "for each" calls each part, and its group. */
    const each = eachNames(draft.rule);
    /** A role's name, as its steps say it — what a "for each" calls each part, as "each part". */
    const name = (role: string): string => (each[role] && !draft.rule.roles[role] ? eachSaid(role) : roleSaid(draft, role, devices, automations, world.names));
    /**
     * The part filling a role: its device's description, and which part — for
     * what a "for each" calls each part, its group's first: what its blocks
     * offer to send and set is what that part offers.
     */
    const partOf = (role: string): { description: DeviceDescription; part: string; device: DeviceView } | null => {
      const binding = draft.roles[role] ?? (each[role] ? draft.groups[each[role]!]?.[0] : undefined);
      const device = deviceOf(binding);
      return device && binding ? { description: device.description, part: binding.part, device } : null;
    };
    const vocabulary: RuleVocabulary = {
      fn: (id) => (functions.find((fn) => fn.id === id) as unknown as AutomationFunction | undefined) ?? null,
      ...(world.modes.length ? { modes: () => world.modes } : {}),
      attribute: (role, target) => {
        const bound = partOf(role);
        return bound ? writtenAttribute(bound.description, bound.part, target) : null;
      },
    };
    /** One step in words, as its card shows it. */
    const said = (step: Step): string => describeSteps({ ...draft.rule, then: [step], otherwise: [] }, {}, name, vocabulary).steps[0]?.text ?? '';
    /** A condition in words. */
    const saidExpr = (expr: Expr): string => describeExpr(draft.rule, expr, {}, name, vocabulary);
    /** What starts it, one trigger, in words: "At 07:00 on weekdays". */
    const saidTrigger = (trigger: Trigger): string => describeTriggers({ ...draft.rule, when: [trigger] }, {}, name, vocabulary)[0] ?? '';
    /**
     * Every part a block may use: within a "for each", each part of its group
     * first — then the draft's own, then each part of each of your devices
     * that fits.
     */
    const parts = (fits: (description: DeviceDescription, part: string) => boolean, path?: ListPath): PartOption[] => {
      const inLoops = (path ? eachAt(draft.rule, path) : []).flatMap(({ as, in: group }): PartOption[] => {
        const first = draft.groups[group]?.[0];
        const device = deviceOf(first);
        if (!first || !device || !fits(device.description, first.part)) return [];
        const title = capitalise(eachSaid(as));
        return [{ key: `each:${as}`, title, subtitle: `Of ${name(group)}`, role: as, binding: first, description: device.description, name: title }];
      });
      return [...inLoops, ...partOptions(draft, devices, automations, fits, (prefer ?? null) as SavedDeviceId | null)];
    };
    /** Parts that offer what a need asks. */
    const offering = (need: CapabilityNeed) => (description: DeviceDescription, part: string) => meetsNeed(need, capabilitiesOf(description, part));
    /** Whether a block's part is chosen: a role of the draft's, or what a "for each" calls each part. */
    const chosen = (role: string): boolean => Boolean(role && (draft.rule.roles[role] || each[role]));
    return { ...kit, name, partOf, vocabulary, said, saidExpr, saidTrigger, parts, offering, chosen };
  }, [kit, draft, devices, automations, functions, prefer, world]);
}

/** A part picked for a block: the role it fills — its own, or a new one — and the draft with it. */
export function pickPart(draft: Draft, option: PartOption): { draft: Draft; role: string } {
  return option.role ? { draft, role: option.role } : partRole(draft, option.binding, option.description);
}
