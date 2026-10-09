import { attributeMeaning, BUILT_IN_MODES, CAMEL_NAME, MODE_KEY, capabilitySpec, checkValue, isCapability, MAIN_PART, meetsNeed, partsOf, standardMeaning, valueTypeOf, type AttributeSpec, type CapabilityId, type CapabilityNeed, type DeviceDescription, type ModeAxis as Axis, type Value, type ValueType } from '@kraftverk/device-sdk';

import { CLOCK_TIME, minutesOf, WEEKDAYS, type Weekday } from './clock.ts';
import { secondsText } from './describe.ts';
import { evaluateNow, settledScope } from './evaluate.ts';
import { BUILTIN_ORDER, BUILTINS, isBuiltin } from './kinds/builtins.ts';
import { HISTORY_ORDER, HISTORY_SECONDS, isHistoryFn } from './kinds/history.ts';
import { ACROSS_FNS, ACROSS_ORDER, isAcrossFn } from './kinds/across.ts';
import { isSunEvent, SUN_OFFSET_SECONDS } from './sun.ts';
import { expressionsIn } from './kinds/exprs.ts';
import { fieldValue, type FieldSpec } from './kinds/spec.ts';
import { branchesOf, STEP_KIND_ORDER, STEP_KINDS } from './kinds/steps.ts';
import { stepListsOf, TRIGGER_FIELDS, TRIGGER_KIND_ORDER, TRIGGER_KINDS } from './kinds/triggers.ts';
import type { AutomationFunction } from './functions.ts';
import { eachAsGroup, placeKindsOf, ruleExpressions, ruleUses } from './reads.ts';
import { convert, convertible, isUnit, product, quotient, unitIn, type Unit } from '@kraftverk/device-sdk';
import { KEYWORDS } from './text/expr.ts';
import {
  COMPARE_OPS,
  groupRoles,
  isAutomationRole,
  isGroupRole,
  isPartRole,
  isPeopleRole,
  isPersonRole,
  isPlaceRole,
  isWhileRunning,
  isWorldRole,
  memberRole,
  MATH_OPS,
  OWN_HOME,
  PLACE_FACTS,
  placeFact,
  roleKind,
  WHILE_RUNNING,
  ORDERED_OPS,
  partRoles,
  RUN_FACTS,
  SEQUENCE_LIMITS,
  TRIGGER_ID,
  type Command,
  type Expr,
  type PartRole,
  type Rule,
  type RuleTrigger,
  type RunFact,
  type RoleSpec,
  type Step,
  type WriteTarget,
} from './rule.ts';
import { parseMessage } from './message.ts';

/*
  Checking a rule before it runs (docs/AUTOMATIONS.md): every role, setting,
  reading, command and function it names is one there is, of the shape each
  is used as; and a rule bound to parts is checked against what fills its
  roles. Each problem in words, placed where a person finds it.
*/

/**
 * What an expression is, as far as can be known before it runs. A list or an
 * object is `structure`: a rule can hand one to a function, never compare it —
 * reading into structure is what functions are for.
 */
/** A number's unit: one written or reported, `''` for one that has none (a rank), null when it is the unit of what it is beside. */
type Shape = { type: 'number'; unit: Unit | '' | null } | { type: 'boolean' } | { type: 'string'; options: readonly string[] | null } | { type: 'structure' } | { type: 'unknown' };

const shapeOf = (type: ValueType): Shape => {
  switch (type.type) {
    case 'number':
      return { type: 'number', unit: type.unit ?? null };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'string', options: type.options.map((option) => option.value) };
    case 'string':
    case 'timestamp':
      return { type: 'string', options: null };
    case 'list':
    case 'object':
      return { type: 'structure' };
  }
};

const shapeOfValue = (value: Value): Shape =>
  value === null
    ? { type: 'unknown' }
    : typeof value === 'number'
      ? { type: 'number', unit: null }
      : typeof value === 'boolean'
        ? { type: 'boolean' }
        : typeof value === 'string'
          ? { type: 'string', options: null }
          : { type: 'structure' };

const said = (shape: Shape): string =>
  shape.type === 'number' && shape.unit ? `a number in ${shape.unit}` : shape.type === 'number' && shape.unit === '' ? 'a number with no unit' : shape.type === 'number' ? 'a number' : shape.type === 'structure' ? 'a list or an object' : `a ${shape.type}`;

/** Whether a value of shape `given` may stand where `wanted` is expected: a number in a unit of the same quantity, converted as it runs. */
function fits(wanted: Shape, given: Shape): boolean {
  if (wanted.type === 'unknown' || given.type === 'unknown') return true;
  if (wanted.type !== given.type) return false;
  if (wanted.type === 'number' && given.type === 'number') {
    if (wanted.unit === null || given.unit === null) return true;
    return wanted.unit === '' || given.unit === '' ? wanted.unit === given.unit : convertible(given.unit, wanted.unit);
  }
  return true;
}

export type RuleVocabulary = {
  /** The installed function with this id, or null. */
  fn(id: string): AutomationFunction | null;
  /**
   * The setting a `write` changes on the part filling a role, once the role
   * is filled: what its words say ("Live readings") and how its value reads.
   * Absent, or not known, and the setting is named by its key.
   */
  attribute?(role: string, target: WriteTarget): AttributeSpec | null;
  /** The family's modes, its own beside the built-in ones: each by key, on its axis, by its name. Absent: any key may be one, and its home says. */
  modes?(): readonly RuleMode[];
};

/** A mode as the language knows one: its key, its axis, its name — "Guests over". */
export type RuleMode = { key: string; axis: Axis; name: string };

/** What a role that is not a part is, in words: "an automation", "a person". */
const kindWords = (spec: RoleSpec): string =>
  ({ part: 'one part', group: 'several parts', automation: 'an automation', person: 'a person', people: 'people', place: 'a place' })[roleKind(spec)];

/** The standard meanings a part offering these capabilities reports. */
const meaningsOfNeed = (need: CapabilityNeed): Set<string> =>
  new Set([...need.capabilities, ...(need.oneOf ?? [])].flatMap((name) => (isCapability(name) ? Object.values(capabilitySpec(name).attributes).map((attribute) => attribute.means) : [])));

/**
 * Everything wrong with a rule, each with where it is: "then[0].command.args.on:
 * expected a boolean, got a number". Empty when it can run. Checks it against
 * the capability library and the installed functions — not against devices:
 * `checkBinding` does that once its roles are filled.
 */
