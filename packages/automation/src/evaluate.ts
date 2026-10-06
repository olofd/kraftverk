import { checkValue, isScalar, valueTypeOf, type ConfigSchema, type ScalarValue, type Unit, type Value } from '@kraftverk/device-sdk';

import { inWindow, minutesOf } from './clock.ts';
import type { Evaluation } from './functions.ts';
import { BUILTINS } from './kinds/builtins.ts';
import { childrenOf, exprKind, expressionsIn, mapChildren, type ExprOf } from './kinds/exprs.ts';
import { EXPRESSION_FIELDS, fieldValue, withField } from './kinds/spec.ts';
import { stepSpec } from './kinds/steps.ts';
import { triggerFields } from './kinds/triggers.ts';
import { automationRoles, calculate, type CompareOp, type Expr, type RuleTrigger, type Rule, type RunFact, type Step } from './rule.ts';
import { convert, product, quotient, wholeTime } from '@kraftverk/device-sdk';

/*
  Evaluating a rule's expressions where it runs: against what its parts read
  now, its settings and its clock — unknown when anything it needs is, never
  guessed — and its settings put in for what the rule says, step by step.
  Every number is evaluated with its unit (units.ts): a literal's, a
  reading's; two meet in one, converted, and a number with none is in the
  unit of what it is beside.
*/

/** A value as it is evaluated: a number with the unit it is in — none, in the unit of what it is beside. */
export type Measured = { value: Value; unit: Unit | null };

const plain = (value: Value): Measured => ({ value, unit: null });

/**
 * Two numbers in one unit: the first's, or — it has none — the second's.
 * Null when they are of two quantities, which the checker refuses before it runs.
 */
function inOneUnit(left: Measured, right: Measured): { left: Value; right: Value; unit: Unit | null } | null {
  if (typeof left.value !== 'number' || typeof right.value !== 'number' || !left.unit || !right.unit) return { left: left.value, right: right.value, unit: left.unit ?? right.unit };
  const converted = convert(right.value, right.unit, left.unit);
  return converted === null ? null : { left: left.value, right: converted, unit: left.unit };
}

/**
 * A setting as a rule runs with it: the value given — a form's, as it is set
 * — or its own, a number in the setting's unit: `setting.power > 1 kW`
 * compares a setting kept in W as W.
 */
export function settingOf(schema: ConfigSchema, name: string, given?: Value): Measured {
  const field = schema.fields[name];
  const value = (given ?? (field && 'default' in field ? field.default : undefined) ?? null) as Value;
  return { value, unit: field?.type === 'number' && typeof value === 'number' ? (field.unit ?? null) : null };
}

/**
 * What a rule remembers, as a run reads it: the value kept — while it is
 * still one its field takes, the field unchanged in kind and range — or the
 * value it starts from.
 */
export function memoryOf(schema: ConfigSchema, name: string, kept: Value | undefined): Measured {
  const field = schema.fields[name];
  const fits = field !== undefined && kept !== undefined && checkValue(valueTypeOf(field), kept).ok;
  return settingOf(schema, name, fits ? kept : undefined);
}

/**
 * A value to remember, as it is kept: in its field's unit, and one its field
 * takes — or why it cannot be, in words: "Times charged must be at most 10".
 */
export function toRemember(schema: ConfigSchema, name: string, measured: Measured): { value: Value } | { problem: string } {
  const field = schema.fields[name];
  if (!field) return { problem: `it remembers nothing called "${name}"` };
  let value = measured.value;
  if (field.type === 'number' && typeof value === 'number') {
    const inUnit = field.unit ? numberIn(measured, field.unit) : value;
    if (inUnit === null) return { problem: `${field.title} is not in ${measured.unit}` };
    value = tidy(inUnit);
  }
  if (value === null) return { problem: `${field.title} cannot be told now` };
  const checked = checkValue(valueTypeOf(field), value);
  return checked.ok ? { value } : { problem: `${field.title} ${checked.problem}` };
}

/** A number worked out without the float's dust: 0.1 + 0.2 is 0.3. */
const tidy = (value: number): number => Math.round(value * 1e9) / 1e9;

/** A measured number in a unit: one with none is taken as in it already; null when it is not a number, or not of that quantity. */
export function numberIn(measured: Measured, unit: Unit): number | null {
  if (typeof measured.value !== 'number') return null;
  return measured.unit ? convert(measured.value, measured.unit, unit) : measured.value;
}

