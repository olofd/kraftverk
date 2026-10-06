import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { describeSteps } from './describe.ts';
import { evaluateNow, inlineParams, type RuleScope } from './evaluate.ts';
import { calculate, type Expr, type Rule } from './rule.ts';

/*
  Arithmetic in a rule (docs/PLAN-RUN-AND-CHAIN.md, Phase 4): the sum or
  difference of two numbers, or the lower or higher of them — in one unit,
  checked as a comparison is.
*/

const NO_FUNCTIONS = { fn: () => null };

const soc: Expr = { read: { role: 'battery', means: 'charge' } };

const draw: Expr = { read: { role: 'plug', means: 'power' } };

const rule = (on: Expr, extra: Partial<Rule> = {}): Rule => ({
  roles: {
    battery: { label: 'Battery', capabilities: ['battery'] },
    plug: { label: 'Plug', capabilities: ['switch', 'powerMeter'] },
  },
  params: { fields: {} },
  when: [],
  then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on } } }],
  ...extra,
});

const scope = (charge: number | null): RuleScope => ({
  param: () => ({ value: null, unit: null }),
  read: (_role, means) => (means === 'charge' && charge !== null ? { value: charge, label: 'Charge', unit: '%' } : null),
  reachable: () => ({ reachable: true, detail: '' }),
  name: (role) => (role === 'battery' ? 'Garage station' : 'Scooter plug'),
  clock: () => null,
});

describe('arithmetic', () => {
  test('adds, subtracts, multiplies and divides — unknown when either side is, and by nothing', () => {
    expect([calculate('add', 40, 10), calculate('subtract', 40, 10), calculate('multiply', 40, 10), calculate('divide', 40, 10)]).toEqual([50, 30, 400, 4]);
    expect(calculate('add', 40, null)).toBeNull();
    expect(calculate('divide', 40, 0)).toBeNull();
    expect(evaluateNow({ compare: 'lt', left: soc, right: { apply: 'min', args: [{ value: 80 }, { math: 'add', left: { value: 20 }, right: { value: 10 } }] } }, scope(25))).toBe(true);
    expect(evaluateNow({ math: 'add', left: soc, right: { value: 10 } }, scope(null))).toBeNull();
  });

  test('is checked: numbers, in one unit — a plain number takes the other side’s', () => {
    const below = (right: Expr) => rule({ compare: 'lt', left: soc, right });
    expect(checkRule(below({ math: 'subtract', left: { value: 90 }, right: { value: 5 } }), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(below({ math: 'add', left: soc, right: draw }), NO_FUNCTIONS)).toEqual(['then[0].command.args.on.right: % and W are not of one quantity']);
    expect(checkRule(below({ math: 'add', left: soc, right: { value: true } }), NO_FUNCTIONS)).toEqual(['then[0].command.args.on.right.right: expected a number, got a boolean']);
    // The sum is in its unit, and compared as that.
    expect(checkRule(rule({ compare: 'lt', left: draw, right: { math: 'add', left: soc, right: { value: 5 } } }), NO_FUNCTIONS)).toEqual(['then[0].command.args.on: compares a number in W with a number in %']);
    expect(checkRule(below({ math: 'times' as never, left: { value: 1 }, right: { value: 2 } }), NO_FUNCTIONS)).toEqual(['then[0].command.args.on.right: "times" is not +, -, * or /']);
  });

  test('reads as words, a plain number in the reading’s unit', () => {
    const lines = (on: Expr) => describeSteps(rule(on), {}, (role) => (role === 'battery' ? 'Garage station' : 'Scooter plug')).steps.map((line) => line.text);
    expect(lines({ compare: 'lt', left: soc, right: { apply: 'min', args: [{ value: 80 }, { math: 'add', left: soc, right: { value: 10 } }] } })).toEqual([
      'Turn Scooter plug on if Garage station’s charge is below the lowest of 80 % and Garage station’s charge plus 10 %, off if not',
    ]);
  });

  test('from a recipe’s settings alone, the number is written into the copy', () => {
    const recipe = rule(
      { compare: 'lt', left: soc, right: { math: 'subtract', left: { param: 'high' }, right: { param: 'margin' } } },
      { params: { fields: { high: { type: 'number', title: 'High', unit: '%', default: 80 }, margin: { type: 'number', title: 'Margin', unit: '%', default: 5 } } } }
    );
    const copy = inlineParams(recipe, {});
    expect(copy.then).toEqual([{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { compare: 'lt', left: soc, right: { value: 75, unit: '%' } } } } }]);
  });
});
