import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { describeSteps } from './describe.ts';
import { evaluateNow, inlineParams, memoryOf, settledScope, toRemember } from './evaluate.ts';
import type { Expr, Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';
import { ruleFromConfig, ruleToConfig } from './text/rules.ts';

/*
  What an automation remembers: declared under `memory:` as its settings
  are — each the value it starts from, in its kind and unit — read as
  `memory.timesCharged`, set by a `remember` step, held to its kind and unit
  before it runs, kept in its field's unit, and said in words.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

const MEMORY: NonNullable<Rule['memory']> = {
  fields: {
    timesCharged: { type: 'number', title: 'Times charged', integer: true, min: 0, max: 100, default: 0 },
    lastPower: { type: 'number', title: 'Last power', unit: 'W', default: 0 },
  },
};

const rule = (value: string, name = 'timesCharged'): Rule => ({
  roles: { charger: { label: 'Charger', capabilities: ['powerMeter'] } },
  params: { fields: {} },
  memory: MEMORY,
  when: [{ at: { value: '07:00' } }],
  then: [{ remember: { name, value: parse(value) } }],
});
const check = (checked: Rule) => checkRule(checked, { fn: () => null });

describe('what it remembers, as a file writes it', () => {
  test('read as memory.timesCharged, and written back so', () => {
    expect(parse('memory.timesCharged + 1')).toEqual({ math: 'add', left: { memory: 'timesCharged' }, right: { value: 1 } });
    for (const text of ['memory.timesCharged + 1', 'memory.lastPower > 1 kW']) expect(printExpr(parse(text))).toBe(text);
    expect(parseExpr('memory').ok).toBe(false);
  });

  test('declared under memory, set by a remember step, and written back as it was', () => {
    const entry = {
      name: 'Count the charges',
      memory: { timesCharged: 0, lastPower: { title: 'Power when it last charged', value: '0 W' } },
      when: [{ at: '07:00' }],
      do: [{ remember: 'timesCharged', as: 'memory.timesCharged + 1' }],
    };
    const read = ruleFromConfig(entry, ['automations', 0]);
    expect(read.issues).toEqual([]);
    expect(read.rule!.memory).toEqual({
      fields: { timesCharged: { type: 'number', title: 'Times charged', default: 0 }, lastPower: { type: 'number', title: 'Power when it last charged', unit: 'W', default: 0 } },
    });
    expect(read.rule!.then).toEqual([{ remember: { name: 'timesCharged', value: parse('memory.timesCharged + 1') } }]);
    const written = ruleToConfig(read.rule!, read.uses);
    expect(written.memory).toEqual(entry.memory);
    expect(written.do).toEqual(entry.do);
  });

  test('what is wrong under memory is said as what it remembers', () => {
    const issues = ruleFromConfig({ name: 'x', memory: { count: { value: 0, colour: 'red' } }, when: [{ at: '07:00' }], do: [] }, ['automations', 0]).issues;
    expect(issues.map((issue) => issue.message)).toContainEqual(expect.stringContaining('"colour" is not part of what it remembers'));
  });
});

describe('held to what it is, before it runs', () => {
  test('a value of its kind, in a unit of its own', () => {
    expect(check(rule('memory.timesCharged + 1'))).toEqual([]);
    expect(check(rule('charger.power', 'lastPower'))).toEqual([]);
    expect(check(rule('2 kW', 'lastPower'))).toEqual([]);
  });

  test('what it does not remember, or a value it cannot be', () => {
    expect(check(rule('memory.timesCounted + 1'))).toEqual(['then[0].remember.value.left: it remembers nothing called "timesCounted"']);
    expect(check(rule('1', 'timesCounted'))).toEqual(['then[0].remember.name: it remembers nothing called "timesCounted" — say it under memory']);
    expect(check(rule('20 %', 'lastPower'))).toEqual(['then[0].remember.value: Last power is a number in W, not a number in %']);
  });

  test('"memory" names no role', () => {
    const named: Rule = { ...rule('1'), roles: { memory: { label: 'Memory', capabilities: ['switch'] } } };
    expect(check(named)).toContain('roles.memory: "memory" is how the rule names what it remembers — name the role otherwise');
  });
});

describe('as a run keeps and reads it', () => {
  test('kept in its own unit, and only a value it takes', () => {
    expect(toRemember(MEMORY, 'lastPower', { value: 1.5, unit: 'kW' })).toEqual({ value: 1500 });
    expect(toRemember(MEMORY, 'timesCharged', { value: 101, unit: null })).toEqual({ problem: 'Times charged must be at most 100' });
    expect(toRemember(MEMORY, 'timesCharged', { value: 1.5, unit: null })).toEqual({ problem: 'Times charged must be a whole number' });
    expect(toRemember(MEMORY, 'timesCharged', { value: null, unit: null })).toEqual({ problem: 'Times charged cannot be told now' });
  });

  test('read as a run last left it — or, a value its field no longer takes, as it starts', () => {
    expect(memoryOf(MEMORY, 'lastPower', 1500)).toEqual({ value: 1500, unit: 'W' });
    expect(memoryOf(MEMORY, 'timesCharged', 7)).toEqual({ value: 7, unit: null });
    expect(memoryOf(MEMORY, 'timesCharged', 'seven')).toEqual({ value: 0, unit: null });
    expect(memoryOf(MEMORY, 'timesCharged', undefined)).toEqual({ value: 0, unit: null });
  });

  test('before any run, what it starts from; never settled away', () => {
    const counting = rule('memory.timesCharged + 1');
    expect(evaluateNow(parse('memory.lastPower < 1 kW'), settledScope(counting, {}))).toBe(true);
    expect(inlineParams(counting, {}).then).toEqual(counting.then);
    expect(inlineParams(counting, {}).memory).toEqual(MEMORY);
  });

  test('said in words', () => {
    expect(describeSteps(rule('memory.timesCharged + 1'), {}, (role) => role).steps[0]!.text).toBe('Remember times charged as times charged plus 1');
  });
});