/** What an expression is evaluated against. */
export type RuleScope = {
  /** One of the rule's settings, as it runs with it: a number in the setting's unit. */
  param(name: string): Measured;
  /** What it remembers, as a run last left it — or as it starts; absent where nothing is kept: its starting value. */
  memory?(name: string): Measured;
  /** What the part filling a role reports now for a meaning — a number in its unit, if it has one — or null when it cannot be known. */
  read(role: string, means: string): { value: ScalarValue; label: string; unit: Unit | null } | null;
  /** A function's answer; not given where calls are not allowed. */
  call?(fn: string, role: string, args: Readonly<Record<string, Value>>): Promise<Evaluation>;
  /** Whether the part filling a role can be reached now — and, when not, why. */
  reachable(role: string): { reachable: boolean | null; detail: string };
  /** How a role's part is named: "Garage station". */
  name(role: string): string;
  /** The time of day on the owner's clock, as "HH:MM"; null where there is none. */
  clock(): string | null;
  /** A fact of the run being evaluated (`run.trigger`); null — or absent — where there is no run, or it is not known. */
  run?(fact: RunFact, field?: string): Measured;
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
  return (await measure(expr, scope, trace)).value;
}

/** The same, with the unit its number is in: what a setting written, or a command's argument, is converted from. */
export async function measure(expr: Expr, scope: RuleScope, trace: string[] = []): Promise<Measured> {
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
  return measureNow(expr, scope, trace, answers);
}

/**
 * The same, now — for what is looked at on every reading, where nothing may
 * wait: a function it asks is unknown here, unless `answers` has already
 * asked it. Every kind of expression, or this does not compile.
 */
export function evaluateNow(expr: Expr, scope: RuleScope, trace: string[] = [], answers?: ReadonlyMap<Expr, Value>): Value {
  return measureNow(expr, scope, trace, answers).value;
}

/** A length of time, now, in seconds — whatever unit it was written in; null when it is not one, or not known. */
export const secondsNow = (expr: Expr, scope: RuleScope): number | null => numberIn(measureNow(expr, scope), 's');

