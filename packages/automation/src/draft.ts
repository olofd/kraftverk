import { capabilitiesOf, capabilityIn, meetsNeed, partName, partsOf, type AutomationId, type CapabilityName, type DeviceDescription, type SavedDeviceId } from '@kraftverk/device-sdk';

import { usedRoles } from './edit.ts';
import { NO_SETTINGS, withSettings } from './evaluate.ts';
import { isAutomationRole, isGroupRole, isPartRole, isWorldRole, roleKind, type Rule } from './rule.ts';

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
 * fills (`roles`), the parts of each group a `for each` goes through
 * (`groups`), and another automation for each role a `start` step starts
 * (`starts`).
 */
export type RoleFills = {
  roles: Record<string, RoleBinding>;
  groups: Record<string, readonly RoleBinding[]>;
  starts: Record<string, AutomationId>;
  /** Who and where fills each role of the family's world: a person, people, a place. None: it has no such role. */
  world?: Record<string, WorldFill>;
};

/** What a place a role names is: a home, a zone, or a space of a home. */
export type PlaceKind = 'home' | 'zone' | 'space';

/**
 * What fills a role of the family's world: a person by their id; people —
 * some, by their ids, or everyone in the family, whoever joins; a place by
 * its id and what it is.
 */
export type WorldFill = { person: string } | { people: readonly string[] } | { everyone: true } | { place: string; kind: PlaceKind };

/** How the people and places a draft names are called: what its sentences say for them. */
export type WorldNames = { person(id: string): string | null; place(id: string): string | null };

/** The parts filling a role: one, a group's several, or none — another automation's role, or one not filled yet. */
export const bindingsOf = (fills: Pick<RoleFills, 'roles' | 'groups'>, role: string): readonly RoleBinding[] => {
  const one = fills.roles[role];
  return one ? [one] : (fills.groups[role] ?? []);
};

/** A rule as it is being built, with what fills its roles — and the home it is for, when it says: what a room it names is of. Not said, the family's first. */
export type AutomationDraft = RoleFills & { rule: Rule; homeId?: string | null };

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

/**
 * A group in the draft filled by these parts: the one given — its parts
 * replaced — or a new one, "Parts", asking of each what all of them offer.
 */