export function checkRule(rule: Rule, vocabulary: RuleVocabulary): string[] {
  const problems: string[] = [];
  const roles = rule.roles ?? {};
  const params = rule.params?.fields ?? {};
  /** What it remembers: what `memory.x` reads and a `remember` step sets. */
  const memory = rule.memory?.fields ?? {};
  /** The ids its triggers carry: what `startedBy` may name. */
  const triggerIds = new Set((rule.when ?? []).flatMap((trigger) => (trigger.id ? [trigger.id] : [])));
  /**
   * The triggers that may start what is being checked: a trigger's own steps,
   * that one; the automation's, those without steps of their own; elsewhere,
   * any. What `run.event` and `run.who` may say is what these give.
   */
  let starting: readonly RuleTrigger[] = rule.when ?? [];
  /** The events that may start it: what `run.event` may be. */
  const eventIds = () => [...new Set(starting.flatMap((trigger) => ('event' in trigger && trigger.event?.event ? [trigger.event.event] : [])))];
  /** Whether what may start it knows a fact of the run: `run.who`, who arriving or leaving started it. */
  const gives = (fact: RunFact) => starting.some((trigger) => TRIGGER_KIND_ORDER.some((kind) => kind in trigger && TRIGGER_KINDS[kind].gives.includes(fact)));

  for (const [role, spec] of Object.entries(roles)) {
    // What it asks of a place, no place is: a zone's mode, a home and a zone at once.
    if (isPlaceRole(spec) && !placeKindsOf(rule, role).length) problems.push(`roles.${role}: no place is everything it is asked to be — a mode is a home's`);
    if (!CAMEL_NAME.test(role)) problems.push(`roles.${role}: a role is named in camelCase`);
    if (role === 'run') problems.push('roles.run: "run" is what the run knows of itself — name the role otherwise');
    else if (role === 'setting') problems.push('roles.setting: "setting" is how the rule names its settings — name the role otherwise');
    else if (role === 'memory') problems.push('roles.memory: "memory" is how the rule names what it remembers — name the role otherwise');
    else if (role === 'given') problems.push('roles.given: "given" is how the rule names what it is given — name the role otherwise');
    else if (KEYWORDS.has(role)) problems.push(`roles.${role}: "${role}" is a word of the language — name the role otherwise`);
    if (!spec.label?.trim()) problems.push(`roles.${role}: it has no label`);
    if (isAutomationRole(spec) || isWorldRole(spec)) continue;
    const named = [...(spec.capabilities ?? []), ...(spec.oneOf ?? [])];
    if (!named.length) problems.push(`roles.${role}: it asks for no capability, so any device would do`);
    for (const capability of named) if (!isCapability(capability)) problems.push(`roles.${role}: there is no capability "${capability}"`);
  }

  /**
   * What the steps of a `for each` call each part of its group, while they
   * are checked: a role of one part, asking what the group asks of each.
   */
  let scoped: Readonly<Record<string, PartRole>> = {};
  /** What an `across` over people calls each of them, while what is said of each is checked: a person, as a role is. */
  let scopedPeople: ReadonlySet<string> = new Set();

  /** The role of one part a name is — within a `for each`, each part of its group — without a word about it: what a field's own check has said already. */
  const quietly = (name: string): PartRole | null => {
    const spec = scoped[name] ?? roles[name];
    return spec && isPartRole(spec) ? spec : null;
  };

  /** A place a name is: `home`, the automation's own, or a role a place fills — said, when it is not. */
  const place = (name: string, where: string): boolean => {
    if (name === OWN_HOME) return true;
    const spec = roles[name];
    if (!name) problems.push(`${where}: which place?`);
    else if (!spec) problems.push(`${where}: there is no role "${name}" — a place is home, or a role a home, a zone or a space fills`);
    else if (!isPlaceRole(spec)) problems.push(`${where}: ${name} is ${kindWords(spec)}, not a place`);
    return Boolean(spec && isPlaceRole(spec));
  };

  /** Who a name is: a role a person fills — or people, `many` — what an `across` over people calls each, or the word for the whole family. */
  const who = (name: string, where: string, options: { many: boolean; anyone?: string }): void => {
    if (options.anyone && name === options.anyone) return;
    if (scopedPeople.has(name)) return;
    const spec = roles[name];
    const words = options.anyone ? `a role a person or people fill, or "${options.anyone}"` : options.many ? 'a role a person or people fill' : 'a role a person fills';
    if (!name) problems.push(`${where}: who?`);
    else if (!spec) problems.push(`${where}: there is no role "${name}" — who is ${words}`);
    else if (!(isPersonRole(spec) || (options.many && isPeopleRole(spec)))) problems.push(`${where}: ${name} is ${kindWords(spec)}, not ${options.many ? 'a person, or people' : 'a person'}${isPeopleRole(spec) ? ` — say it of each: any(p in ${name}: p at home)` : ''}`);
  };

  /** A role a part fills: what is read, asked, switched or written — or, within a `for each`, each part of its group. */
  const role = (name: string, where: string): PartRole | null => {
    const each = scoped[name];
    if (each) return each;
    const spec = roles[name];
    // A block whose part is still to choose, as an editor makes one: said as that.
    if (!name) problems.push(`${where}: choose a part`);
    else if (!spec) problems.push(`${where}: there is no role "${name}"`);
    else if (isGroupRole(spec)) problems.push(`${where}: ${name} is several parts — name each in turn with "for each"`);
    else if (!isPartRole(spec)) problems.push(`${where}: ${name} is ${kindWords(spec)}, not a part of a device`);
    return spec && isPartRole(spec) ? spec : null;
  };

  const shape = (expr: Expr, where: string, options: { calls: boolean; trigger?: boolean }): Shape => {
    if ('value' in expr) {
      if (expr.unit === undefined) return shapeOfValue(expr.value);
      if (typeof expr.value !== 'number') problems.push(`${where}: only a number has a unit`);
      else if (!isUnit(expr.unit)) problems.push(`${where}: "${expr.unit}" is not a unit the language knows`);
      return typeof expr.value === 'number' ? { type: 'number', unit: expr.unit } : shapeOfValue(expr.value);
    }
    if ('run' in expr) {
      if (!RUN_FACTS.includes(expr.run)) {
        problems.push(`${where}: a run knows its ${RUN_FACTS.join(', ')} — not "${String(expr.run)}"`);
        return { type: 'unknown' };
      }
      const said = `run.${expr.run}${expr.field !== undefined ? `.${expr.field}` : ''}`;
      // Before a run there is none: what starts it cannot ask what started it.
      if (options.trigger) problems.push(`${where}: ${said} is known once it runs — in what it does, not in what starts it`);
      if (expr.run === 'event') {
        // Only a rule that waits for an event can be started by one.
        if (!eventIds().length) problems.push(`${where}: ${said} is what an event that started it says, but nothing that starts this is an event`);
        if (expr.field !== undefined) {
          if (typeof expr.field !== 'string' || !CAMEL_NAME.test(expr.field)) problems.push(`${where}: "${String(expr.field)}" is not something an event carries`);
          // What it carried: its type is the device's to say, once a part fills the role.
          return { type: 'unknown' };
        }
        return { type: 'string', options: eventIds() };
      }
      if (expr.field !== undefined) problems.push(`${where}: run.${expr.run} carries nothing more`);
      if (expr.run === 'who') {
        if (!gives('who')) problems.push(`${where}: run.who is who arriving or leaving started it, but nothing that starts this is someone arriving or leaving`);
        return { type: 'string', options: null };
      }
      // One of its triggers' ids: compared with any other, the comparison says so.
      return { type: 'string', options: [...triggerIds, ''] };
    }
    if ('param' in expr) {
      const field = params[expr.param];
      if (!field) {
        problems.push(`${where}: there is no setting "${expr.param}"`);
        return { type: 'unknown' };
      }
      return shapeOf(valueTypeOf(field));
    }
    if ('input' in expr) {
      const field = rule.inputs?.fields[expr.input];
      if (!field) {
        problems.push(`${where}: it takes no input called "${expr.input}"`);
        return { type: 'unknown' };
      }
      return shapeOf(valueTypeOf(field));
    }
    if ('memory' in expr) {
      const field = memory[expr.memory];
      if (!field) {
        problems.push(`${where}: it remembers nothing called "${expr.memory}"`);
        return { type: 'unknown' };
      }
      return shapeOf(valueTypeOf(field));
    }
    if ('read' in expr && (expr.read.role === OWN_HOME || (roles[expr.read.role] && isWorldRole(roles[expr.read.role]!)))) {
      // What is so of a place now: how many are there, whether anyone is, its modes.
      const spec = roles[expr.read.role];
      if (spec && !isPlaceRole(spec)) {
        problems.push(`${where}: ${expr.read.role} is ${kindWords(spec)}: ask where with "at" — ${isPeopleRole(spec) ? `any(p in ${expr.read.role}: p at home)` : `${expr.read.role} at home`}`);
        return { type: 'unknown' };
      }
      const fact = placeFact(expr.read.means);
      if (!fact) {
        problems.push(`${where}: of a place, ask its ${Object.keys(PLACE_FACTS).join(', ')} — not "${expr.read.means}"`);
        return { type: 'unknown' };
      }
      if (fact.value.type === 'number') return { type: 'number', unit: '' };
      if (fact.value.type === 'boolean') return { type: 'boolean' };
      // A home's mode on this axis: one of its modes, not the other's — "away" is never the time of day.
      const axis = fact.value.axis;
      return { type: 'string', options: vocabulary.modes ? vocabulary.modes().filter((mode) => mode.axis === axis).map((mode) => mode.key) : null };
    }
    if ('presentAt' in expr) {
      who(expr.presentAt.who, `${where}.presentAt.who`, { many: false });
      place(expr.presentAt.place, `${where}.presentAt.place`);
      return { type: 'boolean' };
    }
    if ('read' in expr) {
      const spec = role(expr.read.role, where);
      if (!expr.read.means) {
        if (expr.read.role) problems.push(`${where}: choose what it reports`);
        return { type: 'unknown' };
      }
      const standard = standardMeaning(expr.read.means);
      if (!standard) return { type: 'unknown' }; // a type's own meaning: checked when bound
      if (spec && !meaningsOfNeed(spec).has(expr.read.means)) {
        problems.push(`${where}: ${expr.read.role} asks for nothing that reports ${expr.read.means}`);
      }
      // One in any of several units — a price, in its provider's currency — is compared in its own, known once bound.
      if (standard.type === 'object') return { type: 'structure' };
      return standard.type === 'boolean' ? { type: 'boolean' } : { type: 'number', unit: standard.units ? null : (standard.unit ?? '') };
    }
    if ('call' in expr) {
      if (!options.calls) problems.push(`${where}: "becomes" is evaluated on every reading, so it cannot call ${expr.call}`);
      const fn = vocabulary.fn(expr.call);
      const spec = role(expr.role, where);
      if (!fn) {
        problems.push(`${where}: there is no function "${expr.call}" installed`);
        return { type: 'unknown' };
      }
      if (spec && !meetsNeed(fn.needs, [...spec.capabilities, ...(spec.oneOf ?? [])].filter(isCapability))) {
        problems.push(`${where}: ${fn.label} needs a part that offers ${[...fn.needs.capabilities, ...(fn.needs.oneOf ?? [])].join(', ')}, and ${expr.role} does not ask for that`);
      }
      const given = expr.args ?? {};
      for (const [name, type] of Object.entries(fn.args)) {
        const arg = given[name];
        if (!arg) problems.push(`${where}.args.${name}: ${fn.label} needs it`);
        else {
          const got = shape(arg, `${where}.args.${name}`, options);
          if (!fits(shapeOf(type), got)) problems.push(`${where}.args.${name}: expected ${said(shapeOf(type))}, got ${said(got)}`);
          else literalFits(arg, type, `${where}.args.${name}`);
        }
      }
      for (const name of Object.keys(given)) if (!(name in fn.args)) problems.push(`${where}.args.${name}: ${fn.label} takes no "${name}"`);
      return shapeOf(fn.returns);
    }
    if ('history' in expr) {
      // A number a part reports, looked back at for a minute to two weeks — a number or a setting, known before it runs.
      if (!isHistoryFn(expr.history)) {
        problems.push(`${where}: "${String(expr.history)}" is not a way of looking back: ${HISTORY_ORDER.join(', ')}`);
        return { type: 'unknown' };
      }
      bounded(expr.over, `${where}.over`, 's', HISTORY_SECONDS.min, HISTORY_SECONDS.max);
      // What was is kept of what devices report — not of who is where, nor of a home's mode.
      const of = roles[expr.of.role];
      if (expr.of.role === OWN_HOME || (of && isWorldRole(of))) {
        problems.push(`${where}: how it was is kept of what a part reports, not of a place or a person`);
        return { type: 'unknown' };
      }
      const read = shape({ read: expr.of }, where, options);
      if (read.type !== 'number' && read.type !== 'unknown') problems.push(`${where}: only a number is looked back at, not ${said(read)}`);
      return read.type === 'number' ? read : { type: 'number', unit: null };
    }
    if ('distance' in expr) {
      // Each a position a part reports: a standard meaning of that quantity, or a type's own, checked once bound.
      for (const [field, read] of [['distance', expr.distance], ['to', expr.to]] as const) {
        if (!read) continue;
        const spec = role(read.role, `${where}.${field}`);
        const standard = read.means ? standardMeaning(read.means) : null;
        if (!read.means) problems.push(`${where}.${field}: choose the position it reports`);
        else if (standard && !(standard.type === 'object' && standard.quantity === 'position')) problems.push(`${where}.${field}: ${read.means} is not a position`);
        else if (standard && spec && !meaningsOfNeed(spec).has(read.means)) problems.push(`${where}.${field}: ${read.role} asks for nothing that reports ${read.means}`);
      }
      return { type: 'number', unit: 'm' };
    }
    if ('reachable' in expr) {
      role(expr.reachable, where);
      return { type: 'boolean' };
    }
    if ('math' in expr) {
      if (!MATH_OPS.includes(expr.math)) problems.push(`${where}: "${expr.math}" is not +, -, * or /`);
      const left = shape(expr.left, `${where}.left`, options);
      const right = shape(expr.right, `${where}.right`, options);
      for (const [side, got] of [['left', left], ['right', right]] as const) {
        if (!fits({ type: 'number', unit: null }, got)) problems.push(`${where}.${side}: expected a number, got ${said(got)}`);
      }
      if (expr.math === 'multiply' || expr.math === 'divide') {
        // The unit the two make (units.ts): a power for a time is an energy; one that makes none kraftverk knows is a mistake.
        const unitOf = (side: Shape): Unit | null => (side.type === 'number' && side.unit ? side.unit : null);
        if (left.type !== 'number' || right.type !== 'number' || left.unit === null || right.unit === null) return { type: 'number', unit: left.type === 'number' && right.type === 'number' && expr.math === 'multiply' ? (left.unit ?? right.unit) : null };
        const made = expr.math === 'multiply' ? product(unitOf(left), unitOf(right)) : quotient(unitOf(left), unitOf(right));
        if (!made) {
          problems.push(`${where}: ${said(left)} ${expr.math === 'multiply' ? 'times' : 'divided by'} ${said(right)} makes no unit kraftverk knows`);
          return { type: 'unknown' };
        }
        return { type: 'number', unit: made.unit ?? '' };
      }
      const units = [left, right].flatMap((side) => (side.type === 'number' && side.unit !== null ? [side.unit] : []));
      if (units.length === 2 && !fits({ type: 'number', unit: units[0]! }, { type: 'number', unit: units[1]! })) problems.push(`${where}: ${units[0]} and ${units[1]} are not of one quantity`);
      return { type: 'number', unit: units[0] ?? null };
    }
    if ('apply' in expr) {
      const spec = isBuiltin(expr.apply) ? BUILTINS[expr.apply] : null;
      if (!spec) {
        problems.push(`${where}: "${String(expr.apply)}" is not one of the language's functions: ${BUILTIN_ORDER.join(', ')}`);
        return { type: 'unknown' };
      }
      const args = expr.args ?? [];
      const { min, max } = spec.arity;
      if (args.length < min || (max !== null && args.length > max)) {
        problems.push(`${where}: ${spec.name} takes ${max === null ? `${min} or more` : min === max ? min : `${min} to ${max}`} ${max === 1 ? 'number' : 'numbers'}`);
      }
      const got = args.map((arg, index) => shape(arg, `${where}.args[${index}]`, options));
      got.forEach((each, index) => {
        if (!fits({ type: 'number', unit: null }, each)) problems.push(`${where}.args[${index}]: expected a number, got ${said(each)}`);
      });
      const first = got[0]?.type === 'number' ? got[0] : null;
      // Its arguments in the first one's unit — or, round's digits, plain numbers.
      got.slice(1).forEach((each, index) => {
        if (each.type !== 'number') return;
        if (spec.units === 'first' ? each.unit !== null && each.unit !== '' : first && !fits(first, each)) {
          problems.push(`${where}.args[${index + 1}]: ${spec.units === 'first' ? 'a plain number' : `expected ${said(first!)}`}, got ${said(each)}`);
        }
      });
      return { type: 'number', unit: first?.unit ?? null };
    }
    if ('negate' in expr) {
      const got = shape(expr.negate, `${where}.negate`, options);
      if (!fits({ type: 'number', unit: null }, got)) problems.push(`${where}.negate: expected a number, got ${said(got)}`);
      return got.type === 'number' ? got : { type: 'unknown' };
    }
    if ('if' in expr) {
      const condition = shape(expr.if, `${where}.if`, options);
      if (!fits({ type: 'boolean' }, condition)) problems.push(`${where}.if: expected a condition, got ${said(condition)}`);
      const [then, otherwise] = [shape(expr.then, `${where}.then`, options), shape(expr.else, `${where}.else`, options)];
      if (!fits(then, otherwise)) problems.push(`${where}: one way ${said(then)}, the other ${said(otherwise)}`);
      return then.type === 'unknown' ? otherwise : then;
    }
    if ('either' in expr) {
      const parts = (expr.either ?? []).map((part, index) => shape(part, `${where}.either[${index}]`, options));
      if (parts.length < 2) problems.push(`${where}: the first known of fewer than two is no choice`);
      const known = parts.find((part) => part.type !== 'unknown') ?? { type: 'unknown' };
      parts.forEach((part, index) => {
        if (!fits(known, part)) problems.push(`${where}.either[${index}]: expected ${said(known)}, got ${said(part)}`);
      });
      return known;
    }
    if ('in' in expr) {
      const item = shape(expr.item, `${where}.item`, options);
      if (item.type === 'structure' || item.type === 'boolean') problems.push(`${where}.item: one of a list is a number or a text, not ${said(item)}`);
      if (!(expr.in ?? []).length) problems.push(`${where}: one of nothing is never so`);
      (expr.in ?? []).forEach((option, index) => {
        const got = shape(option, `${where}.in[${index}]`, options);
        if (!fits(item, got)) problems.push(`${where}.in[${index}]: expected ${said(item)}, got ${said(got)}`);
        if (item.type === 'string' && item.options && 'value' in option && typeof option.value === 'string' && !item.options.includes(option.value)) {
          problems.push(`${where}.in[${index}]: "${option.value}" is not one of ${item.options.join(', ')}`);
        }
      });
      return { type: 'boolean' };
    }
    if ('across' in expr) {
      if (!isAcrossFn(expr.across)) {
        problems.push(`${where}: "${String(expr.across)}" is not a way of taking a group's parts together: ${ACROSS_ORDER.join(', ')}`);
        return { type: 'unknown' };
      }
      const spec = ACROSS_FNS[expr.across];
      const group = roles[expr.group];
      if (!expr.group) problems.push(`${where}: which group?`);
      else if (!group) problems.push(`${where}: there is no role "${expr.group}"`);
      else if (!isGroupRole(group) && !isPeopleRole(group)) problems.push(`${where}: ${expr.group} is ${kindWords(group)}, not several`);
      // A name of its own for each part: not a role's, an outer one's, nor a word of the language.
      const named = CAMEL_NAME.test(expr.as) && !roles[expr.as] && !scoped[expr.as] && !scopedPeople.has(expr.as) && !KEYWORDS.has(expr.as);
      if (!named) problems.push(`${where}: "${expr.as}" names something already, or nothing — call each part otherwise`);
      // A package is asked once, for one part: not of each part of a group.
      if ([...expressionsIn(expr.of)].some((each) => 'call' in each)) problems.push(`${where}.of: a package's function is not asked of each part of a group`);
      const outer = scoped;
      const outerPeople = scopedPeople;
      if (named && group && isGroupRole(group)) scoped = { ...outer, [expr.as]: memberRole(group) };
      // Each of several people: a person, as a role is — "p at home".
      if (named && group && isPeopleRole(group)) scopedPeople = new Set([...outerPeople, expr.as]);
      const got = shape(expr.of, `${where}.of`, { ...options, calls: true });
      scoped = outer;
      scopedPeople = outerPeople;
      if (spec.takes === 'condition') {
        if (!fits({ type: 'boolean' }, got)) problems.push(`${where}.of: ${expr.across} asks whether something holds of each part, not ${said(got)}`);
        return expr.across === 'count' ? { type: 'number', unit: null } : { type: 'boolean' };
      }
      if (!fits({ type: 'number', unit: null }, got)) problems.push(`${where}.of: ${expr.across} takes a number of each part, not ${said(got)}`);
      return got.type === 'number' ? got : { type: 'number', unit: null };
    }
    if ('sun' in expr) {
      if (!isSunEvent(expr.sun)) problems.push(`${where}: "${String(expr.sun)}" is not when the sun rises or sets: sunrise, sunset`);
      // So long before or after it: a number or a setting, known before it runs.
      if (expr.offset) bounded(expr.offset.by, `${where}.offset.by`, 's', SUN_OFFSET_SECONDS.min, SUN_OFFSET_SECONDS.max);
      return { type: 'string', options: null };
    }
    if ('within' in expr) {
      const ends = [
        ['from', expr.within?.from],
        ['to', expr.within?.to],
      ] as const;
      for (const [end, given] of ends) {
        if (!given) {
          problems.push(`${where}.within.${end}: a time of day is "HH:MM"`);
          continue;
        }
        const got = shape(given, `${where}.within.${end}`, options);
        if (!fits({ type: 'string', options: null }, got)) problems.push(`${where}.within.${end}: expected a time of day, got ${said(got)}`);
        else if ('value' in given && minutesOf(given.value) === null) problems.push(`${where}.within.${end}: a time of day is "HH:MM"`);
      }
      const [from, to] = [expr.within?.from, expr.within?.to];
      if (from && to && 'value' in from && 'value' in to && minutesOf(from.value) !== null && from.value === to.value) problems.push(`${where}.within: from ${String(from.value)} to the same time is no window`);
      return { type: 'boolean' };
    }
    if ('compare' in expr) {
      if (!COMPARE_OPS.includes(expr.compare)) problems.push(`${where}: "${expr.compare}" is not a comparison`);
      const left = shape(expr.left, `${where}.left`, options);
      const right = shape(expr.right, `${where}.right`, options);
      if (!fits(left, right)) problems.push(`${where}: compares ${said(left)} with ${said(right)}`);
      const ordered = ORDERED_OPS.includes(expr.compare);
      if (ordered && [left, right].some((side) => side.type === 'boolean' || side.type === 'string')) problems.push(`${where}: only numbers are above or below each other`);
      if ([left, right].some((side) => side.type === 'structure')) problems.push(`${where}: a list or an object is read by a function, not compared`);
      // An option the other side can never be is a mistake, not a condition.
      for (const [side, other] of [[left, expr.right], [right, expr.left]] as const) {
        if (side.type === 'string' && side.options && 'value' in other && typeof other.value === 'string' && !side.options.includes(other.value)) {
          problems.push(`${where}: "${other.value}" is not one of ${side.options.length ? side.options.join(', ') : 'them: there are none'}`);
        }
      }
      return { type: 'boolean' };
    }
    const parts = 'all' in expr ? expr.all : 'any' in expr ? expr.any : 'not' in expr ? [expr.not] : null;
    if (!parts) {
      problems.push(`${where}: not an expression`);
      return { type: 'unknown' };
    }
    parts.forEach((part, index) => {
      const got = shape(part, 'not' in expr ? `${where}.not` : `${where}.${'all' in expr ? 'all' : 'any'}[${index}]`, options);
      if (!fits({ type: 'boolean' }, got)) problems.push(`${where}: expected conditions, got ${said(got)}`);
    });
    return { type: 'boolean' };
  };

  /** A literal where a typed value is expected is held to its range and options too. */
  const literalFits = (expr: Expr, type: ValueType, where: string) => {
    if (!('value' in expr) || expr.value === null) return;
    if (type.type === 'enum' && !type.options.some((option) => option.value === expr.value)) problems.push(`${where}: "${String(expr.value)}" is not one of ${type.options.map((option) => option.value).join(', ')}`);
    if (type.type === 'number' && typeof expr.value === 'number' && ((type.min !== undefined && expr.value < type.min) || (type.max !== undefined && expr.value > type.max))) {
      problems.push(`${where}: ${expr.value} is out of range`);
    }
  };

  // No trigger is allowed: it runs when played, or started by another automation.
  (rule.when ?? []).forEach((trigger, index) => {
    const where = `when[${index}]`;
    // Each kind's fields, and those every trigger has, by what each holds (kinds/triggers.ts).
    const kind = TRIGGER_KIND_ORDER.find((each) => each in trigger);
    if (!kind) {
      problems.push(`${where}: not a trigger`);
      return;
    }
    for (const field of [...TRIGGER_KINDS[kind].fields, ...TRIGGER_FIELDS]) {
      const value = fieldValue(trigger, field);
      const at = `${where}.${field.data.join('.')}`;
      if (value === undefined || value === null) {
        if (field.required) problems.push(`${at}: it needs ${field.label.toLowerCase()}`);
        continue;
      }
      // What it does is said at the top, as the automation's own steps are — started by this trigger alone.
      const was = starting;
      if (field.type.type === 'steps') starting = [trigger];
      checkField(field, value, at, { inTrigger: true, sure: true, depth: 0 });
      starting = was;
    }
  });

  /** One field of a construct, held to what it holds (kinds/spec.ts) - and, a value, what it was found to be, for its kind to hold to more. */
  function checkField(field: FieldSpec, value: unknown, at: string, where: { inTrigger: boolean; sure: boolean; depth: number }): Shape | undefined {
    const type = field.type;
    switch (type.type) {
      case 'condition': {
        const got = shape(value as Expr, at, { calls: !where.inTrigger && type.calls === true, trigger: where.inTrigger });
        if (!fits({ type: 'boolean' }, got)) problems.push(`${at}: expected a condition, got ${said(got)}`);
        return;
      }
      case 'value': {
        const got = shape(value as Expr, at, { calls: true, trigger: where.inTrigger });
        if (got.type === 'structure') problems.push(`${at}: a setting is set to a value, not a list or an object`);
        return got;
      }
      case 'timeOfDay': {
        const expr = value as Expr;
        const got = shape(expr, at, { calls: false, trigger: true });
        if (!fits({ type: 'string', options: null }, got)) problems.push(`${at}: expected a time of day, got ${said(got)}`);
        if ('value' in expr && (typeof expr.value !== 'string' || !CLOCK_TIME.test(expr.value))) problems.push(`${at}: a time of day is "HH:MM"`);
        return;
      }
      case 'duration': {
        const expr = value as Expr;
        // A fixed one — a step's wait — is a number or a setting held to its range, so how long a run may take is known before it runs.
        if (type.fixed) {
          bounded(expr, at, 's', type.min, type.max);
          return;
        }
        const got = shape(expr, at, { calls: false, trigger: where.inTrigger });
        if (!isTime(expr, got)) problems.push(`${at}: expected a length of time, got ${said(got)}`);
        const seconds = secondsOfLiteral(expr, at);
        const whole = type.step ? `, in steps of ${secondsText(type.step)}` : '';
        if (typeof seconds === 'number' && (seconds < type.min || seconds > type.max || (type.step !== undefined && seconds % type.step !== 0))) {
          problems.push(`${at}: from ${secondsText(type.min)} to ${secondsText(type.max)}${whole}`);
        }
        return;
      }
      case 'days': {
        const days = value as readonly string[];
        if (!Array.isArray(days) || !days.length) problems.push(`${at}: on no day, it never runs`);
        else {
          for (const day of days) if (!WEEKDAYS.includes(day as Weekday)) problems.push(`${at}: "${String(day)}" is not a day of the week`);
          if (new Set(days).size !== days.length) problems.push(`${at}: a day is named twice`);
        }
        return;
      }
      case 'count':
        bounded(value as Expr, at, null, 1, type.max);
        return;
      case 'role':
        role(String(value), at);
        return;
      case 'automation': {
        const name = String(value);
        const spec = roles[name];
        if (!name) problems.push(`${at}: choose an automation`);
        else if (!spec) problems.push(`${at}: there is no role "${name}"`);
        else if (!isAutomationRole(spec)) problems.push(`${at}: ${name} is ${kindWords(spec)}, not an automation`);
        return;
      }
      case 'group': {
        const name = String(value);
        const spec = roles[name];
        if (!name) problems.push(`${at}: choose the parts`);
        else if (!spec) problems.push(`${at}: there is no role "${name}"`);
        else if (!isGroupRole(spec)) problems.push(`${at}: ${name} is ${kindWords(spec)}, not several parts`);
        return;
      }
      case 'each': {
        // A name of its own: not a role's, nor an outer "for each"'s, nor one the language keeps.
        const name = String(value);
        if (!CAMEL_NAME.test(name)) problems.push(`${at}: a name in camelCase: "charger"`);
        else if (roles[name] || scoped[name] || scopedPeople.has(name) || KEYWORDS.has(name)) problems.push(`${at}: "${name}" names something already — call each part otherwise`);
        return;
      }
      case 'event':
        if (!String(value).trim()) problems.push(`${at}: which event?`);
        return;
      case 'id':
        if (typeof value !== 'string' || !TRIGGER_ID.test(value)) problems.push(`${at}: letters and digits, starting with a lowercase letter`);
        else if ((rule.when ?? []).filter((other) => other.id === value).length > 1) problems.push(`${at}: "${value}" is another trigger's id too`);
        return;
      case 'steps': {
        const list = value as readonly Step[];
        if (type.nonEmpty && !list.length) problems.push(`${at}: ${type.nonEmpty}`);
        steps(list, at, type.sure === false ? false : where.sure, where.depth + 1);
        return;
      }
      case 'text':
        if (typeof value !== 'string' || !value.trim()) problems.push(`${at}: say it in words`);
        return;
      case 'flag':
        if (typeof value !== 'boolean') problems.push(`${at}: true or false`);
        return;
      // A command's capability, command and arguments, a setting's key or meaning, and what a step remembers: their kind's own check, below.
      case 'name':
      case 'args':
      case 'memory':
        return;
      case 'who':
        who(String(value), at, { many: true, ...(type.anyone ? { anyone: type.anyone } : {}) });
        return;
      case 'crowd': {
        const name = String(value);
        const spec = roles[name];
        if (!spec) problems.push(`${at}: there is no role "${name}" — some of you are a role people fill`);
        else if (!isPeopleRole(spec)) problems.push(`${at}: ${name} is ${kindWords(spec)}, not people`);
        return;
      }
      case 'place':
        place(String(value), at);
        return;
      case 'mode': {
        const key = String(value);
        if (!MODE_KEY.test(key)) problems.push(`${at}: a mode, by its key: ${BUILT_IN_MODES.map((mode) => mode.key).join(', ')}, or one of the family's own`);
        else if (vocabulary.modes && !vocabulary.modes().some((mode) => mode.key === key)) problems.push(`${at}: there is no mode "${key}" — ${vocabulary.modes().map((mode) => mode.key).join(', ')}`);
        return;
      }
      case 'choice':
        if (!type.options.some((option) => option.value === value)) problems.push(`${at}: one of ${type.options.map((option) => option.value).join(', ')}`);
        return;
      case 'message': {
        if (typeof value !== 'string' || !value.trim()) {
          problems.push(`${at}: say it in words`);
          return;
        }
        if (value.length > type.max) problems.push(`${at}: at most ${type.max} characters`);
        const parsed = parseMessage(value);
        if (!parsed.ok) {
          problems.push(`${at}: ${parsed.error.message}`);
          return;
        }
        // Each value in it is said as it is: of any kind but a list or an object. Each by its place among the values: {1} the first.
        parsed.pieces
          .filter((piece): piece is Extract<typeof piece, { expr: unknown }> => 'expr' in piece)
          .forEach((piece, index) => {
            const got = shape(piece.expr, `${at}{${index + 1}}`, { calls: true });
            if (got.type === 'structure') problems.push(`${at}: {${piece.source}} is a list or an object: say one of its values`);
          });
        return;
      }
      default: {
        const unknown: never = type;
        throw new Error(`No check for a field of type ${JSON.stringify(unknown)}`);
      }
    }
  }

  if (rule.if) {
    const got = shape(rule.if, 'if', { calls: true });
    if (!fits({ type: 'boolean' }, got)) problems.push(`if: expected a condition, got ${said(got)}`);
  }

  /**
   * A number a step counts by — seconds, tries — held to its limit: a literal
   * at once; a setting by its own range, so no value its form accepts can
   * exceed it.
   */
  /**
   * Whether a length of time is in a unit it can be read in: one written in
   * any unit of time, converted; a setting — a plain number in its own unit,
   * not converted — only in seconds, as a run reads it.
   */
  function isTime(expr: Expr, got: Shape): boolean {
    if ('param' in expr) return got.type === 'unknown' || (got.type === 'number' && (got.unit === null || got.unit === 's'));
    return fits({ type: 'number', unit: 's' }, got);
  }

  /** A length of time written outright, in seconds — or null, said where it is, when it says no unit of time. */
  function secondsOfLiteral(expr: Expr, where: string): number | null {
    if (!('value' in expr) || typeof expr.value !== 'number') return null;
    if (expr.unit === undefined) {
      problems.push(`${where}: a length of time says its unit: "${expr.value} s", "${expr.value} min" or "${expr.value} h"`);
      return null;
    }
    return convert(expr.value, expr.unit, 's');
  }

  function bounded(expr: Expr, where: string, unit: 's' | null, min: number, max: number): void {
    const got = shape(expr, where, { calls: false });
    if (unit ? !isTime(expr, got) : !fits({ type: 'number', unit }, got)) {
      problems.push(`${where}: expected ${unit ? 'a length of time' : 'a number'}, got ${said(got)}`);
      return;
    }
    const [low, high] = unit ? [secondsText(min), secondsText(max)] : [String(min), String(max)];
    const value = unit ? secondsOfLiteral(expr, where) : 'value' in expr ? expr.value : null;
    if (typeof value === 'number' && !(value >= min && value <= max)) problems.push(`${where}: from ${low} to ${high}`);
    if ('param' in expr) {
      const field = params[expr.param];
      if (field?.type === 'number' && (field.max === undefined || field.max > max || field.min === undefined || field.min < min)) {
        problems.push(`${where}: the setting "${expr.param}" must be held between ${low} and ${high}`);
      }
    }
    if (!('value' in expr) && !('param' in expr)) problems.push(`${where}: a number or a setting, not one read or worked out: how long a run may take is known before it runs`);
  }

  /**
   * Steps, in order. `sure`: where a step may fail the run — waiting for a
   * condition that never comes. Not in a retry, which is itself being tried,
   * nor in `otherwise`, which runs because something already did not succeed.
   */
  function steps(list: readonly Step[], where: string, sure: boolean, depth: number): void {
    if (list.length && depth > SEQUENCE_LIMITS.depth) problems.push(`${where}: steps within steps, more than ${SEQUENCE_LIMITS.depth} deep`);
    list.forEach((step, index) => {
      const at = `${where}[${index}]`;
      const kind = STEP_KIND_ORDER.find((each) => each in step);
      if (!kind) {
        problems.push(`${at}: not a step`);
        return;
      }
      const spec = STEP_KINDS[kind];
      if (spec.waits && !sure) problems.push(`${at}: nothing here may wait for a condition that might not come: it would fail again`);
      /** What each of its values was found to be, by its key. */
      const shapes: Record<string, Shape> = {};
      const outer = scoped;
      for (const field of spec.fields) {
        const value = fieldValue(step, field);
        const fieldAt = `${at}.${field.data.join('.')}`;
        if (value === undefined || value === null) {
          if (field.required && field.type.type !== 'name') problems.push(`${fieldAt}: it needs ${field.label.toLowerCase()}`);
          continue;
        }
        // A "for each"'s steps call each part of its group by its name: a role of one part, while they are checked.
        if ('forEach' in step && field.type.type === 'steps') {
          const group = roles[step.forEach.in];
          // A name already taken names nothing new: what it would hide stays as it is.
          if (group && isGroupRole(group) && CAMEL_NAME.test(step.forEach.as) && !roles[step.forEach.as] && !outer[step.forEach.as] && !KEYWORDS.has(step.forEach.as)) scoped = { ...outer, [step.forEach.as]: memberRole(group) };
        }
        const got = checkField(field, value, fieldAt, { inTrigger: false, sure, depth });
        if (got) shapes[field.key] = got;
      }
      scoped = outer;
      if ('command' in step) command(step.command, `${at}.command`);
      else if ('write' in step) {
        // Which setting, and whether the value fits it, is the bound part's to say (`checkBinding`).
        const { key, means } = step.write as { key?: unknown; means?: unknown };
        if (key !== undefined && means !== undefined) problems.push(`${at}.write: a setting by its key or by its meaning, not both`);
        else if (means !== undefined) {
          if (typeof means !== 'string' || !standardMeaning(means)) problems.push(`${at}.write.means: "${String(means)}" is not a standard meaning`);
        } else if (typeof key !== 'string' || !key.trim()) problems.push(`${at}.write.key: which setting?`);
      } else if ('remember' in step) {
        // What it remembers is held to what it is: its kind, and a unit of its dimension.
        const field = memory[step.remember.name];
        if (!step.remember.name) problems.push(`${at}.remember.name: what does it remember?`);
        else if (!field) problems.push(`${at}.remember.name: it remembers nothing called "${step.remember.name}" — say it under memory`);
        else {
          const got = shapes.as ?? { type: 'unknown' };
          const wanted = shapeOf(valueTypeOf(field));
          if (!fits(wanted, got)) problems.push(`${at}.remember.value: ${field.title} is ${said(wanted)}, not ${said(got)}`);
          else literalFits(step.remember.value, valueTypeOf(field), `${at}.remember.value`);
        }
      } else if ('start' in step) {
        if (step.start.andWait !== undefined && !sure) problems.push(`${at}.start: nothing here may wait for what might not come: it is started, not waited for`);
        // What it answers is known only once it has ended: waited for.
        if (step.start.remember !== undefined) {
          if (step.start.andWait === undefined) problems.push(`${at}.start.remember: what it answers is known once it ends — wait for it ("and wait")`);
          if (!memory[step.start.remember]) problems.push(`${at}.start.remember: it remembers nothing called "${step.start.remember}" — say it under memory`);
        }
        for (const [name, given] of Object.entries(step.start.args ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) problems.push(`${at}.start.args.${name}: "${name}" is not an input's name`);
          const got = shape(given, `${at}.start.args.${name}`, { calls: true });
          if (got.type === 'structure') problems.push(`${at}.start.args.${name}: an input is given a value, not a list or an object`);
        }
      } else if ('answer' in step) {
        // Of the kind it says it answers, in a unit of it.
        if (!rule.result) problems.push(`${at}.answer: it answers nothing — say what it answers under result`);
        else {
          const wanted = shapeOf(valueTypeOf(rule.result));
          const got = shapes.answer ?? { type: 'unknown' };
          if (!fits(wanted, got)) problems.push(`${at}.answer: ${rule.result.title} is ${said(wanted)}, not ${said(got)}`);
          else literalFits(step.answer, valueTypeOf(rule.result), `${at}.answer`);
        }
      } else if ('choose' in step || 'watch' in step) {
        const branches = branchesOf(step);
        if (branches.every((branch) => !branch.steps.length)) problems.push(`${at}.${kind}: it does nothing either way`);
      }
    });
  }

  // Each input takes a value its field takes when not given; what it answers, when none is given.
  for (const [key, field] of Object.entries(rule.inputs?.fields ?? {})) {
    const value = 'default' in field ? field.default : undefined;
    if (value === undefined || value === null) problems.push(`inputs.${key}: it takes no value when not given`);
    else {
      const checked = checkValue(valueTypeOf(field), value);
      if (!checked.ok) problems.push(`inputs.${key}: ${field.title} ${checked.problem}`);
    }
  }
  // What it remembers starts from a value its field takes.
  for (const [key, field] of Object.entries(memory)) {
    const value = 'default' in field ? field.default : undefined;
    if (value === undefined || value === null) problems.push(`memory.${key}: it starts from no value`);
    else {
      const checked = checkValue(valueTypeOf(field), value);
      if (!checked.ok) problems.push(`memory.${key}: ${field.title} ${checked.problem}`);
    }
  }
  // Each setting holds a value its field takes: what the rule runs with.
  for (const [key, field] of Object.entries(params)) {
    const value = 'default' in field ? field.default : undefined;
    if (value === undefined || value === null) {
      problems.push(`settings.${key}: it has no value`);
      continue;
    }
    const checked = checkValue(valueTypeOf(field), value);
    if (!checked.ok) problems.push(`settings.${key}: ${field.title} ${checked.problem}`);
  }
  // A condition its settings alone make false: it would never act — the settings are the mistake.
  if (rule.if && evaluateNow(rule.if, settledScope(rule as Rule, {})) === false) problems.push('settings: with these settings it is never so that it may act');

  // A start while it runs: one of the ways there are.
  if (rule.whileRunning !== undefined && !isWhileRunning(rule.whileRunning)) problems.push(`whileRunning: "${String(rule.whileRunning)}" is none of ${Object.keys(WHILE_RUNNING).join(', ')}`);
  // Whatever starts it does something: its own steps, or the automation's.
  if (!rule.then?.length) {
    const without = (rule.when ?? []).flatMap((trigger, index) => (trigger.then?.length ? [] : [index]));
    if (!rule.when?.length) problems.push('then: it does nothing');
    for (const index of without) problems.push(`when[${index}].then: it does nothing — say what it does, or what the automation does`);
  }
  // The automation's own steps: started by any trigger without steps of its own.
  const ownStart = (rule.when ?? []).filter((trigger) => !trigger.then?.length);
  starting = ownStart.length || !(rule.when ?? []).length ? ownStart : [];
  steps(rule.then ?? [], 'then', true, 1);
  starting = rule.when ?? [];
  steps(rule.otherwise ?? [], 'otherwise', false, 1);

  return problems;

  function command(command: Command, where: string): void {
    // Its role is its field's to check, and said there: here only what it asks of it.
    const spec = quietly(command.role);
    if (!isCapability(command.capability)) {
      problems.push(`${where}: there is no capability "${command.capability}"`);
      return;
    }
    if (spec && ![...spec.capabilities, ...(spec.oneOf ?? [])].includes(command.capability)) problems.push(`${where}: ${command.role} does not ask for ${command.capability}`);
    const declared = capabilitySpec(command.capability).commands[command.command];
    if (!declared) {
      problems.push(`${where}: ${command.capability} takes no command "${command.command}"`);
      return;
    }
    for (const [name, type] of Object.entries(declared.args)) {
      const arg = command.args?.[name];
      if (!arg) problems.push(`${where}.args.${name}: ${command.capability}.${command.command} needs it`);
      else {
        const got = shape(arg, `${where}.args.${name}`, { calls: true });
        if (!fits(shapeOf(type), got)) problems.push(`${where}.args.${name}: expected ${said(shapeOf(type))}, got ${said(got)}`);
        else literalFits(arg, type, `${where}.args.${name}`);
      }
    }
    for (const name of Object.keys(command.args ?? {})) if (!(name in declared.args)) problems.push(`${where}.args.${name}: ${command.capability}.${command.command} takes no "${name}"`);
  }
}

