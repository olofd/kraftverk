import type { AutomationDraft, AutomationId, RecipeView, RoleBinding } from '@kraftverk/api-client';
import {
  capabilitiesOf,
  capabilityIn,
  inlineParams,
  isAutomationRole,
  NO_SETTINGS,
  ruleCommands,
  ruleUses,
  stepKind,
  type CapabilityName,
  type DeviceDescription,
  type Expr,
  type Rule,
  type Step,
  type StepKind,
  type Value,
} from '@kraftverk/device-sdk';

/*
  The editor's draft, as data (docs/AUTOMATION-EDITOR.md): a rule of the
  automation's own, what fills its roles, and its name — changed only through
  what is here, each change a new draft. Pure: every screen of the editor is
  drawn from it, and its tests read it without a screen.
*/

/** An automation as it is being built. */
export type Draft = AutomationDraft & { name: string };

/** Where a list of steps is: the rule's own (`then`), what it does if a step does not succeed, or one within a step. */
export type ListPath = { root: 'then' | 'otherwise'; trail: readonly { index: number; branch: Branch }[] };

/** The lists a step holds: a retry's, a choice's or a watch's two. */
export type Branch = 'retry' | 'then' | 'else';

export const THEN: ListPath = { root: 'then', trail: [] };
export const OTHERWISE: ListPath = { root: 'otherwise', trail: [] };

/** The list a step holds, by its branch. */
const branchOf = (step: Step, branch: Branch): readonly Step[] => {
  if ('ensure' in step && branch === 'retry') return step.ensure.retry;
  if ('choose' in step && branch !== 'retry') return (branch === 'then' ? step.choose.then : step.choose.else) ?? [];
  if ('watch' in step && branch !== 'retry') return (branch === 'then' ? step.watch.then : step.watch.else) ?? [];
  return [];
};

/** The step with one of its lists replaced. */
const withBranch = (step: Step, branch: Branch, list: Step[]): Step => {
  if ('ensure' in step) return { ensure: { ...step.ensure, retry: list } };
  if ('choose' in step) return { choose: { ...step.choose, [branch === 'else' ? 'else' : 'then']: list } };
  if ('watch' in step) return { watch: { ...step.watch, [branch === 'else' ? 'else' : 'then']: list } };
  return step;
};

/** The steps at a place. */
export function listAt(rule: Rule, path: ListPath): readonly Step[] {
  let list: readonly Step[] = rule[path.root] ?? [];
  for (const { index, branch } of path.trail) list = list[index] ? branchOf(list[index]!, branch) : [];
  return list;
}

/** The rule with the steps at a place changed. */
export function withList(rule: Rule, path: ListPath, change: (list: Step[]) => Step[]): Rule {
  const inner = (list: readonly Step[], trail: ListPath['trail']): Step[] => {
    const [first, ...rest] = trail;
    if (!first) return change([...list]);
    return list.map((step, at) => (at === first.index ? withBranch(step, first.branch, inner(branchOf(step, first.branch), rest)) : step));
  };
  const next = inner(rule[path.root] ?? [], path.trail);
  if (path.root === 'then') return { ...rule, then: next };
  const { otherwise: _otherwise, ...rest } = rule;
  return next.length ? { ...rest, otherwise: next } : rest;
}

/** The rule with one step changed. */
export const withStep = (rule: Rule, path: ListPath, index: number, change: (step: Step) => Step): Rule =>
  withList(rule, path, (list) => list.map((step, at) => (at === index ? change(step) : step)));

export const insertStep = (rule: Rule, path: ListPath, index: number, step: Step): Rule => withList(rule, path, (list) => [...list.slice(0, index), step, ...list.slice(index)]);

export const removeStep = (rule: Rule, path: ListPath, index: number): Rule => withList(rule, path, (list) => list.filter((_, at) => at !== index));

/** One step moved up (-1) or down (+1) its list; at an end, it stays. */
export const moveStep = (rule: Rule, path: ListPath, index: number, by: -1 | 1): Rule =>
  withList(rule, path, (list) => {
    const to = index + by;
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    [next[index], next[to]] = [next[to]!, next[index]!];
    return next;
  });

/** A list within a step: its path. */
export const within = (path: ListPath, index: number, branch: Branch): ListPath => ({ root: path.root, trail: [...path.trail, { index, branch }] });

/** How deep a list is: 1 for the rule's own; the language stops at four. */
export const depthOf = (path: ListPath): number => 1 + path.trail.length;

/**
 * The kinds of step a list may take. In a retry, and after a failure, nothing
 * waits for what might not come — it would fail again — and a start is not
 * waited for there.
 */
export function kindsFor(path: ListPath): StepKind[] {
  const sure = path.root === 'then' && !path.trail.some((step) => step.branch === 'retry');
  const deeper = depthOf(path) < 4;
  return (['command', 'write', 'wait', ...(sure ? (['waitUntil'] as const) : []), ...(sure && deeper ? (['ensure'] as const) : []), ...(deeper ? (['choose', 'watch'] as const) : []), 'start'] as StepKind[]);
}

/** Whether a start in this list may wait for the automation it starts. */
export const mayWait = (path: ListPath): boolean => path.root === 'then' && !path.trail.some((step) => step.branch === 'retry');

// --- roles ------------------------------------------------------------------------------

/** A role name the language takes: camelCase, not yet in the rule. */
const freshRole = (rule: Rule, stem: string): string => {
  for (let n = 1; ; n += 1) if (!rule.roles[`${stem}${n}`]) return `${stem}${n}`;
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
  const role = freshRole(draft.rule, 'part');
  const capabilities = capabilitiesOf(description, binding.part).filter((capability): capability is CapabilityName => typeof capability === 'string');
  const label = (capabilities[0] ? capabilityIn(description, capabilities[0])?.label : undefined) ?? 'A part';
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
  const role = freshRole(draft.rule, 'automation');
  return {
    role,
    draft: {
      ...draft,
      rule: { ...draft.rule, roles: { ...draft.rule.roles, [role]: { automation: true, label: 'Another automation', description: 'An automation it starts' } } },
      starts: { ...draft.starts, [role]: automation },
    },
  };
}

/** The roles the rule uses: what it reads, asks, waits on, switches, writes or starts. */
export function usedRoles(rule: Rule): Set<string> {
  const uses = ruleUses(rule);
  return new Set([
    ...uses.reads.map((read) => read.role),
    ...uses.events.map((event) => event.role),
    ...uses.calls.map((call) => call.role),
    ...uses.reaches,
    ...uses.writes.map((write) => write.role),
    ...uses.starts,
    ...ruleCommands(rule).map((command) => command.role),
  ]);
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
