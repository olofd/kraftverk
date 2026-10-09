import { capabilitySpec, isCapability, type CapabilityNeed } from '@kraftverk/device-sdk';

import { expressionsIn, mapChildren } from './kinds/exprs.ts';
import { fieldValue, withField, type FieldSpec } from './kinds/spec.ts';
import { fieldExprs, mapFieldExprs } from './field-exprs.ts';
import { branchesOf, stepSpec } from './kinds/steps.ts';
import { edgeOf, stepListsOf, triggerFields, triggerSpec } from './kinds/triggers.ts';
import { isWorldRole, OWN_HOME, PLACE_KINDS, placeFact, type Command, type Expr, type PlaceKind, type Rule, type RuleTrigger, type Step, type Write } from './rule.ts';

/*
  What a rule reads and changes, by role: what its conditions read, what its
  steps command and write, whether it takes steps or keeps things so — what
  the engine listens to, and what a screen says a rule does to a part.
*/

/**
 * The rule with what each `for each` calls each part read as its group: a
 * reading of `charger` in its steps is a reading of `chargers`, a command to
 * it a command to each of them — what binding, holding a run's parts and
 * inferring what a role needs all see. Its steps run as written: the engine
 * names each part in turn.
 */
export function eachAsGroup(rule: Rule): Rule {
  const renamed = (expr: Expr, names: Readonly<Record<string, string>>): Expr => {
    // Across a group, its name for each part is the group, within what is said of each.
    if ('across' in expr) return { ...expr, of: renamed(expr.of, { ...names, [expr.as]: expr.group }) };
    const inner = mapChildren(expr, (child) => renamed(child, names));
    if ('read' in inner && names[inner.read.role]) return { ...inner, read: { ...inner.read, role: names[inner.read.role]! } };
    if ('history' in inner && names[inner.of.role]) return { ...inner, of: { ...inner.of, role: names[inner.of.role]! } };
    if ('distance' in inner) {
      const as = (read: { role: string; means: string }) => (names[read.role] ? { ...read, role: names[read.role]! } : read);
      return { distance: as(inner.distance), ...(inner.to ? { to: as(inner.to) } : {}) };
    }
    if ('reachable' in inner && names[inner.reachable]) return { reachable: names[inner.reachable]! };
    if ('call' in inner && names[inner.role]) return { ...inner, role: names[inner.role]! };
    return inner;
  };
  const steps = (list: readonly Step[], names: Readonly<Record<string, string>>): Step[] =>
    list.map((step) => {
      // Within a "for each", its name is its group.
      const within = 'forEach' in step ? { ...names, [step.forEach.as]: step.forEach.in } : names;
      return stepSpec(step).fields.reduce<Step>((done, field) => {
        const value = fieldValue(step, field);
        if (value === undefined) return done;
        const type = field.type.type;
        if (type === 'role') return withField(done, field, names[value as string] ?? value);
        if (type === 'steps') return withField(done, field, steps(value as readonly Step[], within));
        // An expression, a command's arguments, a message's values: each read as its group.
        return fieldExprs(field.type, value).length ? withField(done, field, mapFieldExprs(field.type, value, (expr) => renamed(expr, names))) : done;
      }, step);
    });
  // A trigger's own expressions — what it waits for to hold — and its own steps.
  const trigger = (each: RuleTrigger): RuleTrigger => {
    const fields = triggerFields(each).reduce<RuleTrigger>((done, field) => {
      const value = fieldValue(each, field);
      return fieldExprs(field.type, value).length ? withField(done, field, mapFieldExprs(field.type, value, (expr) => renamed(expr, {}))) : done;
    }, each);
    return fields.then ? { ...fields, then: steps(fields.then, {}) } : fields;
  };
  return {
    ...rule,
    when: rule.when.map(trigger),
    ...(rule.if ? { if: renamed(rule.if, {}) } : {}),
    then: steps(rule.then, {}),
    ...(rule.otherwise ? { otherwise: steps(rule.otherwise, {}) } : {}),
  };
}

/** The events a role's capabilities declare: what a trigger on it can wait for before it is bound. */
export const roleEvents = (spec: CapabilityNeed): string[] =>
  [...new Set([...spec.capabilities, ...(spec.oneOf ?? [])].flatMap((name) => (isCapability(name) ? Object.keys(capabilitySpec(name).events ?? {}) : [])))];

/**
 * Every expression a rule holds at its top — each trigger's, its condition,
 * each step's, within steps too — by its kinds' fields: what a walk over all
 * it reads and compares visits (`expressionsIn` for what is within each).
 */
