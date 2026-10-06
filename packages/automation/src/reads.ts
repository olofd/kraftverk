import { capabilitySpec, isCapability, type CapabilityNeed } from '@kraftverk/device-sdk';

import { expressionsIn } from './kinds/exprs.ts';
import { EXPRESSION_FIELDS, fieldValue } from './kinds/spec.ts';
import { branchesOf, stepSpec } from './kinds/steps.ts';
import { stepListsOf, triggerSpec } from './kinds/triggers.ts';
import type { Command, Expr, Rule, Step, Write } from './rule.ts';

/*
  What a rule reads and changes, by role: what its conditions read, what its
  steps command and write, whether it takes steps or keeps things so — what
  the engine listens to, and what a screen says a rule does to a part.
*/

/** The events a role's capabilities declare: what a trigger on it can wait for before it is bound. */
export const roleEvents = (spec: CapabilityNeed): string[] =>
  [...new Set([...spec.capabilities, ...(spec.oneOf ?? [])].flatMap((name) => (isCapability(name) ? Object.keys(capabilitySpec(name).events ?? {}) : [])))];

/**
 * Every expression a rule holds at its top — each trigger's, its condition,
 * each step's, within steps too — by its kinds' fields: what a walk over all
 * it reads and compares visits (`expressionsIn` for what is within each).
 */
export function* ruleExpressions(rule: Rule): Generator<Expr> {
  for (const trigger of rule.when) {
    for (const field of triggerSpec(trigger).fields) {
      const value = fieldValue(trigger, field);
      if (value !== undefined && EXPRESSION_FIELDS.has(field.type.type)) yield value as Expr;
    }
  }
  if (rule.if) yield rule.if;
  function* inSteps(steps: readonly Step[]): Generator<Expr> {
    for (const step of steps) {
      for (const field of stepSpec(step).fields) {
        const value = fieldValue(step, field);
        if (value === undefined) continue;
        if (EXPRESSION_FIELDS.has(field.type.type)) yield value as Expr;
        else if (field.type.type === 'args') yield* Object.values(value as Record<string, Expr>);
        else if (field.type.type === 'steps') yield* inSteps(value as readonly Step[]);
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
export function ruleUses(rule: Rule): {
  reads: { role: string; means: string }[];
  events: { role: string; event: string }[];
  calls: { fn: string; role: string }[];
  /** The roles whose reachability it asks about: what a device's health moving can change. */
  reaches: string[];
  /** The settings it changes: each checked against the part that fills its role. */
  writes: Write[];
  /** The roles of the automations it starts. */
  starts: string[];
  /** The windows of the day it looks at: when each opens and closes, something may turn true. */
  windows: { from: Expr; to: Expr }[];
} {
  const reads: { role: string; means: string }[] = [];
  const calls: { fn: string; role: string }[] = [];
  const reaches: string[] = [];
  const writes: Write[] = [];
  const windows: { from: Expr; to: Expr }[] = [];
  const starts: string[] = [];
  // Every expression within, by its kind's children (kinds/exprs.ts): the readings, parts, windows and functions it names.
  for (const top of ruleExpressions(rule)) {
    for (const each of expressionsIn(top)) {
      if ('read' in each) reads.push(each.read);
      else if ('reachable' in each) reaches.push(each.reachable);
      else if ('within' in each) windows.push(each.within);
      else if ('call' in each) calls.push({ fn: each.call, role: each.role });
    }
  }
  // Each step by its kind's fields (kinds/steps.ts): the settings it writes, the automations it starts, and the steps within.
  const walkSteps = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if ('write' in step) writes.push(step.write);
      for (const field of stepSpec(step).fields) {
        const value = fieldValue(step, field);
        if (value === undefined) continue;
        if (field.type.type === 'automation') starts.push(String(value));
        else if (field.type.type === 'steps') walkSteps(value as readonly Step[]);
      }
    }
  };
  // Its own steps, each trigger's, and what it does if one fails.
  for (const list of stepListsOf(rule)) walkSteps(list.steps);
  const events: { role: string; event: string }[] = [];
  // Each trigger by its kind's fields (kinds/triggers.ts): the events it waits for.
  for (const trigger of rule.when) {
    const spec = triggerSpec(trigger);
    for (const field of spec.fields) {
      const type = field.type;
      if (type.type !== 'event') continue;
      const value = fieldValue(trigger, field);
      if (value === undefined) continue;
      const from = spec.fields.find((each) => each.key === type.role);
      events.push({ role: String((from && fieldValue(trigger, from)) ?? ''), event: String(value) });
    }
  }
  return { reads, events, calls, reaches: [...new Set(reaches)], writes, starts: [...new Set(starts)], windows };
}

/** Every command a rule may send, in its steps, its triggers', retries and `otherwise`: what its roles must be able to take. */
export function ruleCommands(rule: Rule): Command[] {
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
export const hasConditions = (rule: Rule): boolean => rule.when.some((trigger) => 'becomes' in trigger);

/**
 * Whether an automation can keep things so (`recheckMinutes`): it waits for
 * a condition, and does what it does at once — so looking again and putting
 * back what was switched against it is the same as running it.
 */
export const keepsSo = (rule: Rule): boolean => hasConditions(rule) && !takesSteps(rule);

/** Whether a rule reads anything of this role: its `becomes` triggers are evaluated when that part's readings move. */
export const readsRole = (rule: Rule, role: string): boolean => ruleUses(rule).reads.some((read) => read.role === role);
