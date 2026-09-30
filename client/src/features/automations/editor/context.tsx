import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { AutomationView, DeviceView, FunctionView, RoleBinding } from '@kraftverk/api-client';
import {
  capabilitiesOf,
  describeExpr,
  describeSteps,
  isAutomationRole,
  meetsNeed,
  partName,
  partsOf,
  writtenAttribute,
  type AutomationFunction,
  type CapabilityNeed,
  type DeviceDescription,
  type Expr,
  type RuleVocabulary,
  type Step,
} from '@kraftverk/device-sdk';

import { partRole, type Draft } from './draft';

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
};

const EditorContext = createContext<EditorKit | null>(null);

export function EditorProvider({ kit, children }: { kit: EditorKit; children: ReactNode }) {
  return <EditorContext.Provider value={kit}>{children}</EditorContext.Provider>;
}

/** A part a block can use: one the draft already names, or one of your devices'. */
export type PartOption = { key: string; title: string; subtitle?: string; role: string | null; binding: RoleBinding; description: DeviceDescription; name: string };

/** The editor's kit, and what it knows how to say and pick. */
export function useEditor() {
  const kit = useContext(EditorContext);
  if (!kit) throw new Error('The editor is used outside its provider');
  const { draft, devices, automations, functions } = kit;

  return useMemo(() => {
    const deviceOf = (binding: RoleBinding | undefined) => (binding ? devices.find((device) => device.id === binding.device) : undefined);
    /** A role's name, as its steps say it: its part, its automation in quotes — or its label, not filled yet. */
    const name = (role: string): string => {
      const spec = draft.rule.roles[role];
      if (!spec) return 'a part not chosen yet';
      // Not filled yet: its label, as words within a sentence — "turn what powers the charger on".
      const unfilled = spec.label.charAt(0).toLowerCase() + spec.label.slice(1);
      if (isAutomationRole(spec)) {
        const started = automations.find((automation) => automation.id === draft.starts[role]);
        return started ? `“${started.name}”` : unfilled;
      }
      const binding = draft.roles[role];
      const device = deviceOf(binding);
      if (!device || !binding) return unfilled;
      return partName(device.name, binding.part, partsOf(device.description, device.name).find((part) => part.id === binding.part)?.label);
    };
    /** The part filling a role: its device's description, and which part. */
    const partOf = (role: string): { description: DeviceDescription; part: string; device: DeviceView } | null => {
      const binding = draft.roles[role];
      const device = deviceOf(binding);
      return device && binding ? { description: device.description, part: binding.part, device } : null;
    };
    const vocabulary: RuleVocabulary = {
      fn: (id) => (functions.find((fn) => fn.id === id) as unknown as AutomationFunction | undefined) ?? null,
      attribute: (role, target) => {
        const bound = partOf(role);
        return bound ? writtenAttribute(bound.description, bound.part, target) : null;
      },
    };
    /** One step in words, as its card shows it. */
    const said = (step: Step): string => describeSteps({ ...draft.rule, then: [step], otherwise: [] }, {}, name, vocabulary).steps[0]?.text ?? '';
    /** A condition in words. */
    const saidExpr = (expr: Expr): string => describeExpr(draft.rule, expr, {}, name, vocabulary);
    /**
     * Every part a block may use: the draft's own first, by the names its
     * steps use, then each part of each of your devices that fits.
     */
    const parts = (fits: (description: DeviceDescription, part: string) => boolean): PartOption[] => {
      const used = Object.entries(draft.roles).flatMap(([role, binding]): PartOption[] => {
        const device = deviceOf(binding);
        return device && fits(device.description, binding.part) ? [{ key: `role:${role}`, title: name(role), subtitle: 'Already in this automation', role, binding, description: device.description, name: name(role) }] : [];
      });
      const taken = new Set(used.map((option) => `${option.binding.device}:${option.binding.part}`));
      const others = devices
        .filter((device) => !device.removedAt)
        .flatMap((device) =>
          partsOf(device.description, device.name)
            .filter((part) => fits(device.description, part.id) && !taken.has(`${device.id}:${part.id}`))
            .map((part): PartOption => {
              const title = partName(device.name, part.id, part.label);
              return { key: `${device.id}:${part.id}`, title, subtitle: device.meta.name, role: null, binding: { device: device.id, part: part.id }, description: device.description, name: title };
            })
        );
      return [...used, ...others];
    };
    /** Parts that offer what a need asks. */
    const offering = (need: CapabilityNeed) => (description: DeviceDescription, part: string) => meetsNeed(need, capabilitiesOf(description, part));
    return { ...kit, name, partOf, vocabulary, said, saidExpr, parts, offering };
  }, [kit, draft, devices, automations, functions]);
}

/** A part picked for a block: the role it fills — its own, or a new one — and the draft with it. */
export function pickPart(draft: Draft, option: PartOption): { draft: Draft; role: string } {
  return option.role ? { draft, role: option.role } : partRole(draft, option.binding, option.description, option.name);
}