export function groupRole<D extends AutomationDraft>(draft: D, role: string | null, parts: readonly { binding: RoleBinding; description: DeviceDescription }[]): { draft: D; role: string } {
  const offered = parts.map(({ binding, description }) => new Set(capabilitiesOf(description, binding.part).filter((capability): capability is CapabilityName => typeof capability === 'string')));
  const capabilities = offered.length ? [...offered[0]!].filter((capability) => offered.every((each) => each.has(capability))).sort() : [];
  const named = role ?? roleName(draft.rule, 'Parts');
  const current = draft.rule.roles[named];
  const label = current && isGroupRole(current) ? current.label : 'Parts';
  return {
    role: named,
    draft: {
      ...draft,
      rule: { ...draft.rule, roles: { ...draft.rule.roles, [named]: { group: true, label, capabilities } } },
      groups: { ...draft.groups, [named]: parts.map((part) => part.binding) },
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
  return { ...draft, rule: { ...draft.rule, roles: keep(draft.rule.roles) }, roles: keep(draft.roles), groups: keep(draft.groups), starts: keep(draft.starts), world: keep(draft.world ?? {}) };
}

/** The roles of a rule, by kind — one part, several, another automation — each as an editor lists them. */
export const rolesOf = (rule: Rule) => ({
  parts: Object.entries(rule.roles).filter(([, spec]) => roleKind(spec) === 'part'),
  groups: Object.entries(rule.roles).filter(([, spec]) => roleKind(spec) === 'group'),
  automations: Object.entries(rule.roles).filter(([, spec]) => roleKind(spec) === 'automation'),
  /** People and places. */
  world: Object.entries(rule.roles).filter(([, spec]) => isWorldRole(spec)),
});

/** Whether two fills of the world are the same person, people or place. */
const sameFill = (a: WorldFill, b: WorldFill): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A person, people or a place picked for a block: the role the draft fills
 * with them already — or a new one, named as they are called.
 */
export function worldRole<D extends AutomationDraft>(draft: D, fill: WorldFill, label: string): { draft: D; role: string } {
  const found = Object.entries(draft.world ?? {}).find(([role, had]) => sameFill(had, fill) && draft.rule.roles[role]);
  if (found) return { draft, role: found[0] };
  const role = roleName(draft.rule, label);
  const spec = 'place' in fill ? { place: true as const, label } : 'person' in fill ? { person: true as const, label } : { people: true as const, label };
  return { role, draft: { ...draft, rule: { ...draft.rule, roles: { ...draft.rule.roles, [role]: spec } }, world: { ...draft.world, [role]: fill } } };
}

/** A role of the world filled anew: every block naming it now names them. */
export const fillWorld = <D extends AutomationDraft>(draft: D, role: string, fill: WorldFill): D => ({ ...draft, world: { ...draft.world, [role]: fill } });

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
export const EMPTY_DRAFT: AutomationDraft = { rule: { roles: {}, params: NO_SETTINGS, when: [], then: [] }, roles: {}, groups: {}, starts: {}, world: {} };

/** A recipe's rule copied: its settings kept, at the recipe's values, for its owner to set; its roles still to fill. */
export const draftOfRecipe = (rule: Rule): AutomationDraft => ({ rule: withSettings(rule, {}), roles: {}, groups: {}, starts: {}, world: {} });

/** Whether a rule has a part for a device: one of its roles a part of it can fill. What a device's page offers to start from. */
export const ruleFits = (rule: Rule, device: { description: DeviceDescription; name: string }): boolean =>
  Object.values(rule.roles).some((spec) => (isPartRole(spec) || isGroupRole(spec)) && partsOf(device.description, device.name).some((part) => meetsNeed(spec, capabilitiesOf(device.description, part.id))));

/** A device as a draft names its parts: its id, its name, what it is. */
export type DraftDevice = { id: SavedDeviceId; name: string; description: DeviceDescription; removedAt?: string | null; meta: { name: string } };

/**
 * A role's name, as its steps say it: the part that fills it, another
 * automation in quotes — or, not filled yet, its label as words within a
 * sentence: "turn what powers the charger on".
 */
export function roleSaid(draft: AutomationDraft, role: string, devices: readonly DraftDevice[], automations: readonly { id: AutomationId; name: string }[], world?: WorldNames): string {
  const spec = draft.rule.roles[role];
  if (!spec) return 'a part not chosen yet';
  const unfilled = spec.label.charAt(0).toLowerCase() + spec.label.slice(1);
  // A person, people, a place: as the family calls them.
  if (isWorldRole(spec)) {
    const fill = draft.world?.[role];
    if (!fill) return unfilled;
    if ('everyone' in fill) return 'everyone';
    if ('person' in fill) return world?.person(fill.person) ?? spec.label;
    if ('people' in fill) {
      const names = fill.people.flatMap((id) => world?.person(id) ?? []);
      return names.length ? listed(names) : spec.label;
    }
    return world?.place(fill.place) ?? spec.label;
  }
  if (isAutomationRole(spec)) {
    const started = automations.find((automation) => automation.id === draft.starts[role]);
    return started ? `“${started.name}”` : unfilled;
  }
  // A group: its parts, named — "Garage plug and Scooter plug".
  if (isGroupRole(spec)) {
    const named = (draft.groups[role] ?? []).flatMap((binding) => {
      const device = devices.find((each) => each.id === binding.device);
      return device ? [partName(device.name, binding.part, partsOf(device.description, device.name).find((part) => part.id === binding.part)?.label)] : [];
    });
    return named.length ? listed(named) : unfilled;
  }
  const binding = draft.roles[role];
  const device = binding ? devices.find((each) => each.id === binding.device) : undefined;
  if (!device || !binding) return unfilled;
  return partName(device.name, binding.part, partsOf(device.description, device.name).find((part) => part.id === binding.part)?.label);
}

/** Names in a sentence: "A", "A and B", "A, B and C". */
export const listed = (names: readonly string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

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
