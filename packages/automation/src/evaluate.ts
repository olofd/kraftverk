import { isScalar, type ConfigSchema, type ScalarValue, type Value } from '@kraftverk/device-sdk';

import { inWindow, minutesOf } from './clock.ts';
import type { Evaluation } from './functions.ts';
import { EXPRESSION_FIELDS, fieldValue, withField } from './kinds/spec.ts';
import { stepSpec } from './kinds/steps.ts';
import { triggerSpec } from './kinds/triggers.ts';
import { calculate, type CompareOp, type Expr, type NamedTrigger, type Rule, type RunFact, type Step } from './rule.ts';

/*
  Evaluating a rule's expressions where it runs: against what its parts read
  now, its settings and its clock — unknown when anything it needs is, never
  guessed — and its settings put in for what the rule says, step by step.
*/

/** What an expression is evaluated against. */
export type RuleScope = {
  param(name: string): Value;
  /** What the part filling a role reports now for a meaning, or null when it cannot be known. */
  read(role: string, means: string): { value: ScalarValue; label: string; unit: string } | null;
  /** A function's answer; not given where calls are not allowed. */
  call?(fn: string, role: string, args: Readonly<Record<string, Value>>): Promise<Evaluation>;
  /** Whether the part filling a role can be reached now — and, when not, why. */
  reachable(role: string): { reachable: boolean | null; detail: string };
  /** How a role's part is named: "Garage station". */
  name(role: string): string;
  /** The time of day on the owner's clock, as "HH:MM"; null where there is none. */
  clock(): string | null;
  /** A fact of the run being evaluated (`run.trigger`); null — or absent — where there is no run, or it is not known. */
  run?(fact: RunFact): Value;
};

const compare = (op: CompareOp, left: Value, right: Value): Value => {
  // Unknown is never an answer; structure is not compared.
  if (left === null || right === null || !isScalar(left) || !isScalar(right)) return null;
  switch (op) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    default:
      if (typeof left !== 'number' || typeof right !== 'number') return null;
      return op === 'lt' ? left < right : op === 'le' ? left <= right : op === 'gt' ? left > right : left >= right;
  }
};

const combine = (kind: 'all' | 'any', values: readonly Value[]): Value => {
  const decisive = kind === 'all' ? false : true;
  if (values.some((value) => value === decisive)) return decisive;
  if (values.some((value) => value === null || typeof value !== 'boolean')) return null;
  return !decisive;
};

export const shown = (value: Value, unit = ''): string =>
  value === null
    ? 'unknown'
    : typeof value === 'boolean'
      ? value ? 'yes' : 'no'
      : typeof value === 'number'
        ? `${Math.round(value * 100) / 100}${unit ? (unit === '%' ? ' %' : ` ${unit}`) : ''}`
        : typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? `${value.length} values`
            : 'a set of values';

/**
 * An expression's value, or null when it cannot be known — and, in `trace`,
 * what it read and what each function said, in words.
 */
export async function evaluate(expr: Expr, scope: RuleScope, trace: string[] = []): Promise<Value> {
  if ('call' in expr) {
    if (!scope.call) return null;
    const args: Record<string, Value> = {};
    for (const [name, arg] of Object.entries(expr.args ?? {})) args[name] = await evaluate(arg, scope, trace);
    const answer = await scope.call(expr.call, expr.role, args);
    if (answer.detail) trace.push(answer.detail);
    return answer.value;
  }
  if ('compare' in expr) return compare(expr.compare, await evaluate(expr.left, scope, trace), await evaluate(expr.right, scope, trace));
  if ('math' in expr) return calculate(expr.math, await evaluate(expr.left, scope, trace), await evaluate(expr.right, scope, trace));
  if ('all' in expr || 'any' in expr) {
    const parts = 'all' in expr ? expr.all : expr.any;
    const values: Value[] = [];
    for (const part of parts) values.push(await evaluate(part, scope, trace));
    return combine('all' in expr ? 'all' : 'any', values);
  }
  if ('not' in expr) {
    const value = await evaluate(expr.not, scope, trace);
    return typeof value === 'boolean' ? !value : null;
  }
  return evaluateNow(expr, scope, trace);
}

