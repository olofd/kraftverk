import { isScalar, type ConfigSchema, type ScalarValue, type Value } from '@kraftverk/device-sdk';

import { inWindow, minutesOf } from './clock.ts';
import type { Evaluation } from './functions.ts';
import { exprKind, expressionsIn, mapChildren, type ExprOf } from './kinds/exprs.ts';
import { EXPRESSION_FIELDS, fieldValue, withField } from './kinds/spec.ts';
import { stepSpec } from './kinds/steps.ts';
import { triggerFields } from './kinds/triggers.ts';
import { automationRoles, calculate, type CompareOp, type Expr, type RuleTrigger, type Rule, type RunFact, type Step } from './rule.ts';

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

const OPPOSITE: Readonly<Record<CompareOp, CompareOp>> = { lt: 'ge', le: 'gt', gt: 'le', ge: 'lt', eq: 'ne', ne: 'eq' };

/**
 * A condition's opposite, said as plainly as it can be: a comparison turned
 * round, "all of" made "any of" the opposites, a "not" undone — so what is
 * not so reads as what is: "the charge is at least 15 %", not "it is not so
 * that the charge is below 15 %". Unknown stays unknown either way.
 */
export function negation(expr: Expr): Expr {
  if ('not' in expr) return expr.not;
  if ('compare' in expr) return { ...expr, compare: OPPOSITE[expr.compare] };
  if ('all' in expr) return { any: expr.all.map(negation) };
  if ('any' in expr) return { all: expr.any.map(negation) };
  if ('value' in expr && typeof expr.value === 'boolean') return { value: !expr.value };
  return { not: expr };
}

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
 * what it read and what each function said, in words. The functions it asks
 * are asked first (the only part that waits), each with its arguments' values;
 * then it is evaluated as `evaluateNow` evaluates, with their answers: one
 * evaluator, whatever an expression holds.
 */
export async function evaluate(expr: Expr, scope: RuleScope, trace: string[] = []): Promise<Value> {
  const answers = new Map<Expr, Value>();
  for (const each of expressionsIn(expr)) {
    if (!('call' in each) || answers.has(each)) continue;
    if (!scope.call) {
      answers.set(each, null);
      continue;
    }
    const args: Record<string, Value> = {};
    for (const [name, arg] of Object.entries(each.args ?? {})) args[name] = await evaluate(arg, scope, trace);
    const answer = await scope.call(each.call, each.role, args);
    if (answer.detail) trace.push(answer.detail);
    answers.set(each, answer.value);
  }
  return evaluateNow(expr, scope, trace, answers);
}

/**
 * The same, now — for what is looked at on every reading, where nothing may
 * wait: a function it asks is unknown here, unless `answers` has already
 * asked it. Every kind of expression, or this does not compile.
 */
export function evaluateNow(expr: Expr, scope: RuleScope, trace: string[] = [], answers?: ReadonlyMap<Expr, Value>): Value {
  const now = (inner: Expr) => evaluateNow(inner, scope, trace, answers);
  const kind = exprKind(expr);
  switch (kind) {
    case 'value':
      return (expr as ExprOf<'value'>).value;
    case 'param':
      return scope.param((expr as ExprOf<'param'>).param);
    case 'read': {
      const { role, means } = (expr as ExprOf<'read'>).read;
      const read = scope.read(role, means);
      trace.push(`${scope.name(role)}: ${read ? `${read.label} ${shown(read.value, read.unit)}` : `${means} is not known`}`);
      return read?.value ?? null;
    }
    case 'reachable': {
      const role = (expr as ExprOf<'reachable'>).reachable;
      const { reachable, detail } = scope.reachable(role);
      trace.push(`${scope.name(role)}: ${reachable ? 'can be reached' : `cannot be reached (${detail})`}`);
      return reachable;
    }
    case 'run':
      return scope.run?.((expr as ExprOf<'run'>).run) ?? null;
    case 'within': {
      const { from, to } = (expr as ExprOf<'within'>).within;
      const clock = scope.clock();
      const [start, end] = [minutesOf(now(from)), minutesOf(now(to))];
      if (clock === null || start === null || end === null) return null;
      trace.push(`It is ${clock}`);
      return inWindow(minutesOf(clock)!, start, end);
    }
    case 'call':
      return answers?.get(expr) ?? null;
    case 'compare': {
      const { compare: op, left, right } = expr as ExprOf<'compare'>;
      return compare(op, now(left), now(right));
    }
    case 'math': {
      const { math: op, left, right } = expr as ExprOf<'math'>;
      return calculate(op, now(left), now(right));
    }
    case 'all':
      return combine('all', (expr as ExprOf<'all'>).all.map(now));
    case 'any':
      return combine('any', (expr as ExprOf<'any'>).any.map(now));
    case 'not': {
      const value = now((expr as ExprOf<'not'>).not);
      return typeof value === 'boolean' ? !value : null;
    }
    default: {
      const unknown: never = kind;
      throw new Error(`No way to evaluate an expression of kind ${String(unknown)}`);
    }
  }
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
    // Its parts settled first, by the kind's own children (kinds/exprs.ts); then what they settle of it.
    const settled = mapChildren(given, expr);
    const kind = exprKind(settled);
    const known = (each: Expr): each is ExprOf<'value'> => 'value' in each;
    switch (kind) {
      case 'param':
        return { value: scope.param((settled as ExprOf<'param'>).param) };
      // Settings alone: the number, or the answer, they make — written in.
      case 'math': {
        const { math: op, left, right } = settled as ExprOf<'math'>;
        return known(left) && known(right) ? { value: calculate(op, left.value, right.value) } : settled;
      }
      case 'compare': {
        const { left, right } = settled as ExprOf<'compare'>;
        return known(left) && known(right) ? { value: evaluateNow(settled, scope) } : settled;
      }
      case 'all':
      case 'any': {
        const every = kind === 'all';
        const parts = every ? (settled as ExprOf<'all'>).all : (settled as ExprOf<'any'>).any;
        // One part decided against the rest decides it; one decided for it is no part at all.
        if (parts.some((part) => known(part) && part.value === !every)) return { value: !every };
        const open = parts.filter((part) => !(known(part) && part.value === every));
        if (!open.length) return { value: every };
        if (open.length === 1) return open[0]!;
        return every ? { all: open } : { any: open };
      }
      case 'not': {
        const inner = (settled as ExprOf<'not'>).not;
        return known(inner) && typeof inner.value === 'boolean' ? { value: !inner.value } : settled;
      }
      case 'value':
      case 'read':
      case 'call':
      case 'reachable':
      case 'within':
      case 'run':
        return settled;
      default: {
        const unknown: never = kind;
        throw new Error(`No way to settle an expression of kind ${String(unknown)}`);
      }
    }
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
  // Each trigger's expressions settled, and its own steps, by its fields (kinds/triggers.ts); its id kept.
  const when = rule.when.map((trigger): RuleTrigger =>
    triggerFields(trigger).reduce<RuleTrigger>((settled, field) => {
      const value = fieldValue(trigger, field);
      if (value === undefined) return settled;
      if (field.type.type === 'steps') {
        const own = steps(value as readonly Step[]);
        return withField(settled, field, own.length ? own : undefined);
      }
      if (!EXPRESSION_FIELDS.has(field.type.type)) return settled;
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
  return { roles: automationRoles(rule.roles), params: NO_SETTINGS, when, ...keptIf, then: steps(rule.then), ...(otherwise ? { otherwise } : {}) };
}
