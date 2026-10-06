import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { describeExpr } from './describe.ts';
import { evaluateNow, measureNow, type RuleScope } from './evaluate.ts';
import { HISTORY_FNS, type HistoryPoint } from './kinds/history.ts';
import { ruleUses } from './reads.ts';
import type { Expr, Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';

/*
  A reading over the time just gone: its average, lowest, highest, how much
  it changed, what it was then — read from its text and written back, each
  value counted from when it was read until the next, held to a number and
  a length of time before it runs, evaluated in the reading's unit, and
  said in words.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

const MIN = 60_000;
/** An hour of a charger's power: 0 W for 30 min, 100 W for 15, 40 W for the last 15. */
const HOUR: HistoryPoint[] = [
  { at: 0, value: 0 },
  { at: 30 * MIN, value: 100 },
  { at: 45 * MIN, value: 40 },
];

describe('looking back, as a file writes it', () => {
  test('read and written back as it was', () => {
    expect(parse('average(charger.power, 1 h) > 50 W')).toEqual({ compare: 'gt', left: { history: 'average', of: { role: 'charger', means: 'power' }, over: { value: 1, unit: 'h' } }, right: { value: 50, unit: 'W' } });
    for (const text of ['average(charger.power, 1 h)', 'lowest(station.charge, setting.window)', 'change(station.charge, 30 min) > 5 %', 'ago(charger.power, 10 min)', 'highest(charger.power, 2 d)']) expect(printExpr(parse(text))).toBe(text);
  });
});

describe('what it makes of what was kept', () => {
  const [from, to] = [0, 60 * MIN];
  test('the average weighs each value by how long it held', () => {
    expect(HISTORY_FNS.average.of(HOUR, from, to)).toBe((100 * 15 + 40 * 15) / 60);
    // Kept only for the last half hour: the average of that.
    expect(HISTORY_FNS.average.of(HOUR.slice(1), from, to)).toBe((100 * 15 + 40 * 15) / 30);
    expect(HISTORY_FNS.average.of([], from, to)).toBeNull();
  });

  test('lowest and highest; how much it changed; what it was then', () => {
    expect(HISTORY_FNS.lowest.of(HOUR, from, to)).toBe(0);
    expect(HISTORY_FNS.highest.of(HOUR, from, to)).toBe(100);
    expect(HISTORY_FNS.change.of(HOUR, from, to)).toBe(40);
    expect(HISTORY_FNS.ago.of(HOUR, 40 * MIN, to)).toBe(100);
    // Nothing kept from before the time began: what it was then, and so how much it changed, is not known.
    expect(HISTORY_FNS.ago.of(HOUR.slice(1), from, to)).toBeNull();
    expect(HISTORY_FNS.change.of(HOUR.slice(1), from, to)).toBeNull();
  });
});

describe('held to what it is, before it runs', () => {
  const roles: Rule['roles'] = { charger: { label: 'Charger', capabilities: ['switch', 'powerMeter'] } };
  const rule = (condition: string, params: Rule['params'] = { fields: {} }): Rule => ({ roles, params, when: [{ becomes: parse(condition) }], then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: false } } } }] });
  const check = (checked: Rule) => checkRule(checked, { fn: () => null });

  test('a number a part reports, for a minute to two weeks — a number or a setting, never a reading', () => {
    expect(check(rule('average(charger.power, 1 h) < 5 W'))).toEqual([]);
    expect(check(rule('average(charger.power, setting.window) < 5 W', { fields: { window: { type: 'number', title: 'Window', unit: 's', min: 60, max: 3600, default: 600 } } }))).toEqual([]);
    expect(check(rule('average(charger.power, 30 s) < 5 W'))).toEqual(['when[0].becomes.left.over: from 1 min to 14 d']);
    expect(check(rule('average(charger.power, charger.power) < 5 W'))).toContainEqual('when[0].becomes.left.over: expected a length of time, got a number in W');
    expect(check(rule('average(charger.power, ago(charger.power, 1 min) * 1 s / 1 W) < 5 W'))).toContainEqual('when[0].becomes.left.over: a number or a setting, not one read or worked out: how long a run may take is known before it runs');
    expect(check(rule('average(charger.on, 1 h) < 5 W'))).toContainEqual('when[0].becomes.left: only a number is looked back at, not a boolean');
    expect(check(rule('average(charger.power, 1 h) < 5 %'))).toContainEqual('when[0].becomes: compares a number in W with a number in %');
  });

  test('what it reads is read: a part that cannot report it cannot fill the role', () => {
    expect(ruleUses(rule('change(charger.power, 10 min) > 100 W')).reads).toEqual([{ role: 'charger', means: 'power' }]);
  });
});

describe('as it runs, and as it is said', () => {
  const scope: RuleScope = {
    param: () => ({ value: null, unit: null }),
    read: () => null,
    reachable: () => ({ reachable: true, detail: '' }),
    name: (role) => (role === 'charger' ? 'the charger' : role),
    clock: () => null,
    history: (_role, _means, seconds) => ({ points: HOUR, from: 60 * MIN - seconds * 1000, to: 60 * MIN, unit: 'W', label: 'Power' }),
  };

  test('in the reading’s unit, compared as any reading is', () => {
    expect(measureNow(parse('average(charger.power, 1 h)'), scope)).toEqual({ value: 35, unit: 'W' });
    expect(evaluateNow(parse('average(charger.power, 1 h) > 0.03 kW'), scope)).toBe(true);
    expect(measureNow(parse('ago(charger.power, 20 min)'), scope)).toEqual({ value: 100, unit: 'W' });
    // Nothing kept: unknown — never taken for true.
    expect(evaluateNow(parse('average(charger.power, 1 h) > 30 W'), { ...scope, history: () => null })).toBeNull();
  });

  test('said as a person would', () => {
    const rule: Rule = { roles: {}, params: { fields: {} }, when: [], then: [] };
    const say = (text: string) => describeExpr(rule, parse(text), {}, (role) => (role === 'charger' ? 'the charger' : role));
    expect(say('average(charger.power, 1 h) < 5 W')).toBe('the average of the charger’s power over the last 1 h is below 5 W');
    expect(say('change(charger.power, 30 min) > 100 W')).toBe('how much the charger’s power changed over the last 30 min is above 100 W');
    expect(say('ago(charger.power, 10 min) > 0')).toBe('the charger’s power 10 min ago is above 0 W');
  });
});
