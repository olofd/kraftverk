import { BUILT_IN_MODES, capabilitySpec, enumLabel, isCapability, standardMeaning, type ConfigSchema, type Value } from '@kraftverk/device-sdk';

import type { RuleVocabulary } from './check.ts';
import { WEEKDAYS, type Weekday } from './clock.ts';
import { evaluateNow, measureNow, secondsNow, settledChoice, settledScope, shown } from './evaluate.ts';
import { ACROSS_FNS } from './kinds/across.ts';
import { BUILTINS } from './kinds/builtins.ts';
import { HISTORY_FNS } from './kinds/history.ts';
import { SUN_EVENTS } from './sun.ts';
import { exprKind, type ExprOf } from './kinds/exprs.ts';
import type { Say } from './kinds/spec.ts';
import { branchesOf, stepSpec, type StepKind, type StepSay } from './kinds/steps.ts';
import { TRIGGER_KINDS, triggerKind } from './kinds/triggers.ts';
import { convert, UNITS } from '@kraftverk/device-sdk';
import { isGroupRole, isPartRole, isPeopleRole, isPlaceRole, memberRole, OWN_HOME, type Command, type CompareOp, type Expr, type Rule, type RunFact, type Step, type Trigger, type Write } from './rule.ts';
import { sayMessage } from './message.ts';

/*
  A rule in words (docs/AUTOMATIONS-UX.md): its triggers, conditions and
  steps as a person reads them, with its parts called what their owner calls
  them — what every screen, the assistant and a run's log say.
*/