export function* ruleExpressions(rule: Rule): Generator<Expr> {
  for (const trigger of rule.when) for (const field of triggerSpec(trigger).fields) yield* fieldExprs(field.type, fieldValue(trigger, field));
  if (rule.if) yield rule.if;
  function* inSteps(steps: readonly Step[]): Generator<Expr> {
    for (const step of steps) {
      for (const field of stepSpec(step).fields) {
        const value = fieldValue(step, field);
        if (field.type.type === 'steps') yield* inSteps((value as readonly Step[] | undefined) ?? []);
        else yield* fieldExprs(field.type, value);
      }
    }
  }
  for (const list of stepListsOf(rule)) yield* inSteps(list.steps);
}

/**
 * What a rule reads, the events it waits for, the functions it calls, the
 * settings it writes and the automations it starts: what running it,
 * rehearsing it on history, or binding it, needs.
 */
export function ruleUses(written: Rule): {
  reads: { role: string; means: string }[];
  /** The events that start it: its triggers'. */
  events: { role: string; event: string }[];
  /** The events a step waits for. */
  awaits: { role: string; event: string }[];
  calls: { fn: string; role: string }[];
  /** The roles whose reachability it asks about: what a device's health moving can change. */
  reaches: string[];
  /** The settings it changes: each checked against the part that fills its role. */
  writes: Write[];
  /** The roles of the automations it starts. */
  starts: string[];
  /** The groups a "for each" goes through. */
  groups: string[];
  /** The windows of the day it looks at: when each opens and closes, something may turn true. */
  windows: { from: Expr; to: Expr }[];
  /**
   * Whether it reads the family's world — who is where, a room's occupancy, a
   * home's mode — or waits for it: what someone arriving, a room emptying or
   * a mode changing makes it look again at.
   */
  world: boolean;
  /** The roles of people and places it names: in what starts it, what it reads, and what it does. */
  places: string[];
} {
  // What a "for each"'s steps do to each part, they do to its group.
  const rule = eachAsGroup(written);
  const reads: { role: string; means: string }[] = [];
  const calls: { fn: string; role: string }[] = [];
  const reaches: string[] = [];
  const writes: Write[] = [];
  const windows: { from: Expr; to: Expr }[] = [];
  const starts: string[] = [];
  const groups: string[] = [];
  const awaits: { role: string; event: string }[] = [];
  /** A place, read as a part is: the family's world, not a device's reading. */
  const ofWorld = (role: string) => role === OWN_HOME || Boolean(rule.roles[role] && isWorldRole(rule.roles[role]!));
  let world = rule.when.some((trigger) => triggerSpec(trigger).world);
  const places = new Set<string>();
  /** A field that names who or where: its role, when it is one. */
  const named = (construct: object, fields: readonly FieldSpec[]) => {
    for (const field of fields) {
      if (field.type.type !== 'who' && field.type.type !== 'crowd' && field.type.type !== 'place') continue;
      const value = fieldValue(construct, field);
      if (typeof value === 'string' && rule.roles[value]) places.add(value);
    }
  };
  for (const trigger of rule.when) named(trigger, triggerSpec(trigger).fields);
  // Every expression within, by its kind's children (kinds/exprs.ts): the readings, parts, windows and functions it names.
  for (const top of ruleExpressions(rule)) {
    for (const each of expressionsIn(top)) {
      if ('presentAt' in each || ('read' in each && ofWorld(each.read.role))) {
        world = true;
        for (const role of 'presentAt' in each ? [each.presentAt.who, each.presentAt.place] : 'read' in each ? [each.read.role] : []) if (rule.roles[role]) places.add(role);
      } else if ('across' in each && rule.roles[each.group] && isWorldRole(rule.roles[each.group]!)) places.add(each.group);
      else if ('read' in each) reads.push(each.read);
      else if ('history' in each && !ofWorld(each.of.role)) reads.push(each.of);
      else if ('distance' in each) reads.push(each.distance, ...(each.to ? [each.to] : []));
      else if ('reachable' in each) reaches.push(each.reachable);
      else if ('within' in each) windows.push(each.within);
      else if ('call' in each) calls.push({ fn: each.call, role: each.role });
    }
  }
  // Each step by its kind's fields (kinds/steps.ts): the settings it writes, the automations it starts, and the steps within.
  const walkSteps = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if ('write' in step) writes.push(step.write);
      awaits.push(...eventsIn(step, stepSpec(step).fields));
      named(step, stepSpec(step).fields);
      for (const field of stepSpec(step).fields) {
        const value = fieldValue(step, field);
        if (value === undefined) continue;
        if (field.type.type === 'automation') starts.push(String(value));
        else if (field.type.type === 'group') groups.push(String(value));
        else if (field.type.type === 'steps') walkSteps(value as readonly Step[]);
      }
    }
  };
  // Its own steps, each trigger's, and what it does if one fails.
  for (const list of stepListsOf(rule)) walkSteps(list.steps);
  // Each trigger by its kind's fields (kinds/triggers.ts): the events it waits for.
  const events = rule.when.flatMap((trigger) => eventsIn(trigger, triggerSpec(trigger).fields));
  return { reads, events, awaits, calls, reaches: [...new Set(reaches)], writes, starts: [...new Set(starts)], groups: [...new Set(groups)], windows, world, places: [...places] };
}

