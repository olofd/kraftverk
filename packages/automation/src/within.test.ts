import { describe, expect, test } from 'bun:test';

import {
  checkRule,
  describeRule,
  describeTriggers,
  evaluateNow,
  inlineParams,
  inWindow,
  minutesOf,
  ruleUses,
  type Expr,
  type Rule,
  type RuleScope,
} from './rule.ts';

/*
  Time of day in a condition (docs/PLAN-RUN-AND-CHAIN.md, Phase 4): between
  two times on the owner's clock, across midnight when the second comes
  first — in "only if", in what starts it, and in what a step waits for.
*/

const NO_FUNCTIONS = { fn: () => null };
const night: Expr = { within: { from: { value: '22:00' }, to: { value: '06:00' } } };
const rule = (condition: Expr, extra: Partial<Rule> = {}): Rule => ({
  roles: { plug: { label: 'Plug', description: 'A plug', capabilities: ['switch'] } },
  params: { fields: {} },
  when: [{ becomes: condition }],
  then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
  ...extra,
});
const at = (clock: string | null): RuleScope => ({ param: () => null, read: () => null, reachable: () => ({ reachable: null, detail: '' }), name: (role) => role, clock: () => clock });

describe('between two times of day', () => {
  test('from it, up to but not at its end — across midnight when the end comes first', () => {
    expect([['22:00', true], ['23:59', true], ['00:00', true], ['05:59', true], ['06:00', false], ['12:00', false], ['21:59', false]].map(([clock]) => [clock, evaluateNow(night, at(clock as string))])).toEqual([
      ['22:00', true],
      ['23:59', true],
      ['00:00', true],
      ['05:59', true],
      ['06:00', false],
      ['12:00', false],
      ['21:59', false],
    ]);
    const day: Expr = { within: { from: { value: '09:00' }, to: { value: '17:00' } } };
    expect([evaluateNow(day, at('09:00')), evaluateNow(day, at('16:59')), evaluateNow(day, at('17:00')), evaluateNow(day, at('08:59'))]).toEqual([true, true, false, false]);
    expect(inWindow(minutesOf('23:00')!, minutesOf('22:00')!, minutesOf('06:00')!)).toBe(true);
  });

  test('with no clock — its settings alone — it is not known, and says the time it read when it has one', () => {
    expect(evaluateNow(night, at(null))).toBeNull();
    const trace: string[] = [];
    evaluateNow(night, at('23:15'), trace);
    expect(trace).toEqual(['It is 23:15']);
  });

  test('is checked: times of day, "HH:MM", and a window, not one time twice', () => {
    expect(checkRule(rule(night), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(rule({ within: { from: { value: '25:00' }, to: { value: '06:00' } } }), NO_FUNCTIONS)).toEqual(['when[0].becomes.within.from: a time of day is "HH:MM"']);
    expect(checkRule(rule({ within: { from: { value: 22 }, to: { value: '06:00' } } }), NO_FUNCTIONS)).toEqual(['when[0].becomes.within.from: expected a time of day, got a number']);
    expect(checkRule(rule({ within: { from: { value: '06:00' }, to: { value: '06:00' } } }), NO_FUNCTIONS)).toEqual(['when[0].becomes.within: from 06:00 to the same time is no window']);
  });

  test('reads as what it is, alone or among others', () => {
    expect(describeTriggers(rule(night), {}, (role) => role)).toEqual(['When it is between 22:00 and 06:00']);
    const onlyIf = rule(night, { when: [], if: { all: [night, { reachable: 'plug' }] } });
    expect(describeRule(onlyIf, {}, () => 'Scooter plug')).toBe('If it is between 22:00 and 06:00 and Scooter plug can be reached, turn Scooter plug on.');
  });

  test('a recipe’s window, from its settings, is written into the copy', () => {
    const recipe = rule({ within: { from: { param: 'from' }, to: { param: 'to' } } }, {
      params: { fields: { from: { type: 'string', title: 'From', default: '23:00' }, to: { type: 'string', title: 'Until', default: '05:00' } } },
    });
    const copy = inlineParams(recipe, {});
    expect(copy.when).toEqual([{ becomes: { within: { from: { value: '23:00' }, to: { value: '05:00' } } } }]);
    expect(ruleUses(copy).windows).toEqual([{ from: { value: '23:00' }, to: { value: '05:00' } }]);
  });
});