/** A number of seconds as a person says it: "20 s", "2 min", "1 min 30 s", "1 h", "2 d". */
export function secondsText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3_600) return whole % 60 ? `${Math.floor(whole / 60)} min ${whole % 60} s` : `${whole / 60} min`;
  const minutes = Math.round(whole / 60);
  // Whole days, as days: two weeks is "14 d", not "336 h".
  if (minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440} d`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

/** How long a condition must hold, as a person says it: "2 min", "3 s" — or, a setting or a reading, in its words. */
const holdText = (held: Expr, text: (expr: Expr) => string): string => {
  const seconds = 'value' in held && typeof held.value === 'number' ? (held.unit ? convert(held.value, held.unit, 's') : held.value) : null;
  return seconds === null ? text(held) : secondsText(seconds);
};

/** One of what a rule remembers, as a sentence calls it: its title, mid-sentence — "times charged". */
const memoryWords = (rule: Pick<Rule, 'memory'>, key: string): string => {
  const title = rule.memory?.fields[key]?.title ?? key;
  return /^[A-Z][a-z]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title;
};

/** A setting's value as the rule runs with it: the one given — a form's, as it is set — or the rule's own. */
const settingValue = (rule: Pick<Rule, 'params'>, params: Readonly<Record<string, Value>>, key: string): Value => {
  const field = rule.params.fields[key];
  return (params[key] ?? (field && 'default' in field ? field.default : undefined) ?? null) as Value;
};

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
const RUN_FACT_WORDS: Record<RunFact, string> = { trigger: 'what started it', event: 'what the device reported', who: 'who came or went' };

/** A mode by its key, mid-sentence: "away", "vacation" — a family's own by its name, "guests over". */
export const modeWords = (key: string, vocabulary?: RuleVocabulary): string => {
  const built = BUILT_IN_MODES.find((mode) => mode.key === key);
  if (built) return built.name.toLowerCase();
  const own = vocabulary?.modes?.().find((mode) => mode.key === key);
  return own ? own.name.charAt(0).toLowerCase() + own.name.slice(1) : key.replace(/-/g, ' ');
};

/** A place's name, the automation's own home being "home". */
const withHome = (name: (role: string) => string) => (role: string) => (role === OWN_HOME ? 'home' : name(role));

/** Where a place is, after "at": "at home", "at Work". */
const atPlace = (place: string, name: (role: string) => string) => (place === OWN_HOME ? 'at home' : `at ${name(place)}`);

/** One of a home's variables as its home has it; null when it is not known here. */
const variableSpec = (key: string, at: string, vocabulary?: RuleVocabulary) => vocabulary?.variables?.(at)?.find((each) => each.key === key) ?? null;

/**
 * One of a home's variables, by its title as written — “Guests staying”,
 * another home's as “Cabin’s Wake at” — and one not chosen yet, as that.
 * Its title kept whole: a phrase lowercased mid-sentence reads as words.
 */
export const variableName = (key: string, at: string, name: (role: string) => string, vocabulary?: RuleVocabulary): string => {
  if (!key) return 'a variable not chosen yet';
  const title = variableSpec(key, at, vocabulary)?.field.title ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase());
  return at === OWN_HOME ? `“${title}”` : `${whose(name(at), `“${title}”`)}`;
};

/** A value one of a home's variables is given or compared with, in its words: its option's label, in its unit — a time not chosen, as that. */
const variableValueWords = (key: string, at: string, expr: Expr, text: (expr: Expr) => string, vocabulary?: RuleVocabulary): string => {
  const field = variableSpec(key, at, vocabulary)?.field;
  if (!('value' in expr) || !field) return text(expr);
  if (expr.value === null) return 'nothing';
  if (field.type === 'enum' && typeof expr.value === 'string') return `“${enumLabel(field, expr.value)}”`;
  if (field.type === 'number' && field.unit && typeof expr.value === 'number' && !expr.unit) return text({ ...expr, unit: field.unit });
  return text(expr);
};

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
export function describeExpr(rule: Rule, expr: Expr, params: Readonly<Record<string, Value>>, named: (role: string) => string, vocabulary?: RuleVocabulary): string {
  const name = withHome(named);
  const param = (key: string) => paramText(rule.params, key, settingValue(rule, params, key));
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
    if ('math' in expr) return expr.math === 'add' || expr.math === 'subtract' ? unitOf(expr.left) || unitOf(expr.right) : '';
    if ('apply' in expr) return expr.args.map(unitOf).find(Boolean) ?? '';
    if ('negate' in expr) return unitOf(expr.negate);
    if ('if' in expr) return unitOf(expr.then) || unitOf(expr.else);
    if ('either' in expr) return expr.either.map(unitOf).find(Boolean) ?? '';
    // Over time, a reading is in its own unit still.
    const standard = 'read' in expr ? standardMeaning(expr.read.means) : 'history' in expr ? standardMeaning(expr.of.means) : null;
    return standard?.type === 'number' && !standard.units ? (standard.unit ?? '') : '';
  };
  /** Every kind of expression in words — or this does not compile (kinds/exprs.ts). */
  const text = (expr: Expr, unit = ''): string => {
    const kind = exprKind(expr);
    switch (kind) {
      case 'value': {
        // As it was written — "2 kW" — or, with no unit, in the unit of what it is beside.
        const { value, unit: own } = expr as ExprOf<'value'>;
        if (typeof value !== 'number') return shown(value);
        return own && UNITS[own].dimension === 'time' ? secondsText(convert(value, own, 's') ?? value) : shown(value, own ?? unit);
      }
      case 'param':
        return param((expr as ExprOf<'param'>).param);
      case 'read': {
        // What it reports, not chosen yet: "a reading" rather than an empty name.
        const { role, means } = (expr as ExprOf<'read'>).read;
        // Of a place: how many are there, whether anyone is, its mode.
        const spec = rule.roles[role];
        if (role === OWN_HOME || (spec && isPlaceRole(spec))) {
          if (means === 'people') return `how many of the family are ${atPlace(role, name)}`;
          if (means === 'occupied') return role === OWN_HOME ? 'someone is in the home' : `someone is in ${name(role)}`;
          return whose(role === OWN_HOME ? 'the home' : name(role), means === 'day' ? 'time of day' : 'mode');
        }
        return whose(name(role), standardMeaning(means)?.label.toLowerCase() || means || 'reading');
      }
      case 'presentAt': {
        const { who, place } = (expr as ExprOf<'presentAt'>).presentAt;
        return `${name(who)} is ${atPlace(place, name)}`;
      }
      case 'history': {
        // "the average of Garage station’s charge over the last 1 h".
        const { history: fn, of, over } = expr as ExprOf<'history'>;
        return HISTORY_FNS[fn].words(whose(name(of.role), standardMeaning(of.means)?.label.toLowerCase() || of.means || 'reading'), text(over));
      }
      case 'distance': {
        // "how far Olof’s phone is from home", "how far Olof’s phone is from the car".
        const { distance: of, to } = expr as ExprOf<'distance'>;
        return `how far ${name(of.role)} is from ${to ? name(to.role) : 'home'}`;
      }
      case 'reachable':
        return `${name((expr as ExprOf<'reachable'>).reachable)} can be reached`;
      case 'run': {
        const { run: fact, field } = expr as ExprOf<'run'>;
        // What an event carried, in words: "the voltage it reported".
        if (fact === 'event' && field) return `the ${field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} it reported`;
        return RUN_FACT_WORDS[fact] ?? `the run’s ${fact}`;
      }
      case 'within': {
        const { from, to } = (expr as ExprOf<'within'>).within;
        return `it is between ${text(from)} and ${text(to)}`;
      }
      case 'across': {
        // What is said of each part, each called as its name says — "each charger’s power is above 10 W" — then of the group.
        const { across: fn, as, group, of } = expr as ExprOf<'across'>;
        const spec = rule.roles[group];
        const roles = spec && isGroupRole(spec) ? { ...rule.roles, [as]: memberRole(spec) } : spec && isPeopleRole(spec) ? { ...rule.roles, [as]: { person: true as const, label: as } } : rule.roles;
        const each = describeExpr({ ...rule, roles }, of, params, (role) => (role === as ? eachSaid(as) : name(role)), vocabulary);
        return ACROSS_FNS[fn].words(name(group), each);
      }
      case 'sun': {
        // "sunset", "30 min before sunset".
        const { sun: event, offset } = expr as ExprOf<'sun'>;
        return offset ? `${text(offset.by)} ${offset.before ? 'before' : 'after'} ${SUN_EVENTS[event]}` : SUN_EVENTS[event];
      }
      case 'math': {
        const math = expr as ExprOf<'math'>;
        // A plain number beside a reading is in its unit: "Garage station’s charge plus 10 %".
        const in_ = unit || unitOf(math);
        const [left, right] = math.math === 'add' || math.math === 'subtract' ? [text(math.left, in_), text(math.right, in_)] : [text(math.left), text(math.right)];
        switch (math.math) {
          case 'add':
            return `${left} plus ${right}`;
          case 'subtract':
            return `${left} minus ${right}`;
          case 'multiply': {
            // A percentage of something is a share of it: "50 % of Garage station’s capacity".
            const share = (side: Expr) => 'value' in side && side.unit === '%';
            if (share(math.right)) return `${right} of ${left}`;
            if (share(math.left)) return `${left} of ${right}`;
            return `${left} times ${right}`;
          }
          case 'divide':
            return `${left} divided by ${right}`;
        }
      }
      case 'apply': {
        const { apply: fn, args } = expr as ExprOf<'apply'>;
        // A plain number beside the first is in its unit: "the lowest of Garage station’s charge and 80 %".
        const in_ = unit || (args.map(unitOf).find(Boolean) ?? '');
        return BUILTINS[fn].words(args.map((arg, index) => text(arg, index === 0 || BUILTINS[fn].units === 'one' ? in_ : '')));
      }
      case 'script': {
        const { script: role, fn, args } = expr as ExprOf<'script'>;
        const words = fn.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
        return `${words} by ${name(role)}${args.length ? ` (${args.map((arg) => text(arg)).join(', ')})` : ''}`;
      }
      case 'negate':
        return `minus ${text((expr as ExprOf<'negate'>).negate, unit)}`;
      case 'if': {
        const { if: condition, then, else: otherwise } = expr as ExprOf<'if'>;
        const in_ = unit || unitOf(expr);
        return `${text(then, in_)} if ${text(condition)}, otherwise ${text(otherwise, in_)}`;
      }
      case 'either': {
        const parts = (expr as ExprOf<'either'>).either;
        const in_ = unit || unitOf(expr);
        const said = parts.map((part) => text(part, in_));
        return said.length === 2 ? `${said[0]} — or, when that is not known, ${said[1]}` : `the first known of ${said.slice(0, -1).join(', ')} and ${said.at(-1)}`;
      }
      case 'in': {
        const { item, in: options } = expr as ExprOf<'in'>;
        const in_ = unitOf(item);
        const said = options.map((option) => text(option, in_));
        const alternatives = said.length > 1 ? `${said.slice(0, -1).join(', ')} or ${said.at(-1)}` : (said[0] ?? 'nothing');
        return `${text(item)} is ${alternatives}`;
      }
      case 'call': {
        const call = expr as ExprOf<'call'>;
        return `${vocabulary?.fn(call.call)?.label.toLowerCase() ?? call.call} by ${name(call.role)}`;
      }
      case 'compare': {
        const comparison = expr as ExprOf<'compare'>;
        // One of the home's variables compared with a value: the value in its words — its option's, its unit.
        if ('variable' in comparison.left && !comparison.left.variable.key) return text(comparison.left);
        if ('variable' in comparison.left && 'value' in comparison.right)
          return `${text(comparison.left)} ${OP_WORDS[comparison.compare]} ${variableValueWords(comparison.left.variable.key, comparison.left.variable.at, comparison.right, (each) => text(each), vocabulary)}`;
        return started(comparison) ?? chosen(comparison) ?? `${text(comparison.left, unitOf(comparison.right))} ${OP_WORDS[comparison.compare]} ${text(comparison.right, unitOf(comparison.left))}`;
      }
      case 'all':
        return (expr as ExprOf<'all'>).all.map((part) => text(part)).join(' and ');
      case 'any':
        return (expr as ExprOf<'any'>).any.map((part) => text(part)).join(' or ');
      case 'not':
        return `it is not so that ${text((expr as ExprOf<'not'>).not)}`;
      case 'memory':
        return memoryWords(rule, (expr as ExprOf<'memory'>).memory);
      case 'variable': {
        const { key, at } = (expr as ExprOf<'variable'>).variable;
        return variableName(key, at, name, vocabulary);
      }
      case 'input':
        // By its name, a noun — "the level it was given" — not its title, which may be a phrase ("Charge to").
        return `the ${(expr as ExprOf<'input'>).input.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase()} it was given`;
      default: {
        const unknown: never = kind;
        throw new Error(`No words for an expression of kind ${String(unknown)}`);
      }
    }
  };
  return text(expr);
}

/** What a "for each" calls each part, within a sentence: `charger` is "each charger", `smallPlug` "each small plug". */
export const eachSaid = (name: string): string => `each ${name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()}`;

/** An event as its capability names it — "mains lost" — or, a type's own, its id in words. */
const eventWords = (rule: Rule, role: string, event: string): string => {
  const spec = rule.roles[role];
  const named = spec && (isPartRole(spec) || isGroupRole(spec)) ? [...spec.capabilities, ...(spec.oneOf ?? [])] : [];
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
export function describeTriggers(rule: Rule, params: Readonly<Record<string, Value>>, named: (role: string) => string, vocabulary?: RuleVocabulary): string[] {
  const name = withHome(named);
  const text = (expr: Expr): string => describeExpr(rule, expr, params, name, vocabulary);
  // Each kind says itself (kinds/triggers.ts); this hands it the words for what it holds.
  const say: Say = {
    expr: text,
    duration: (expr) => holdText(expr, text),
    seconds: (expr) => secondsNow(expr, settledScope(rule, params)),
    days: daysText,
    name,
    many: (role) => {
      const spec = rule.roles[role];
      return Boolean(spec && (isPeopleRole(spec) || isGroupRole(spec)));
    },
    mode: (key) => modeWords(key, vocabulary),
    variable: (key, at) => text({ variable: { key, at: at ?? OWN_HOME } }),
    event: (role, event) => eventWords(rule, role, event),
  };
  return rule.when.map((trigger) => {
    const kind = triggerKind(trigger);
    const said = (TRIGGER_KINDS[kind].words as (trigger: Trigger, say: Say) => string)(trigger, say);
    // How often it may start one, at most: "…, at most every 10 min".
    return trigger.atMostEvery ? `${said}, at most every ${holdText(trigger.atMostEvery, text)}` : said;
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
    const known = secondsNow(expr, settled);
    return known !== null ? secondsText(known) : text(expr);
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
      const { value: known, unit } = measureNow(arg, settled);
      return typeof known === 'boolean' ? (known ? 'on' : 'off') : known !== null ? shown(known, unit ?? '') : text(arg);
    });
    return capability === 'switch' && command === 'set' ? `turn ${name(role)} ${values.join(' ')}` : `${capability}.${command} ${name(role)} (${values.join(', ')})`;
  };
  /** "set Scooter plug’s Live readings to on": the setting as its device names it, the value as it reads. */
  const write = (step: Write): string => {
    const { role, value } = step;
    const attribute = vocabulary?.attribute?.(role, step) ?? null;
    const measured = measureNow(value, settled);
    const known = measured.value;
    // A number in the unit it was written in — or, with none, the setting's own.
    const unit = measured.unit ?? (attribute?.value.type === 'number' ? (attribute.value.unit ?? '') : '');
    const said =
      known === null
        ? text(value)
        : attribute?.value.type === 'boolean' && typeof known === 'boolean'
          ? (attribute.value.words?.[known ? 'true' : 'false'] ?? (known ? 'on' : 'off')).toLowerCase()
          : attribute?.value.type === 'enum' && typeof known === 'string'
            ? enumLabel(attribute.value, known)
            : typeof known === 'boolean'
              ? (known ? 'on' : 'off')
              : shown(known, unit);
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
  const say: StepSay = {
    expr: text,
    seconds,
    count,
    name: withHome(name),
    command,
    write,
    briefs: (list) => briefs(list),
    memory: (key) => memoryWords(rule, key),
    event: (role, event) => eventWords(rule, role, event),
    mode: (key) => modeWords(key, vocabulary),
    variable: (key, at) => text({ variable: { key, at: at ?? OWN_HOME } }),
    variableValue: (key, at, expr) => variableValueWords(key, at ?? OWN_HOME, expr, text, vocabulary),
    // Each value in braces said in words: "{Garage station’s charge}".
    message: (words) => sayMessage(words, (expr) => `{${text(expr)}}`),
  };
  const lines = (list: readonly Step[] | undefined): StepLine[] => steps(list, line);
  /** The words within a "for each": each part of its group said as what its steps call it — "each charger". */
  const within = (each: Extract<Step, { forEach: unknown }>['forEach']) => {
    const group = rule.roles[each.in];
    const roles = group && isGroupRole(group) ? { ...rule.roles, [each.as]: memberRole(group) } : rule.roles;
    return wording({ ...rule, roles }, params, (role) => (role === each.as ? eachSaid(each.as) : name(role)), vocabulary);
  };
  /** A step as its kind says it, and its branches — its lists of steps — each under its field's label. */
  const line = (step: Step): StepLine => {
    const spec = stepSpec(step);
    const words = 'forEach' in step ? within(step.forEach) : null;
    const branches = branchesOf(step).flatMap(({ field, steps: inner }) => {
      const said = words ? words.lines(inner) : lines(inner);
      return said.length ? [{ label: field.label, steps: said }] : [];
    });
    return { kind: spec.kind, text: capitalise(spec.line(step, say)), branches };
  };
  /** A step in a sentence, briefly: what it does, not its branches — a "for each"'s steps in its own words. */
  const brief = (step: Step): string => {
    if (!('forEach' in step)) return stepSpec(step).brief(step, say);
    const words = within(step.forEach);
    return stepSpec(step).brief(step, { ...say, briefs: (list) => words.briefs(list) });
  };
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
  const param = (key: string) => paramText(rule.params, key, settingValue(rule, params, key));
  if (rule.sentence) return rule.sentence.replace(/\{(\w+)\}/g, (_, key: string) => (key in rule.roles ? name(key) : param(key)));

  const { text, briefs } = wording(rule, params, name, vocabulary);
  // Its triggers as their own lines say them, mid-sentence.
  const triggers = describeTriggers(rule, params, name, vocabulary).map((line) => line.charAt(0).toLowerCase() + line.slice(1));
  // A condition its settings alone make so — "20 % is below 40 %" — checks its settings, and is not what it waits for: unsaid.
  const only = rule.if && evaluateNow(rule.if, settledScope(rule, params)) !== true ? `if ${text(rule.if)}` : '';
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
