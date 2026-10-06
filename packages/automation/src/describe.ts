import { capabilitySpec, enumLabel, isCapability, standardMeaning, type ConfigSchema, type Value } from '@kraftverk/device-sdk';

import type { RuleVocabulary } from './check.ts';
import { WEEKDAYS, type Weekday } from './clock.ts';
import { evaluateNow, settledChoice, settledScope, shown } from './evaluate.ts';
import { exprKind, type ExprOf } from './kinds/exprs.ts';
import type { Say } from './kinds/spec.ts';
import { branchesOf, stepSpec, type StepKind, type StepSay } from './kinds/steps.ts';
import { TRIGGER_KINDS, triggerKind } from './kinds/triggers.ts';
import { isAutomationRole, type Command, type CompareOp, type Expr, type Rule, type RunFact, type Step, type Trigger, type Write } from './rule.ts';

/*
  A rule in words (docs/AUTOMATIONS-UX.md): its triggers, conditions and
  steps as a person reads them, with its parts called what their owner calls
  them — what every screen, the assistant and a run's log say.
*/

/** A number of seconds as a person says it: "20 s", "2 min", "1 min 30 s", "1 h". */
export function secondsText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3_600) return whole % 60 ? `${Math.floor(whole / 60)} min ${whole % 60} s` : `${whole / 60} min`;
  const minutes = Math.round(whole / 60);
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

/** How long a condition must hold, as a person says it: "2 min", "3 s" — or, a setting or a reading, in its words. */
const holdText = (held: Expr, text: (expr: Expr) => string): string => ('value' in held && typeof held.value === 'number' ? secondsText(held.value) : text(held));

/** A setting as it reads in a sentence: an option's label, a number with its unit, seconds as a duration. */
export function paramText(schema: ConfigSchema, name: string, value: Value): string {
  const field = schema.fields[name];
  if (value === null || value === undefined) return '…';
  if (field?.type === 'enum' && typeof value === 'string') {
    const label = enumLabel(field, value);
    // Mid-sentence: "tomorrow", not "Tomorrow" — unless it is a name or a time.
    return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
  }
  if (field?.type === 'number' && typeof value === 'number') return field.unit === 's' ? secondsText(value) : shown(value, field.unit ?? '');
  return shown(value);
}

/** A fact of the run, as a sentence names it. */
const RUN_FACT_WORDS: Record<RunFact, string> = { trigger: 'what started it' };

const OP_WORDS: Record<CompareOp, string> ={ lt: 'is below', le: 'is at most', gt: 'is above', ge: 'is at least', eq: 'is', ne: 'is not' };

/**
 * Something of a part, as English says it: "Garage station’s charge",
 * "Garage station — AC outlets’ power" — or, when the name is a clause or
 * already whose, "the power of what powers the charger", "the power of the
 * charger’s plug", never "the charger’s plug’s power".
 */