/** Which part of an automation a problem is in, as an editor groups them: what it uses, what starts it, its condition, its steps, its fallback — or the whole. */
export type ProblemArea = 'uses' | 'settings' | 'when' | 'onlyIf' | 'does' | 'fails' | 'other';

/** Which part of a rule a problem `checkRule` found is in, from its path: "when[0].days" a trigger, "then[2]…" a step. */
export function problemArea(problem: string): ProblemArea {
  const path = problem.slice(0, Math.max(0, problem.indexOf(': ')));
  if (/^roles\./.test(path)) return 'uses';
  if (/^settings\b/.test(path)) return 'settings';
  if (/^when\b/.test(path)) return 'when';
  if (/^if\b/.test(path)) return 'onlyIf';
  if (/^then\b/.test(path)) return 'does';
  if (/^otherwise\b/.test(path)) return 'fails';
  return 'other';
}

/**
 * A problem `checkRule` found, said where a person finds it: "then[3].ensure.retry[1].wait.seconds: …"
 * becomes "Step 4, each time, step 2: …"; "when[0].days: …" "Trigger 1: …"; "if: …" "Only if: …"; a role by
 * its label. What follows the step is the problem's own words, and stays.
 */
export function problemPlace(problem: string, rule: Pick<Rule, 'roles'>): string {
  const colon = problem.indexOf(': ');
  if (colon < 0) return problem;
  const path = problem.slice(0, colon);
  const said = problem.slice(colon + 2);
  const role = /^roles\.([A-Za-z0-9]+)/.exec(path);
  if (role) return `${rule.roles[role[1]!]?.label ?? role[1]}: ${said}`;
  const trigger = /^when\[(\d+)\]/.exec(path);
  if (trigger) return `Trigger ${Number(trigger[1]) + 1}: ${said}`;
  if (/^if\b/.test(path)) return `Only if: ${said}`;
  const setting = /^settings(?:\.([A-Za-z0-9_-]+))?/.exec(path);
  if (setting) return `${setting[1] ? 'Setting' : 'Settings'}: ${said}`;
  const root = /^(then|otherwise)(?:\[(\d+)\])?/.exec(path);
  if (!root) return problem;
  if (root[2] === undefined) return root[1] === 'then' ? `What it does: ${said}` : `If a step does not succeed: ${said}`;
  const places = [`${root[1] === 'then' ? 'Step' : 'If a step does not succeed, step'} ${Number(root[2]) + 1}`];
  // Steps within a step, by its field's words (kinds/steps.ts): "each time, step 2".
  for (const step of path.slice(root[0].length).matchAll(/\.([A-Za-z]+\.[A-Za-z]+)\[(\d+)\]/g)) {
    const within = WITHIN_WORDS.get(step[1]!);
    if (within) places.push(`${within}, step ${Number(step[2]) + 1}`);
  }
  return `${places.join(', ')}: ${said}`;
}