/** The same, for what needs no function: a `becomes` condition, evaluated on every reading. */
export function evaluateNow(expr: Expr, scope: RuleScope, trace: string[] = []): Value {
  if ('value' in expr) return expr.value;
  if ('param' in expr) return scope.param(expr.param);
  if ('read' in expr) {
    const read = scope.read(expr.read.role, expr.read.means);
    trace.push(`${scope.name(expr.read.role)}: ${read ? `${read.label} ${shown(read.value, read.unit)}` : `${expr.read.means} is not known`}`);
    return read?.value ?? null;
  }
  if ('reachable' in expr) {
    const { reachable, detail } = scope.reachable(expr.reachable);
    trace.push(`${scope.name(expr.reachable)}: ${reachable ? 'can be reached' : `cannot be reached (${detail})`}`);
    return reachable;
  }
  if ('run' in expr) return scope.run?.(expr.run) ?? null;
  if ('within' in expr) {
    const now = scope.clock();
    const [from, to] = [minutesOf(evaluateNow(expr.within.from, scope)), minutesOf(evaluateNow(expr.within.to, scope))];
    if (now === null || from === null || to === null) return null;
    trace.push(`It is ${now}`);
    return inWindow(minutesOf(now)!, from, to);
  }
  if ('compare' in expr) return compare(expr.compare, evaluateNow(expr.left, scope, trace), evaluateNow(expr.right, scope, trace));
  if ('math' in expr) return calculate(expr.math, evaluateNow(expr.left, scope, trace), evaluateNow(expr.right, scope, trace));
  if ('all' in expr) return combine('all', expr.all.map((part) => evaluateNow(part, scope, trace)));
  if ('any' in expr) return combine('any', expr.any.map((part) => evaluateNow(part, scope, trace)));
  if ('not' in expr) {
    const value = evaluateNow(expr.not, scope, trace);
    return typeof value === 'boolean' ? !value : null;
  }
  return null; // a call: not here
}

/**
 * What can be known from an automation's settings alone: each setting as it
 * stands (or its default), and nothing read — "turn it on", not "turn it
 * (action is on)".
 */
export function settledScope(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string = (role) => role): RuleScope {
  return {
    param: (key) => {
      const field = rule.params.fields[key];
      return (params[key] ?? (field && 'default' in field ? field.default : undefined) ?? null) as Value;
    },
    read: () => null,
    reachable: () => ({ reachable: null, detail: 'not known until it runs' }),
    name,
    clock: () => null,
  };
}

/**
 * The steps a choice takes when its settings alone decide it — "if you chose
 * to switch them off again" — or null when it turns on what is read as it
 * runs. A choice its owner has already made is not a step to follow: it
 * reads, and runs, as the steps it chose.
 */
export function settledChoice(rule: Rule, step: Extract<Step, { choose: unknown }>, params: Readonly<Record<string, Value>>): readonly Step[] | null {
  const decided = evaluateNow(step.choose.if, settledScope(rule, params));
  if (typeof decided !== 'boolean') return null;
  return decided ? step.choose.then : (step.choose.else ?? []);
}

/** A rule an automation owns has no settings: every value is in its blocks. */
export const NO_SETTINGS: ConfigSchema = { fields: {} };

/**
 * A recipe's settings written into its blocks — each setting its plain value
 * (or its default), a choice they decide the steps it chose — and no
 * settings left: what an automation copied from a recipe owns, and edits as
 * any other (docs/AUTOMATION-EDITOR.md).
 */