export const whose = (name: string, thing: string): string => {
  if (/^(what|which|whatever|whichever)\b/i.test(name) || /[’']s\b/.test(name)) return `the ${thing} of ${name}`;
  return /s$/i.test(name) ? `${name}’ ${thing}` : `${name}’s ${thing}`;
};

/** One expression of a rule, in words, with its settings filled in: "Garage station's charge is below 15 %". */
export function describeExpr(rule: Rule, expr: Expr, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string {
  const param = (key: string) => paramText(rule.params, key, params[key] ?? null);
  /**
   * Which trigger started the run, compared with one's id: said as that
   * trigger — "it started because the station’s charge is below 40 % for 2 min".
   */
  const started = (expr: Extract<Expr, { compare: CompareOp }>): string | null => {
    if (expr.compare !== 'eq' && expr.compare !== 'ne') return null;
    const id = 'run' in expr.left && 'value' in expr.right ? expr.right.value : 'run' in expr.right && 'value' in expr.left ? expr.left.value : null;
    if (typeof id !== 'string') return null;
    const index = rule.when.findIndex((trigger) => trigger.id === id);
    const trigger = index >= 0 ? describeTriggers(rule, params, name, vocabulary)[index]! : null;
    const so = expr.compare === 'eq';
    if (id === '') return so ? 'none of its triggers started it' : 'one of its triggers started it';
    if (!trigger) return `it ${so ? 'was' : 'was not'} started by “${id}”`;
    // "When …" is why it started; "Every day at 07:00" is when.
    const because = /^When /.test(trigger) ? `because ${trigger.slice(5)}` : trigger.charAt(0).toLowerCase() + trigger.slice(1);
    return `it ${so ? 'started' : 'did not start'} ${because}`;
  };
  /** A setting compared with one of its own options: what its owner chose, in the option's own words. */
  const chosen = (expr: Extract<Expr, { compare: CompareOp }>): string | null => {
    if (expr.compare !== 'eq' && expr.compare !== 'ne') return null;
    const [setting, option] = 'param' in expr.left && 'value' in expr.right ? [expr.left.param, expr.right.value] : 'param' in expr.right && 'value' in expr.left ? [expr.right.param, expr.left.value] : [null, null];
    const field = setting ? rule.params.fields[setting] : undefined;
    if (field?.type !== 'enum' || typeof option !== 'string') return null;
    return `${expr.compare === 'eq' ? 'you chose' : 'you did not choose'} “${enumLabel(field, option)}”`;
  };
  /** The unit a reading is in, when it is one: a plain number beside it is in it too — "above 50 W", not "above 50". */
  const unitOf = (expr: Expr): string => {
    if ('math' in expr) return unitOf(expr.left) || unitOf(expr.right);
    const standard = 'read' in expr ? standardMeaning(expr.read.means) : null;
    return standard?.type === 'number' && !standard.units ? standard.unit : '';
  };
  /** Every kind of expression in words — or this does not compile (kinds/exprs.ts). */
  const text = (expr: Expr, unit = ''): string => {
    const kind = exprKind(expr);
    switch (kind) {
      case 'value': {
        const { value } = expr as ExprOf<'value'>;
        return typeof value === 'number' ? shown(value, unit) : shown(value);
      }
      case 'param':
        return param((expr as ExprOf<'param'>).param);
      case 'read': {
        // What it reports, not chosen yet: "a reading" rather than an empty name.
        const { role, means } = (expr as ExprOf<'read'>).read;
        return whose(name(role), standardMeaning(means)?.label.toLowerCase() || means || 'reading');
      }
      case 'reachable':
        return `${name((expr as ExprOf<'reachable'>).reachable)} can be reached`;
      case 'run': {
        const fact = (expr as ExprOf<'run'>).run;
        return RUN_FACT_WORDS[fact] ?? `the run’s ${fact}`;
      }
      case 'within': {
        const { from, to } = (expr as ExprOf<'within'>).within;
        return `it is between ${text(from)} and ${text(to)}`;
      }
      case 'math': {
        const math = expr as ExprOf<'math'>;
        // A plain number beside a reading is in its unit: "Garage station’s charge plus 10 %".
        const in_ = unit || unitOf(math);
        const [left, right] = [text(math.left, in_), text(math.right, in_)];
        return math.math === 'add' ? `${left} plus ${right}` : math.math === 'subtract' ? `${left} minus ${right}` : `the ${math.math === 'min' ? 'lower' : 'higher'} of ${left} and ${right}`;
      }
      case 'call': {
        const call = expr as ExprOf<'call'>;
        return `${vocabulary?.fn(call.call)?.label.toLowerCase() ?? call.call} by ${name(call.role)}`;
      }
      case 'compare': {
        const comparison = expr as ExprOf<'compare'>;
        return started(comparison) ?? chosen(comparison) ?? `${text(comparison.left, unitOf(comparison.right))} ${OP_WORDS[comparison.compare]} ${text(comparison.right, unitOf(comparison.left))}`;
      }
      case 'all':
        return (expr as ExprOf<'all'>).all.map((part) => text(part)).join(' and ');
      case 'any':
        return (expr as ExprOf<'any'>).any.map((part) => text(part)).join(' or ');
      case 'not':
        return `it is not so that ${text((expr as ExprOf<'not'>).not)}`;
      default: {
        const unknown: never = kind;
        throw new Error(`No words for an expression of kind ${String(unknown)}`);
      }
    }
  };
  return text(expr);
}

/** An event as its capability names it — "mains lost" — or, a type's own, its id in words. */
const eventWords = (rule: Rule, role: string, event: string): string => {
  const spec = rule.roles[role];
  const named = spec && !isAutomationRole(spec) ? [...spec.capabilities, ...(spec.oneOf ?? [])] : [];
  const label = named.flatMap((capability) => (isCapability(capability) ? [capabilitySpec(capability).events?.[event]?.label] : [])).find(Boolean);
  return (label ?? event.replace(/[._-]+/g, ' ')).toLowerCase();
};

const DAY_WORDS: Readonly<Record<Weekday, string>> ={ mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** Which days, as a person says it: "every day", "on weekdays", "at weekends", "on Mon, Wed and Fri". */
export function daysText(days: readonly Weekday[] | undefined): string {
  const chosen = WEEKDAYS.filter((day) => !days || days.includes(day));
  if (chosen.length === 7) return 'every day';
  if (chosen.join() === 'mon,tue,wed,thu,fri') return 'on weekdays';
  if (chosen.join() === 'sat,sun') return 'at weekends';
  const words = chosen.map((day) => DAY_WORDS[day]);
  return `on ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}`;
}

/**
 * When a rule runs, one sentence a trigger: "When Station's charge is below
 * 15 % for 2 min", "Every day at 07:00", "At 07:00 on weekdays". What a
 * person reads to know how often it looks, and at what. None: it runs when
 * played, or started by another automation.
 */
export function describeTriggers(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string[] {
  const text = (expr: Expr): string => describeExpr(rule, expr, params, name, vocabulary);
  // Each kind says itself (kinds/triggers.ts); this hands it the words for what it holds.
  const say: Say = {
    expr: text,
    duration: (expr) => holdText(expr, text),
    days: daysText,
    name,
    event: (role, event) => eventWords(rule, role, event),
  };
  return rule.when.map((trigger) => {
    const kind = triggerKind(trigger);
    return (TRIGGER_KINDS[kind].words as (trigger: Trigger, say: Say) => string)(trigger, say);
  });
}

/**
 * A trigger's sentence said as what comes next — not as if it had happened:
 * "At 07:00 on weekdays" is "Next at 07:00 on weekdays", "Every 15 min"
 * "Runs every 15 min", "When the charge is below 15 %" "Waiting: the charge
 * is below 15 %".
 */
export function triggerAsNext(trigger: string): string {
  if (/^At /.test(trigger)) return `Next at ${trigger.slice(3)}`;
  if (/^Every day at /.test(trigger)) return `Next at ${trigger.slice(13)}, every day`;
  if (/^Every /.test(trigger)) return `Runs every ${trigger.slice(6)}`;
  if (/^When /.test(trigger)) return `Waiting: ${trigger.slice(5)}`;
  return trigger;
}

/** One step, in words, and the steps within it — what a sequence is shown as, numbered and nested. */
export type StepLine = {
  kind: StepKind;
  /** "Turn Station's AC outlets on", "Wait until Charger plug can be reached — at most 2 min". */
  text: string;
  /** Steps within it, each group with what it is for: "If it stays so", "Each time". */
  branches: { label: string; steps: StepLine[] }[];
};

/** How a rule's words are put together: its settings as they stand, and its parts by name. */
function wording(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary) {
  const text = (expr: Expr): string => describeExpr(rule, expr, params, name, vocabulary);
  const settled = settledScope(rule, params, name);
  const seconds = (expr: Expr): string => {
    const known = evaluateNow(expr, settled);
    return typeof known === 'number' ? secondsText(known) : text(expr);
  };
  const count = (expr: Expr): string => {
    const known = evaluateNow(expr, settled);
    return typeof known === 'number' ? (known === 1 ? 'once' : known === 2 ? 'twice' : `${known} times`) : text(expr);
  };
  const command = ({ role, capability, command, args }: Command): string => {
    // On or off by a condition: "turn Charger plug on if Garage station’s charge is below 50 %, off if not".
    const on = capability === 'switch' && command === 'set' && args.on ? args.on : null;
    if (on && typeof evaluateNow(on, settled) !== 'boolean' && !('param' in on) && !('value' in on)) return `turn ${name(role)} on if ${text(on)}, off if not`;
    const values = Object.values(args).map((arg) => {
      const known = evaluateNow(arg, settled);
      return typeof known === 'boolean' ? (known ? 'on' : 'off') : known !== null ? shown(known) : text(arg);
    });
    return capability === 'switch' && command === 'set' ? `turn ${name(role)} ${values.join(' ')}` : `${capability}.${command} ${name(role)} (${values.join(', ')})`;
  };
  /** "set Scooter plug’s Live readings to on": the setting as its device names it, the value as it reads. */
  const write = (step: Write): string => {
    const { role, value } = step;
    const attribute = vocabulary?.attribute?.(role, step) ?? null;
    const known = evaluateNow(value, settled);
    const said =
      known === null
        ? text(value)
        : attribute?.value.type === 'boolean' && typeof known === 'boolean'
          ? (attribute.value.words?.[known ? 'true' : 'false'] ?? (known ? 'on' : 'off')).toLowerCase()
          : attribute?.value.type === 'enum' && typeof known === 'string'
            ? enumLabel(attribute.value, known)
            : typeof known === 'boolean'
              ? (known ? 'on' : 'off')
              : shown(known, attribute?.value.type === 'number' ? (attribute.value.unit ?? '') : '');
    // No setting chosen yet: said as what it is about, not as an empty name.
    // By meaning, before a part fills it: as the meaning is called.
    const label = attribute?.label ?? (step.means !== undefined ? (standardMeaning(step.means)?.label ?? step.means) : step.key);
    if (!label.trim()) return `set a setting of ${name(role)}`;
    return `set ${whose(name(role), label)} to ${said}`;
  };
  /** Steps as they read: a choice its settings decide is the steps it chose, in its place. */
  const steps = <T>(list: readonly Step[] | undefined, each: (step: Step) => T): T[] =>
    (list ?? []).flatMap((step) => {
      const chosen = 'choose' in step ? settledChoice(rule, step, params) : null;
      return chosen ? steps(chosen, each) : [each(step)];
    });
  // What each kind's words are handed (kinds/steps.ts): how the parts of a step read.
  const say: StepSay = { expr: text, seconds, count, name, command, write, briefs: (list) => briefs(list) };
  const lines = (list: readonly Step[] | undefined): StepLine[] => steps(list, line);
  /** A step as its kind says it, and its branches — its lists of steps — each under its field's label. */
  const line = (step: Step): StepLine => {
    const spec = stepSpec(step);
    const branches = branchesOf(step).flatMap(({ field, steps: inner }) => {
      const said = lines(inner);
      return said.length ? [{ label: field.label, steps: said }] : [];
    });
    return { kind: spec.kind, text: capitalise(spec.line(step, say)), branches };
  };
  /** A step in a sentence, briefly: what it does, not its branches. */
  const brief = (step: Step): string => stepSpec(step).brief(step, say);
  const briefs = (list: readonly Step[] | undefined): string[] => steps(list, brief);
  return { text, lines, briefs };
}

/** A rule's steps in words: its own, each trigger's, and what it does if a step does not succeed. */
export type RuleSteps = {
  steps: StepLine[];
  /** Each trigger's own steps, by its place under `when`: empty, it takes the rule's. */
  whenSteps: StepLine[][];
  otherwise: StepLine[];
};

/**
 * A rule's steps in words, numbered and nested — what the app shows a
 * sequence as — each trigger's own, and what it does if a step does not succeed.
 */
export function describeSteps(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): RuleSteps {
  const { lines } = wording(rule, params, name, vocabulary);
  return { steps: lines(rule.then), whenSteps: rule.when.map((trigger) => lines(trigger.then)), otherwise: lines(rule.otherwise) };
}

/**
 * How an automation reads, in one sentence: its recipe's wording with roles
 * and settings filled in, or one made from the rule itself — its steps said
 * briefly, in order.
 */
export function describeRule(rule: Rule & { sentence?: string }, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string {
  const param = (key: string) => paramText(rule.params, key, params[key] ?? null);
  if (rule.sentence) return rule.sentence.replace(/\{(\w+)\}/g, (_, key: string) => (key in rule.roles ? name(key) : param(key)));

  const { text, briefs } = wording(rule, params, name, vocabulary);
  // Its triggers as their own lines say them, mid-sentence.
  const triggers = describeTriggers(rule, params, name, vocabulary).map((line) => line.charAt(0).toLowerCase() + line.slice(1));
  const only = rule.if ? `if ${text(rule.if)}` : '';
  // A rule still being built may have no step yet: said so, not as an empty clause.
  const clause = (when: string[], steps: readonly Step[] | undefined): string => {
    const does = briefs(steps);
    const opening = [when.join(', or '), only].filter(Boolean).join(', ');
    return `${opening ? `${opening}, ` : ''}${does.length ? does.join(', then ') : 'nothing yet'}`;
  };
  // Each trigger with steps of its own says them beside it; the rest — or none, played or started — the rule's.
  const own = rule.when.flatMap((trigger, index) => (trigger.then?.length ? [clause([triggers[index]!], trigger.then)] : []));
  const rest = triggers.filter((_, index) => !rule.when[index]!.then?.length);
  const shared = rest.length || !own.length ? [clause(rest, rule.then)] : rule.then.length ? [clause(['started by hand or by another automation'], rule.then)] : [];
  return capitalise(`${[...own, ...shared].join('; ')}.`);
}

/** A sentence begun as one: "turn the heater on" is "Turn the heater on". */
export const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