/** Each list of steps within a step, by where it is kept — `ensure.retry` — as a problem's place says it: "each time". */
const WITHIN_WORDS: ReadonlyMap<string, string> = new Map(
  STEP_KIND_ORDER.flatMap((kind) => STEP_KINDS[kind].fields.flatMap((field): [string, string][] => (field.type.type === 'steps' ? [[field.data.join('.'), field.label.toLowerCase()]] : [])))
);

/** The part filling a role, as a binding check sees it. */
export type BoundPart = {
  name: string;
  description: DeviceDescription;
  part: string;
  capabilities: readonly CapabilityId[];
};

/**
 * What a rule's `start` steps give the automation filling `role`, and what
 * they remember of its answer, held to that one's `inputs` and `result`:
 * each input it is given one it takes, a value written out of its kind and
 * range; what it answers, of the kind it is remembered as. Said by the role's
 * label: "Charging: it takes no input "speed"".
 */
export function checkStarted(rule: Rule, role: string, target: Pick<Rule, 'inputs' | 'result'>): string[] {
  const problems: string[] = [];
  const who = rule.roles[role]?.label ?? role;
  const walk = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if ('start' in step && step.start.role === role) {
        for (const [name, given] of Object.entries(step.start.args ?? {})) {
          const field = target.inputs?.fields[name];
          if (!field) {
            problems.push(`${who}: it takes no input "${name}"${Object.keys(target.inputs?.fields ?? {}).length ? ` — it takes ${Object.keys(target.inputs!.fields).join(', ')}` : ''}`);
            continue;
          }
          // A value written out is held to the input now: in its unit, of its kind and range.
          if ('value' in given && given.value !== null) {
            const type = valueTypeOf(field);
            const into = type.type === 'number' ? type.unit : undefined;
            const value = typeof given.value === 'number' && given.unit && into ? convert(given.value, given.unit, into) : given.value;
            if (value === null) problems.push(`${who}: ${field.title} is in ${into}, not ${given.unit}`);
            else {
              const checked = checkValue(type, value);
              if (!checked.ok) problems.push(`${who}: ${field.title} ${checked.problem}`);
            }
          }
        }
        if (step.start.remember !== undefined) {
          const kept = rule.memory?.fields[step.start.remember];
          if (!target.result) problems.push(`${who}: it answers nothing to remember`);
          else if (kept && !fits(shapeOf(valueTypeOf(kept)), shapeOf(valueTypeOf(target.result)))) problems.push(`${who}: it answers ${said(shapeOf(valueTypeOf(target.result)))}, and ${kept.title} is ${said(shapeOf(valueTypeOf(kept)))}`);
        }
      }
      for (const branch of branchesOf(step)) walk(branch.steps);
    }
  };
  for (const list of stepListsOf(rule)) walk(list.steps);
  return problems;
}

