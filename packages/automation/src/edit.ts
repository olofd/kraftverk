import { fieldValue, withField, type FieldSpec } from './kinds/spec.ts';
import { STEP_KIND_ORDER, STEP_KINDS, stepSpec, type StepKind } from './kinds/steps.ts';
import { ruleCommands, ruleUses } from './reads.ts';
import { SEQUENCE_LIMITS, type Rule, type Step } from './rule.ts';

/*
  Edits to a rule, as data (docs/AUTOMATION-EDITOR.md): where a list of steps
  is — the rule's own, a trigger's own, what it does if a step does not
  succeed, or one within a step — and the rule with a step there added,
  changed, moved or removed, each a new rule. What any editor builds on: the
  app's, an assistant's.
*/

/** A list of steps at the top of a rule: its own (`then`), a trigger's own, by its place under `when`, or what it does if a step does not succeed. */
export type ListRoot = 'then' | 'otherwise' | { when: number };

/** Where a list of steps is: at the top of the rule, or within a step there. */
export type ListPath = { root: ListRoot; trail: readonly { index: number; branch: Branch }[] };

/** The lists a step holds, by the last word of where each is kept: a retry's, a choice's or a watch's two. */
export type Branch = 'retry' | 'then' | 'else';

/** A step's field that holds the list of a branch (kinds/steps.ts). */
const branchField = (step: Step, branch: Branch): FieldSpec | undefined => stepSpec(step).fields.find((field) => field.type.type === 'steps' && field.data.at(-1) === branch);

/** The branches whose steps may not wait for what might not come: a retry's — it would only fail again. */
const UNSURE_BRANCHES: ReadonlySet<string> = new Set(
  STEP_KIND_ORDER.flatMap((kind) => STEP_KINDS[kind].fields.flatMap((field) => (field.type.type === 'steps' && field.type.sure === false ? [field.data.at(-1)!] : [])))
);

export const THEN: ListPath = { root: 'then', trail: [] };

export const OTHERWISE: ListPath = { root: 'otherwise', trail: [] };

/** A trigger's own steps: its place under `when`. */
export const triggerSteps = (index: number): ListPath => ({ root: { when: index }, trail: [] });

/** The steps at the top of a rule, at a root. */
const rootList = (rule: Rule, root: ListRoot): readonly Step[] =>
  typeof root === 'object' ? (rule.when[root.when]?.then ?? []) : root === 'then' ? rule.then : (rule.otherwise ?? []);

/** The list a step holds, by its branch. */
const branchOf = (step: Step, branch: Branch): readonly Step[] => {
  const field = branchField(step, branch);
  return field ? ((fieldValue(step, field) as readonly Step[] | undefined) ?? []) : [];
};

/** The step with one of its lists replaced. */
const withBranch = (step: Step, branch: Branch, list: Step[]): Step => {
  const field = branchField(step, branch);
  return field ? withField(step, field, list) : step;
};

/** The steps at a place. */
export function listAt(rule: Rule, path: ListPath): readonly Step[] {
  let list: readonly Step[] = rootList(rule, path.root);
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
  const next = inner(rootList(rule, path.root), path.trail);
  const root = path.root;
  if (root === 'then') return { ...rule, then: next };
  // A trigger with no steps of its own left takes the rule's again: none is said, not an empty list.
  if (typeof root === 'object') {
    return {
      ...rule,
      when: rule.when.map((trigger, at) => {
        if (at !== root.when) return trigger;
        const { then: _then, ...rest } = trigger;
        return next.length ? { ...rest, then: next } : rest;
      }),
    };
  }
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

/** How deep a list is: 1 for the rule's own; the language stops at `SEQUENCE_LIMITS.depth`. */
export const depthOf = (path: ListPath): number => 1 + path.trail.length;

/**
 * The kinds of step a list may take. In a retry, and after a failure, nothing
 * waits for what might not come — it would fail again — and a start is not
 * waited for there.
 */
export function kindsFor(path: ListPath): StepKind[] {
  const sure = mayWait(path);
  const deeper = depthOf(path) < SEQUENCE_LIMITS.depth;
  return STEP_KIND_ORDER.filter((kind) => {
    const spec = STEP_KINDS[kind];
    const nests = spec.fields.some((field) => field.type.type === 'steps');
    return (sure || !spec.waits) && (deeper || !nests);
  });
}

/** Whether steps in this list may wait for what might not come — a condition, an automation's end: not after a failure, nor in a retry. */
export const mayWait = (path: ListPath): boolean => path.root !== 'otherwise' && !path.trail.some((step) => UNSURE_BRANCHES.has(step.branch));

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

/** A new step of a kind, about `role` where it needs a part or an automation: its kind's own start (kinds/steps.ts). */
export const blankStep = (kind: StepKind, role: string | null): Step => STEP_KINDS[kind].blank(role);

/**
 * A trigger's id, for a condition that asks which started the run
 * (`run.trigger`): the one it has, or a fresh one given it — "trigger1",
 * "trigger2", none another trigger has. The rule, with it.
 */
export function triggerIdOf(rule: Rule, index: number): { rule: Rule; id: string } {
  const trigger = rule.when[index];
  if (!trigger) throw new Error(`The rule has no trigger ${index + 1}`);
  if (trigger.id) return { rule, id: trigger.id };
  const taken = new Set(rule.when.map((each) => each.id));
  let n = index + 1;
  while (taken.has(`trigger${n}`)) n += 1;
  const id = `trigger${n}`;
  return { rule: { ...rule, when: rule.when.map((each, at) => (at === index ? { ...each, id } : each)) }, id };
}
