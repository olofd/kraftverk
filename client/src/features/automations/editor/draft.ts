import type { AutomationDraft, AutomationId, RecipeView, RoleBinding } from '@kraftverk/api-client';
import { capabilitiesOf, capabilityIn, type CapabilityName, type DeviceDescription, type Value } from '@kraftverk/device-sdk';
import {
  inlineParams,
  isAutomationRole,
  NO_SETTINGS,
  ruleCommands,
  ruleUses,
  stepKind,
  usedRoles,
  type Expr,
  type Rule,
  type Step,
  type StepKind,
} from '@kraftverk/automation';

/*
  The editor's draft, as data (docs/AUTOMATION-EDITOR.md): a rule of the
  automation's own, what fills its roles, and its name — changed only through
  what is here, each change a new draft. Pure: every screen of the editor is
  drawn from it, and its tests read it without a screen.
*/

/** An automation as it is being built. */
export type Draft = AutomationDraft & { name: string };


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
export function partRole(draft: Draft, binding: RoleBinding, description: DeviceDescription): { draft: Draft; role: string } {
  const found = Object.entries(draft.roles).find(([, bound]) => bound.device === binding.device && bound.part === binding.part);
  if (found) return { draft, role: found[0] };
  // What it offers, in the order a file infers it: a role asked for what the rule uses of it is written as just its part.
  const capabilities = capabilitiesOf(description, binding.part)
    .filter((capability): capability is CapabilityName => typeof capability === 'string')
    .sort();
  const offered = capabilitiesOf(description, binding.part).filter((capability): capability is CapabilityName => typeof capability === 'string');
  const label = (offered[0] ? capabilityIn(description, offered[0])?.label : undefined) ?? 'A part';
  const role = roleName(draft.rule, label);
  return {
    role,
    draft: {
      ...draft,
      rule: { ...draft.rule, roles: { ...draft.rule.roles, [role]: { label, description: label, capabilities } } },
      roles: { ...draft.roles, [role]: binding },
    },
  };
}

/** The role an automation fills in the draft, to be started: the one it already fills, or a new one — labelled as what it is, its name shown from the automation as it is now. */
export function automationRole(draft: Draft, automation: AutomationId): { draft: Draft; role: string } {
  const found = Object.entries(draft.starts).find(([, started]) => started === automation);
  if (found) return { draft, role: found[0] };
  const role = roleName(draft.rule, 'automation');
  return {
    role,
    draft: {
      ...draft,
      rule: { ...draft.rule, roles: { ...draft.rule.roles, [role]: { automation: true, label: 'Another automation', description: 'An automation it starts' } } },
      starts: { ...draft.starts, [role]: automation },
    },
  };
}


/** The draft without the roles nothing uses any more: what is kept. */
export function pruned(draft: Draft): Draft {
  const used = usedRoles(draft.rule);
  const keep = <T>(record: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(record).filter(([role]) => used.has(role)));
  return { ...draft, rule: { ...draft.rule, roles: keep(draft.rule.roles) }, roles: keep(draft.roles), starts: keep(draft.starts) };
}

/** The part roles of a rule, and the automation roles: each as the editor lists them. */
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
  draft: Draft,
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
export const EMPTY: Draft = { name: '', rule: { roles: {}, params: NO_SETTINGS, when: [], then: [] }, roles: {}, starts: {} };

/** A recipe copied: its settings, at their defaults, written into its blocks; its roles still to fill. */
export function fromRecipe(recipe: RecipeView): Draft {
  const defaults = Object.fromEntries(Object.entries(recipe.rule.params.fields).map(([key, field]) => [key, ('default' in field ? field.default : null) as Value]));
  return { name: recipe.label, rule: inlineParams(recipe.rule, defaults), roles: {}, starts: {} };
}

// --- blocks -----------------------------------------------------------------------------

/** A condition to start from: whether the part the step is about can be reached — or, with none yet, yes. */
const someCondition = (role: string | null): Expr => (role ? { reachable: role } : { value: true });

/** A new step of a kind, about `role` where it needs a part or an automation: its values a sensible start. */
export function blankStep(kind: StepKind, role: string | null): Step {
  switch (kind) {
    case 'command':
      return { command: { role: role ?? '', capability: 'switch', command: 'set', args: { on: { value: true } } } };
    case 'write':
      return { write: { role: role ?? '', key: '', value: { value: true } } };
    case 'wait':
      return { wait: { seconds: { value: 10 } } };
    case 'waitUntil':
      return { waitUntil: { condition: someCondition(role), atMostSeconds: { value: 120 } } };
    case 'ensure':
      return { ensure: { condition: someCondition(role), withinSeconds: { value: 20 }, tries: { value: 3 }, retry: [] } };
    case 'choose':
      return { choose: { if: someCondition(role), then: [], else: [] } };
    case 'watch':
      return { watch: { condition: someCondition(role), seconds: { value: 5 }, then: [] } };
    case 'start':
      return { start: { role: role ?? '' } };
  }
}

/** What each kind of step is called, and what it does: the editor's words for them. */
export const KINDS: Record<StepKind, { label: string; says: string }> = {
  command: { label: 'Switch or send', says: 'A command to a part: on, off, or what else it takes.' },
  write: { label: 'Change a setting', says: 'A setting the part keeps: its live readings, its light, what it does after a power cut.' },
  wait: { label: 'Pause', says: 'Wait a while before the next step.' },
  waitUntil: { label: 'Wait until', says: 'Wait for something to be so — at most so long, or the run does not succeed.' },
  ensure: { label: 'Make sure', says: 'Something must come true in time; if not, take steps and look again, a few times at most.' },
  choose: { label: 'If', says: 'One way or the other, as something is now.' },
  watch: { label: 'Watch', says: 'Watch something for a while: steps if it stays so, others the moment it does not.' },
  start: { label: 'Start another automation', says: 'Start one of your automations — and wait for it to end, if you like.' },
};

/** The kind of a step, as the editor names it. */
export const kindOf = (step: Step) => KINDS[stepKind(step)];

/** Seconds as the editor shows them, and back: a whole number of seconds or minutes. */
export const secondsOf = (expr: Expr | undefined): number | null => (expr && 'value' in expr && typeof expr.value === 'number' ? expr.value : null);
