import { capabilitiesOf, capabilityIn, meetsNeed, partName, partsOf, type AutomationId, type CapabilityName, type DeviceDescription, type SavedDeviceId } from '@kraftverk/device-sdk';

import { usedRoles } from './edit.ts';
import { NO_SETTINGS, withSettings } from './evaluate.ts';
import { isAutomationRole, type Rule } from './rule.ts';

/*
  An automation as it is being built, as data (docs/AUTOMATION-EDITOR.md): a
  rule of its own, and what fills its roles — changed only through what is
  here, each change a new draft. What any editor builds on: the app's, an
  assistant's. Pure, so it is tested without a screen.
*/

/** Which part of which device fills a role: a plug, or one of a station's outlets. */
export type RoleBinding = { device: SavedDeviceId; part: string };

/**
 * What fills an automation's roles: a part of a device for each role one
 * fills (`roles`), and another automation for each role a `start` step
 * starts (`starts`).
 */
export type RoleFills = { roles: Record<string, RoleBinding>; starts: Record<string, AutomationId> };

/** A rule as it is being built, with what fills its roles. */
export type AutomationDraft = RoleFills & { rule: Rule };

// --- roles ------------------------------------------------------------------------------

/**
 * A role's name from its label, as a file says it and its conditions read:
 * "Switch" is `switch`, "Power meter" `powerMeter` — and `switch2` beside
 * another. camelCase, as the language takes it; `part` for a label of no
 * letters it can use.
 */