export function inlineParams(rule: Rule, values: Readonly<Record<string, Value>>): Rule {
  const scope = settledScope(rule, values);
  const args = (given: Readonly<Record<string, Expr>>): Record<string, Expr> => Object.fromEntries(Object.entries(given).map(([name, arg]) => [name, expr(arg)]));
  /**
   * Every setting its value — and what the settings alone decide, decided:
   * "15 is below 50" is true, and a condition that is part of it goes, so a
   * copy reads as what it watches, never as a check of its own sliders.
   */
  function expr(given: Expr): Expr {
    if ('param' in given) return { value: scope.param(given.param) };
    if ('call' in given) return given.args ? { call: given.call, role: given.role, args: args(given.args) } : given;
    if ('within' in given) return { within: { from: expr(given.within.from), to: expr(given.within.to) } };
    if ('math' in given) {
      const left = expr(given.left);
      const right = expr(given.right);
      // Settings alone: the number they make, written in.
      if ('value' in left && 'value' in right) return { value: calculate(given.math, left.value, right.value) };
      return { math: given.math, left, right };
    }
    if ('compare' in given) {
      const left = expr(given.left);
      const right = expr(given.right);
      if ('value' in left && 'value' in right) return { value: evaluateNow({ compare: given.compare, left, right }, scope) };
      return { compare: given.compare, left, right };
    }
    if ('all' in given || 'any' in given) {
      const every = 'all' in given;
      const parts = (every ? given.all : given.any).map(expr);
      // One part decided against the rest decides it; one decided for it is no part at all.
      if (parts.some((part) => 'value' in part && part.value === !every)) return { value: !every };
      const open = parts.filter((part) => !('value' in part && part.value === every));
      if (!open.length) return { value: every };
      if (open.length === 1) return open[0]!;
      return every ? { all: open } : { any: open };
    }
    if ('not' in given) {
      const inner = expr(given.not);
      return 'value' in inner && typeof inner.value === 'boolean' ? { value: !inner.value } : { not: inner };
    }
    return given;
  }
  const steps = (list: readonly Step[] | undefined): Step[] =>
    (list ?? []).flatMap((step) => {
      const chosen = 'choose' in step ? settledChoice(rule, step, values) : null;
      return chosen ? steps(chosen) : [one(step)];
    });
  /** A step's expressions settled, and its steps within, by its kind's fields (kinds/steps.ts). */
  function one(step: Step): Step {
    return stepSpec(step).fields.reduce<Step>((settled, field) => {
      const value = fieldValue(step, field);
      if (value === undefined) return settled;
      const type = field.type.type;
      if (EXPRESSION_FIELDS.has(type)) return withField(settled, field, expr(value as Expr));
      if (type === 'args') return withField(settled, field, args(value as Readonly<Record<string, Expr>>));
      if (type !== 'steps') return settled;
      // A branch it may go without, which its settings leave empty, is none.
      const inner = steps(value as readonly Step[]);
      return withField(settled, field, inner.length || field.required ? inner : undefined);
    }, step);
  }
  // Each trigger's expressions settled, by its kind's fields (kinds/triggers.ts); its id kept.
  const when = rule.when.map((trigger): NamedTrigger =>
    triggerSpec(trigger).fields.reduce<NamedTrigger>((settled, field) => {
      const value = fieldValue(trigger, field);
      if (value === undefined || !EXPRESSION_FIELDS.has(field.type.type)) return settled;
      const next = expr(value as Expr);
      // A length of time its settings make none — 0 — where none may be, is none: a hold of 0 min is no hold.
      const none = !field.required && field.type.type === 'duration' && 'value' in next && next.value === 0;
      return withField(settled, field, none ? undefined : next);
    }, trigger)
  );
  const fallback = steps(rule.otherwise);
  const otherwise = fallback.length ? fallback : undefined;
  // An "only if" its settings make always true is no condition at all.
  const only = rule.if ? expr(rule.if) : null;
  const keptIf = only && !('value' in only && only.value === true) ? { if: only } : {};
  return { roles: rule.roles, params: NO_SETTINGS, when, ...keptIf, then: steps(rule.then), ...(otherwise ? { otherwise } : {}) };
}
