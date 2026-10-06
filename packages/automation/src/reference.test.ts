import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

import type { CompareOp, Expr, MathOp, Step, Trigger } from './rule.ts';
import { ruleFromConfig } from './text/rules.ts';

/*
  The README is the language's reference, and is held to be whole: every
  trigger, step, expression, comparison and operation in both its forms. The
  lists are typed by the language itself — a kind it gains that is not named
  here does not compile — so the reference cannot fall behind it unseen.
*/

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
/** Everything the README writes as code. */
const CODE = [...README.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);

/** The keys of each member of a union: its kinds, with what each carries beside its own name. */
type Keys<U> = U extends unknown ? keyof U : never;

/** Each kind, by its name in data, and a word of its text form. */
const TRIGGERS: Record<Exclude<Keys<Trigger>, 'days' | 'heldFor'>, string> = { at: 'at:', every: 'every:', event: 'event:', becomes: 'becomes:' };
const STEPS: Record<Keys<Step>, string> = {
  command: 'turn on:',
  write: 'set:',
  wait: 'wait:',
  waitUntil: 'wait until:',
  ensure: 'make sure:',
  choose: 'if:',
  watch: 'watch:',
  start: 'start:',
  remember: 'remember:',
  waitFor: 'wait for:',
  repeat: 'repeat:',
  try: 'try:',
  stop: 'stop:',
  forEach: 'for each:',
};
const EXPRESSIONS: Record<Exclude<Keys<Expr>, 'role' | 'args' | 'left' | 'right' | 'unit' | 'then' | 'else' | 'item' | 'field' | 'of' | 'over' | 'offset' | 'as' | 'group'>, string> = {
  value: '50 W',
  param: 'setting.',
  memory: 'memory.',
  read: 'charger.power',
  history: 'average(',
  sun: 'sunset',
  across: 'any(c in',
  call: 'acme.weather.sunny(',
  apply: 'min(',
  compare: ' > ',
  math: ' * ',
  negate: '-meter',
  if: ' ? ',
  either: ' ?? ',
  in: ' in [',
  all: ' and ',
  any: ' or ',
  not: 'not ',
  reachable: ' reachable',
  within: 'time between',
  run: 'run.trigger',
};
const COMPARISONS: Record<CompareOp, string> = { lt: '<', le: '<=', gt: '>', ge: '>=', eq: '==', ne: '!=' };
const ARITHMETIC: Record<MathOp, string> = { add: ' + ', subtract: ' - ', multiply: ' * ', divide: ' / ' };

describe('the reference', () => {
  for (const [what, kinds] of Object.entries({ trigger: TRIGGERS, step: STEPS, expression: EXPRESSIONS, comparison: COMPARISONS, operation: ARITHMETIC })) {
    test(`names every ${what}, in data and in text`, () => {
      const missing = Object.entries(kinds).filter(([data, text]) => !CODE.includes(data) || !CODE.some((code) => code.includes(text)));
      expect(missing.map(([data, text]) => `${data} (${text})`)).toEqual([]);
    });
  }

  test('its example reads as the rule it shows, with nothing wrong', () => {
    const yaml = /```yaml\n([\s\S]*?)```/.exec(README.replace(/\r\n/g, '\n'))?.[1];
    expect(yaml).toBeDefined();
    const read = ruleFromConfig(parse(yaml!) as Record<string, unknown>, []);
    expect(read.issues).toEqual([]);
    expect(read.rule?.then.map((step) => Object.keys(step)[0])).toEqual(['command', 'waitUntil', 'command', 'ensure']);
    expect(read.rule?.otherwise).toHaveLength(2);
  });
});
