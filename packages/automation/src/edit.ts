import { ruleCommands, ruleUses } from './reads.ts';
import type { Rule, Step, StepKind } from './rule.ts';

/*
  Edits to a rule, as data (docs/AUTOMATION-EDITOR.md): where a list of steps
  is — the rule's own, what it does if a step does not succeed, or one within
  a step — and the rule with a step there added, changed, moved or removed,
  each a new rule. What any editor builds on: the app's, an assistant's.
*/

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