/**
 * Everything wrong with a rule's roles as they are filled: a part that does
 * not offer what its role needs, reports no meaning the rule reads, or never
 * raises an event the rule waits for. Empty when it can run as it is.
 * `bound`: the parts filling a role — one, several for a group, none yet.
 */
export function checkBinding(written: Rule, bound: (role: string) => readonly BoundPart[]): string[] {
  const problems: string[] = [];
  // What a "for each" does to each part, it does to every part of its group: each is held to it.
  const rule = eachAsGroup(written);
  // An automation's roles are the server's to check: whether the automation is there, and the chain it makes.
  for (const [role, spec] of [...partRoles(rule), ...groupRoles(rule)]) {
    const parts = bound(role);
    if (!parts.length) problems.push(`${spec.label}: no device`);
    for (const part of parts) {
      if (!partsOf(part.description).some((candidate) => candidate.id === part.part)) problems.push(`${spec.label}: ${part.name} no longer has that part`);
      else if (!meetsNeed(spec, part.capabilities)) problems.push(`${spec.label}: ${part.name} cannot do that`);
    }
  }
  const { reads, events, awaits, writes } = ruleUses(rule);
  for (const read of reads) {
    for (const part of bound(read.role)) {
      if (!attributeMeaning(part.description, part.part, read.means)) problems.push(`${rule.roles[read.role]?.label ?? read.role}: ${part.name} does not report ${read.means}`);
    }
  }
  for (const wanted of [...events, ...awaits]) {
    for (const part of bound(wanted.role)) {
      const declared = part.description.events?.find((event) => event.id === wanted.event && (event.part ?? MAIN_PART) === part.part);
      if (!declared) problems.push(`${rule.roles[wanted.role]?.label ?? wanted.role}: ${part.name} never says "${wanted.event}"`);
    }
  }
  // What an event carried, read as run.event.<field>: something at least one of the events it waits for carries, as its device declares it.
  const carried = new Set([...ruleExpressions(rule)].flatMap((top) => [...expressionsIn(top)].flatMap((each) => ('run' in each && each.run === 'event' && each.field ? [each.field] : []))));
  for (const field of carried) {
    const declaring = events.map((wanted) => {
      const [part] = bound(wanted.role);
      return part ? (part.description.events?.find((event) => event.id === wanted.event && (event.part ?? MAIN_PART) === part.part) ?? null) : undefined;
    });
    // A part not bound yet says nothing either way.
    if (declaring.some((event) => event === undefined)) continue;
    if (!declaring.some((event) => event?.data && field in event.data)) problems.push(`run.event.${field}: none of the events it waits for carries "${field}"`);
  }
  // A setting changed: the part has it, it can be written, it is not one that can harm the hardware, and the value fits it.
  for (const write of writes) for (const part of bound(write.role)) {
    const attribute = writtenAttribute(part.description, part.part, write);
    const who = rule.roles[write.role]?.label ?? write.role;
    if (!attribute) problems.push(`${who}: ${part.name} has no setting ${write.means !== undefined ? `that is its ${(standardMeaning(write.means)?.label ?? write.means).toLowerCase()}` : `"${write.key}"`}`);
    else if (attribute.access !== 'write') problems.push(`${who}: ${attribute.label} of ${part.name} is read, not set`);
    else if (attribute.dangerous) problems.push(`${who}: ${attribute.label} of ${part.name} can harm it, and is never changed by an automation`);
    else if ('value' in write.value) {
      // In the setting's own unit: 2 kW to one in W is 2000.
      const { value, unit } = write.value;
      const into = attribute.value.type === 'number' ? attribute.value.unit : undefined;
      const converted = typeof value === 'number' && unit && into ? convert(value, unit, into) : value;
      if (converted === null) problems.push(`${who}: ${attribute.label} is set in ${into}, not ${unit}`);
      else {
        const checked = checkValue(attribute.value, converted);
        if (!checked.ok) problems.push(`${who}: ${attribute.label} ${checked.problem}`);
      }
    }
  }
  // A number beside a reading is in a unit of its quantity: "50 °C" beside a part's power is a mistake, seen once the part is known.
  const unitsRead = (expr: Expr): { unit: Unit; label: string; part: string }[] => {
    if (!('read' in expr)) return [];
    return bound(expr.read.role).flatMap((part) => {
      const attribute = attributeMeaning(part.description, part.part, expr.read.means);
      const unit = attribute ? unitIn(attribute) : null;
      return attribute && unit ? [{ unit, label: attribute.label, part: part.name }] : [];
    });
  };
  for (const top of ruleExpressions(rule)) {
    for (const each of expressionsIn(top)) {
      if (!('compare' in each) && !('math' in each)) continue;
      for (const [side, other] of [[each.left, each.right], [each.right, each.left]] as const) {
        for (const read of unitsRead(side)) {
          if ('value' in other && other.unit && !convertible(other.unit, read.unit)) problems.push(`${read.part}’s ${read.label.toLowerCase()} is in ${read.unit}: "${other.unit}" is not a unit of it`);
        }
      }
    }
  }
  return problems;
}

/**
 * The setting a `write` changes, on the part filling its role — by its key,
 * or the one there that has its meaning and can be set: what its words and
 * its value are held to.
 */
export const writtenAttribute = (description: DeviceDescription, part: string, target: WriteTarget): AttributeSpec | null =>
  description.attributes.find(
    (candidate) => (candidate.part ?? MAIN_PART) === part && (target.means !== undefined ? candidate.means === target.means && candidate.access === 'write' : candidate.key === target.key)
  ) ?? null;