/**
 * The kinds of place a role may be, by what the rule does with it: the
 * kinds every field naming it takes, and every fact read of it has — a role
 * whose mode is read, or set, is a home. Every kind, when nothing narrows
 * it; none, when what it asks of it no place is.
 */
export function placeKindsOf(rule: Rule, role: string): PlaceKind[] {
  let kinds: PlaceKind[] = [...PLACE_KINDS];
  const narrow = (allowed: readonly PlaceKind[]) => (kinds = kinds.filter((kind) => allowed.includes(kind)));
  const fields = (construct: object, specs: readonly FieldSpec[]) => {
    for (const field of specs) if (field.type.type === 'place' && field.type.kinds && fieldValue(construct, field) === role) narrow(field.type.kinds);
  };
  for (const trigger of rule.when) fields(trigger, triggerSpec(trigger).fields);
  const steps = (list: readonly Step[]): void => {
    for (const step of list) {
      fields(step, stepSpec(step).fields);
      for (const branch of branchesOf(step)) steps(branch.steps);
    }
  };
  for (const list of stepListsOf(rule)) steps(list.steps);
  for (const top of ruleExpressions(rule)) {
    for (const each of expressionsIn(top)) {
      const fact = 'read' in each && each.read.role === role ? placeFact(each.read.means) : null;
      if (fact) narrow(fact.kinds);
    }
  }
  return kinds;
}

/** The events a construct names, by its fields: each with the role whose part raises it — the field its event field names. */
function eventsIn(construct: object, fields: readonly FieldSpec[]): { role: string; event: string }[] {
  return fields.flatMap((field) => {
    const type = field.type;
    if (type.type !== 'event') return [];
    const value = fieldValue(construct, field);
    if (value === undefined) return [];
    const from = fields.find((each) => each.key === type.role);
    return [{ role: String((from && fieldValue(construct, from)) ?? ''), event: String(value) }];
  });
}

/** Every command a rule may send, in its steps, its triggers', retries and `otherwise`: what its roles must be able to take — a "for each"'s to its group. */
export function ruleCommands(written: Rule): Command[] {
  const rule = eachAsGroup(written);
  const found: Command[] = [];
  const walk = (steps: readonly Step[]) => {
    for (const step of steps) {
      if ('command' in step) found.push(step.command);
      for (const branch of branchesOf(step)) walk(branch.steps);
    }
  };
  for (const list of stepListsOf(rule)) walk(list.steps);
  return found;
}

/**
 * The roles whose parts a rule may change — every part a command or a
 * setting names, whichever way it goes: what a run of it holds while it runs,
 * and what it shares with another automation (docs/SHARED-PARTS-AND-RESERVE.md).
 */
export const changedRoles = (rule: Rule): string[] => [...new Set([...ruleCommands(rule).map((command) => command.role), ...ruleUses(rule).writes.map((write) => write.role)])];

/**
 * Whether a rule takes steps — waits, choices, another automation, a
 * fallback — rather than sending its commands and settings at once,
 * whatever starts it.
 */
export const takesSteps = (rule: Rule): boolean =>
  stepListsOf(rule).some((list) => list.steps.some((step) => !stepSpec(step).atOnce)) || Boolean(rule.otherwise?.length);

/** Whether a rule waits for a condition to come true. */
export const hasConditions = (rule: Rule): boolean => rule.when.some((trigger) => edgeOf(trigger) !== null);

/**
 * Whether an automation can keep things so (`recheckMinutes`): it waits for
 * a condition, and does what it does at once — so looking again and putting
 * back what was switched against it is the same as running it.
 */
export const keepsSo = (rule: Rule): boolean => hasConditions(rule) && !takesSteps(rule) && stepListsOf(rule).every((list) => list.steps.every((step) => stepSpec(step).kept === true));

/** Whether a rule reads anything of this role: its `becomes` triggers are evaluated when that part's readings move. */
export const readsRole = (rule: Rule, role: string): boolean => ruleUses(rule).reads.some((read) => read.role === role);