/** An expression's value now, with the unit its number is in. Every kind of expression, or this does not compile. */
export function measureNow(expr: Expr, scope: RuleScope, trace: string[] = [], answers?: ReadonlyMap<Expr, Value>): Measured {
  const now = (inner: Expr) => measureNow(inner, scope, trace, answers);
  const kind = exprKind(expr);
  switch (kind) {
    case 'value': {
      const { value, unit } = expr as ExprOf<'value'>;
      return { value, unit: typeof value === 'number' ? (unit ?? null) : null };
    }
    case 'param':
      return scope.param((expr as ExprOf<'param'>).param);
    case 'memory':
      return scope.memory?.((expr as ExprOf<'memory'>).memory) ?? plain(null);
    case 'read': {
      const { role, means } = (expr as ExprOf<'read'>).read;
      const read = scope.read(role, means);
      trace.push(`${scope.name(role)}: ${read ? `${read.label} ${shown(read.value, read.unit ?? '')}` : `${means} is not known`}`);
      return read ? { value: read.value, unit: typeof read.value === 'number' ? read.unit : null } : plain(null);
    }
    case 'reachable': {
      const role = (expr as ExprOf<'reachable'>).reachable;
      const { reachable, detail } = scope.reachable(role);
      trace.push(`${scope.name(role)}: ${reachable ? 'can be reached' : `cannot be reached (${detail})`}`);
      return plain(reachable);
    }
    case 'run': {
      const { run: fact, field } = expr as ExprOf<'run'>;
      return scope.run?.(fact, field) ?? plain(null);
    }
    case 'within': {
      const { from, to } = (expr as ExprOf<'within'>).within;
      const clock = scope.clock();
      const [start, end] = [minutesOf(now(from).value), minutesOf(now(to).value)];
      if (clock === null || start === null || end === null) return plain(null);
      trace.push(`It is ${clock}`);
      return plain(inWindow(minutesOf(clock)!, start, end));
    }
    case 'call':
      return plain(answers?.get(expr) ?? null);
    case 'compare': {
      const { compare: op, left, right } = expr as ExprOf<'compare'>;
      const both = inOneUnit(now(left), now(right));
      return plain(both ? compare(op, both.left, both.right) : null);
    }
    case 'math': {
      const { math: op, left, right } = expr as ExprOf<'math'>;
      const [a, b] = [now(left), now(right)];
      // A sum is in one unit; a product or a quotient in the unit the two make (units.ts).
      if (op === 'add' || op === 'subtract') {
        const both = inOneUnit(a, b);
        return both ? { value: calculate(op, both.left, both.right), unit: both.unit } : plain(null);
      }
      if (typeof a.value !== 'number' || typeof b.value !== 'number') return plain(null);
      const made = op === 'multiply' ? product(a.unit, b.unit) : quotient(a.unit, b.unit);
      const value = made ? calculate(op, a.value, b.value) : null;
      return made && typeof value === 'number' ? { value: tidy(value * made.factor), unit: made.unit } : plain(null);
    }
    case 'apply': {
      const { apply: name, args } = expr as ExprOf<'apply'>;
      const spec = BUILTINS[name];
      const measured = args.map(now);
      if (measured.length < spec.arity.min || (spec.arity.max !== null && measured.length > spec.arity.max)) return plain(null);
      if (measured.some((each) => typeof each.value !== 'number')) return plain(null);
      // In the first one's unit — or, it having none, the first that has one.
      const unit = spec.units === 'first' ? measured[0]!.unit : (measured.find((each) => each.unit)?.unit ?? null);
      const values = measured.map((each, index) => (spec.units === 'first' && index > 0 ? (each.unit ? null : (each.value as number)) : unit ? numberIn(each, unit) : (each.value as number)));
      if (values.some((value) => value === null)) return plain(null);
      const value = spec.apply(values as number[]);
      return value === null ? plain(null) : { value: tidy(value), unit };
    }
    case 'negate': {
      const inner = now((expr as ExprOf<'negate'>).negate);
      return typeof inner.value === 'number' ? { value: -inner.value, unit: inner.unit } : plain(null);
    }
    case 'if': {
      const { if: condition, then, else: otherwise } = expr as ExprOf<'if'>;
      const holds = now(condition).value;
      return holds === true ? now(then) : holds === false ? now(otherwise) : plain(null);
    }
    case 'either': {
      for (const part of (expr as ExprOf<'either'>).either) {
        const measured = now(part);
        if (measured.value !== null) return measured;
      }
      return plain(null);
    }
    case 'in': {
      const { item, in: options } = expr as ExprOf<'in'>;
      const value = now(item);
      if (value.value === null) return plain(null);
      // One equal is enough; none equal, one unknown leaves it unknown — as "any of" the comparisons.
      return plain(combine('any', options.map((option) => {
        const both = inOneUnit(value, now(option));
        return both ? compare('eq', both.left, both.right) : null;
      })));
    }
    case 'all':
      return plain(combine('all', (expr as ExprOf<'all'>).all.map((inner) => now(inner).value)));
    case 'any':
      return plain(combine('any', (expr as ExprOf<'any'>).any.map((inner) => now(inner).value)));
    case 'not': {
      const value = now((expr as ExprOf<'not'>).not).value;
      return plain(typeof value === 'boolean' ? !value : null);
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
    param: (key) => settingOf(rule.params, key, params[key]),
    // Before any run: what it starts from.
    memory: (key) => settingOf(rule.memory ?? NO_SETTINGS, key),
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

/** A rule with no settings: every value is in its blocks. */
export const NO_SETTINGS: ConfigSchema = { fields: {} };

/**
 * A recipe's rule as an automation keeps it: its settings kept — each at the
 * value given, or the recipe's — read in its blocks as `setting.low`, so a
 * level is set in one place and the rule reads as what it does; its roles
 * without what the recipe said for whoever fills them.
 */
export function withSettings(rule: Rule, values: Readonly<Record<string, Value>>): Rule {
  const fields = Object.fromEntries(
    Object.entries(rule.params.fields).map(([key, field]) => [key, values[key] !== undefined && values[key] !== null ? ({ ...field, default: values[key] } as typeof field) : field])
  );
  return { ...rule, roles: automationRoles(rule.roles), params: { ...rule.params, fields } };
}

/**
 * A recipe's settings written into its blocks — each setting its plain value
 * (or its default), a choice they decide the steps it chose — and no
 * settings left: what an automation copied from a recipe owns, and edits as
 * any other (docs/AUTOMATION-EDITOR.md).
 */
export function inlineParams(rule: Rule, values: Readonly<Record<string, Value>>): Rule {
  const scope = settledScope(rule, values);
  /** A setting's value as a rule writes it: a number in the setting's unit — a length of time in the largest that says it whole. */
  const written = (name: string): Expr => {
    const { value } = scope.param(name);
    const field = rule.params.fields[name];
    const unit = field?.type === 'number' ? field.unit : undefined;
    if (typeof value !== 'number' || !unit) return { value };
    return unit === 's' ? wholeTime(value) : { value, unit };
  };
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
        return written((settled as ExprOf<'param'>).param);
      // Settings alone: the number, or the answer, they make — written in, in their unit.
      case 'math':
      case 'apply':
      case 'negate':
      case 'in': {
        if (!childrenOf(settled).every(known)) return settled;
        const { value, unit } = measureNow(settled, scope);
        return unit && typeof value === 'number' ? { value, unit } : { value };
      }
      // A choice the settings make is the value it chose.
      case 'if': {
        const { if: condition, then, else: otherwise } = settled as ExprOf<'if'>;
        return known(condition) && typeof condition.value === 'boolean' ? (condition.value ? then : otherwise) : settled;
      }
      // A known value first is the value; the rest are never reached.
      case 'either': {
        const parts = (settled as ExprOf<'either'>).either;
        const first = parts.findIndex((part) => !known(part) || part.value !== null);
        const rest = parts.slice(Math.max(first, 0));
        return rest.length === 1 || (rest[0] && known(rest[0])) ? rest[0]! : { either: rest };
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
      case 'memory':
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
  return { roles: automationRoles(rule.roles), params: NO_SETTINGS, ...(rule.memory ? { memory: rule.memory } : {}), when, ...keptIf, then: steps(rule.then), ...(otherwise ? { otherwise } : {}) };
}