export const roleName = (rule: Rule, label: string): string => {
  const words = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const stem = words.length && /^[a-z]/.test(words[0]!) ? words.map((word, index) => (index ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join('') : 'part';
  if (!rule.roles[stem]) return stem;
  for (let n = 2; ; n += 1) if (!rule.roles[`${stem}${n}`]) return `${stem}${n}`;
};

/**
 * The role a part fills in the draft: the one it already fills, or a new one
 * — asking for what the part offers, and labelled by what it is ("Switch",
 * "Battery"), not by the device's name, which can change: whatever fills it
 * is named from the device as it is now.
 */
export function partRole<D extends AutomationDraft>(draft: D, binding: RoleBinding, description: DeviceDescription): { draft: D; role: string } {
  const found = Object.entries(draft.roles).find(([, bound]) => bound.device === binding.device && bound.part === binding.part);
  if (found) return { draft, role: found[0] };
  // What it offers, in the order a file infers it: a role asked for what the rule uses of it is written as just its part.
  const offered = capabilitiesOf(description, binding.part).filter((capability): capability is CapabilityName => typeof capability === 'string');
  const capabilities = [...offered].sort();
  const label = (offered[0] ? capabilityIn(description, offered[0])?.label : undefined) ?? 'A part';
  const role = roleName(draft.rule, label);
  return {
    role,
    draft: {
      ...draft,
      rule: { ...draft.rule, roles: { ...draft.rule.roles, [role]: { label, capabilities } } },
      roles: { ...draft.roles, [role]: binding },
    },
  };
}

/** The role an automation fills in the draft, to be started: the one it already fills, or a new one — labelled as what it is, its name shown from the automation as it is now. */
export function automationRole<D extends AutomationDraft>(draft: D, automation: AutomationId): { draft: D; role: string } {
  const found = Object.entries(draft.starts).find(([, started]) => started === automation);
  if (found) return { draft, role: found[0] };
  const role = roleName(draft.rule, 'automation');
  return {
    role,
    draft: {
      ...draft,
      rule: { ...draft.rule, roles: { ...draft.rule.roles, [role]: { automation: true, label: 'Another automation' } } },
      starts: { ...draft.starts, [role]: automation },
    },
  };
}

/** The draft without the roles nothing uses any more: what is kept. */
export function pruned<D extends AutomationDraft>(draft: D): D {
  const used = usedRoles(draft.rule);
  const keep = <T>(record: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(record).filter(([role]) => used.has(role)));
  return { ...draft, rule: { ...draft.rule, roles: keep(draft.rule.roles) }, roles: keep(draft.roles), starts: keep(draft.starts) };
}

/** The part roles of a rule, and the automation roles: each as an editor lists them. */
export const rolesOf = (rule: Rule) => ({
  parts: Object.entries(rule.roles).filter(([, spec]) => !isAutomationRole(spec)),
  automations: Object.entries(rule.roles).filter(([, spec]) => isAutomationRole(spec)),
});

/**
 * The parts another automation already uses for every part this draft still
 * has to choose — the same role, filled with a part that fits it here: "Stop
 * charging" copied after "Start charging" needs the same supply and plug.
 * Each such automation, with what it would fill; none when nothing is left
 * to choose.
 */
export function sameParts(
  draft: AutomationDraft,
  others: readonly { id: AutomationId; name: string; rule: Rule; roles: Record<string, RoleBinding> }[],
  fits: (role: string, binding: RoleBinding) => boolean
): { id: AutomationId; name: string; roles: Record<string, RoleBinding> }[] {
  const open = rolesOf(draft.rule).parts.map(([role]) => role).filter((role) => !draft.roles[role]);
  if (!open.length) return [];
  return others.flatMap((other) => {
    const fill: Record<string, RoleBinding> = {};
    for (const role of open) {
      const spec = other.rule.roles[role];
      const binding = other.roles[role];
      if (!spec || isAutomationRole(spec) || !binding || !fits(role, binding)) return [];
      fill[role] = binding;
    }
    return [{ id: other.id, name: other.name, roles: fill }];
  });
}

// --- starting points --------------------------------------------------------------------

/** An automation built from nothing: no trigger, no step yet. */
export const EMPTY_DRAFT: AutomationDraft = { rule: { roles: {}, params: NO_SETTINGS, when: [], then: [] }, roles: {}, starts: {} };

/** A recipe's rule copied: its settings kept, at the recipe's values, for its owner to set; its roles still to fill. */
export const draftOfRecipe = (rule: Rule): AutomationDraft => ({ rule: withSettings(rule, {}), roles: {}, starts: {} });

/** Whether a rule has a part for a device: one of its roles a part of it can fill. What a device's page offers to start from. */
export const ruleFits = (rule: Rule, device: { description: DeviceDescription; name: string }): boolean =>
  Object.values(rule.roles).some((spec) => !isAutomationRole(spec) && partsOf(device.description, device.name).some((part) => meetsNeed(spec, capabilitiesOf(device.description, part.id))));

/** A device as a draft names its parts: its id, its name, what it is. */
export type DraftDevice = { id: SavedDeviceId; name: string; description: DeviceDescription; removedAt?: string | null; meta: { name: string } };

/**
 * A role's name, as its steps say it: the part that fills it, another
 * automation in quotes — or, not filled yet, its label as words within a
 * sentence: "turn what powers the charger on".
 */
export function roleSaid(draft: AutomationDraft, role: string, devices: readonly DraftDevice[], automations: readonly { id: AutomationId; name: string }[]): string {
  const spec = draft.rule.roles[role];
  if (!spec) return 'a part not chosen yet';
  const unfilled = spec.label.charAt(0).toLowerCase() + spec.label.slice(1);
  if (isAutomationRole(spec)) {
    const started = automations.find((automation) => automation.id === draft.starts[role]);
    return started ? `“${started.name}”` : unfilled;
  }
  const binding = draft.roles[role];
  const device = binding ? devices.find((each) => each.id === binding.device) : undefined;
  if (!device || !binding) return unfilled;
  return partName(device.name, binding.part, partsOf(device.description, device.name).find((part) => part.id === binding.part)?.label);
}

/** A part a block may use: the role it fills already — or none, a part of a device not in the draft yet. */
export type PartOption = { key: string; title: string; subtitle?: string; role: string | null; binding: RoleBinding; description: DeviceDescription; name: string };

/**
 * Every part a block may use, that `fits`: the draft's own first, by the
 * names its steps use, then each part of each device not removed — the one
 * it was started from first, what its owner came to automate.
 */
export function partOptions(
  draft: AutomationDraft,
  devices: readonly DraftDevice[],
  automations: readonly { id: AutomationId; name: string }[],
  fits: (description: DeviceDescription, part: string) => boolean,
  prefer: SavedDeviceId | null = null
): PartOption[] {
  const name = (role: string) => roleSaid(draft, role, devices, automations);
  const used = Object.entries(draft.roles).flatMap(([role, binding]): PartOption[] => {
    const device = devices.find((each) => each.id === binding.device);
    return device && fits(device.description, binding.part) ? [{ key: `role:${role}`, title: name(role), subtitle: 'Already in this automation', role, binding, description: device.description, name: name(role) }] : [];
  });
  const taken = new Set(used.map((option) => `${option.binding.device}:${option.binding.part}`));
  const others = devices
    .filter((device) => !device.removedAt)
    .sort((a, b) => Number(b.id === prefer) - Number(a.id === prefer))
    .flatMap((device) =>
      partsOf(device.description, device.name)
        .filter((part) => fits(device.description, part.id) && !taken.has(`${device.id}:${part.id}`))
        .map((part): PartOption => {
          const title = partName(device.name, part.id, part.label);
          return { key: `${device.id}:${part.id}`, title, subtitle: device.meta.name, role: null, binding: { device: device.id, part: part.id }, description: device.description, name: title };
        })
    );
  return [...used, ...others];
}
