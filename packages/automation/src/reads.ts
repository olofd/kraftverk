import { capabilitySpec, isCapability, type CapabilityNeed } from '@kraftverk/device-sdk';

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
  const walk = (expr: Expr | undefined): void => {
    if (!expr) return;
    if ('read' in expr) reads.push(expr.read);
    else if ('reachable' in expr) reaches.push(expr.reachable);
    else if ('within' in expr) (windows.push(expr.within), walk(expr.within.from), walk(expr.within.to));
    else if ('call' in expr) (calls.push({ fn: expr.call, role: expr.role }), Object.values(expr.args ?? {}).forEach(walk));
    else if ('compare' in expr || 'math' in expr) (walk(expr.left), walk(expr.right));
    else if ('all' in expr) expr.all.forEach(walk);
    else if ('any' in expr) expr.any.forEach(walk);
    else if ('not' in expr) walk(expr.not);
  };
  const walkSteps = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if ('command' in step) Object.values(step.command.args).forEach(walk);
      else if ('write' in step) (writes.push(step.write), walk(step.write.value));
      else if ('start' in step) (starts.push(step.start.role), walk(step.start.waitSeconds));
      else if ('wait' in step) walk(step.wait.seconds);
      else if ('waitUntil' in step) (walk(step.waitUntil.condition), walk(step.waitUntil.atMostSeconds));
      else if ('ensure' in step) (walk(step.ensure.condition), walk(step.ensure.withinSeconds), walk(step.ensure.tries), walkSteps(step.ensure.retry));
      else if ('choose' in step) (walk(step.choose.if), walkSteps(step.choose.then), walkSteps(step.choose.else ?? []));
      else (walk(step.watch.condition), walk(step.watch.seconds), walkSteps(step.watch.then ?? []), walkSteps(step.watch.else ?? []));
    }
  };
  const events: { role: string; event: string }[] = [];
  for (const trigger of rule.when) {
    if ('at' in trigger) walk(trigger.at);
    if ('every' in trigger) walk(trigger.every);
    else if ('event' in trigger) events.push(trigger.event);
    else if ('becomes' in trigger) (walk(trigger.becomes), walk(trigger.heldForMinutes));
  }
  walk(rule.if);
  walkSteps(rule.then);
  walkSteps(rule.otherwise ?? []);
  return { reads, events, calls, reaches: [...new Set(reaches)], writes, starts: [...new Set(starts)], windows };
}

/** Every command a rule may send, in its steps, retries and `otherwise`: what its roles must be able to take. */
export function ruleCommands(rule: Rule): Command[] {
  const found: Command[] = [];
  const walk = (steps: readonly Step[]) => {
    for (const step of steps) {
      if ('command' in step) found.push(step.command);
      else if ('ensure' in step) walk(step.ensure.retry);
      else if ('choose' in step) (walk(step.choose.then), walk(step.choose.else ?? []));
      else if ('watch' in step) (walk(step.watch.then ?? []), walk(step.watch.else ?? []));
    }
  };
  walk(rule.then);
  walk(rule.otherwise ?? []);
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
 * fallback — rather than sending its commands and settings at once.
 */
export const takesSteps = (rule: Rule): boolean => rule.then.some((step) => !('command' in step) && !('write' in step)) || Boolean(rule.otherwise?.length);

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
