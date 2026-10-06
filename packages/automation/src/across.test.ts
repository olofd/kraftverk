import { describe, expect, test } from 'bun:test';

import type { Unit, Value } from '@kraftverk/device-sdk';

import { checkBinding, checkRule } from './check.ts';
import { describeExpr } from './describe.ts';
import { evaluateNow, measureNow, type RuleScope } from './evaluate.ts';
import { ruleUses } from './reads.ts';
import type { Expr, Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';

/*
  Something of each part of a group, taken together: read from its text and
  written back — told apart from looking back, which shares some names — held
  to a condition or a number of each part, evaluated three ways with each
  part's own unit, said in words, and read as the group by what binds and
  re-evaluates.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

const roles: Rule['roles'] = { chargers: { group: true, label: 'Chargers', capabilities: ['switch', 'powerMeter'] }, lamp: { label: 'Lamp', capabilities: ['switch'] } };
const rule = (condition: string): Rule => ({ roles, params: { fields: {} }, when: [{ becomes: parse(condition) }], then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }] });
const check = (checked: Rule) => checkRule(checked, { fn: () => null });

describe('as a file writes it', () => {
  test('read and written back as it was; looking back, with the same name, is still looking back', () => {
    expect(parse('any(c in chargers: c.power > 10 W)')).toEqual({ across: 'any', as: 'c', group: 'chargers', of: { compare: 'gt', left: { read: { role: 'c', means: 'power' } }, right: { value: 10, unit: 'W' } } });
    for (const text of ['all(c in chargers: c.power < 5 W)', 'count(c in chargers: c reachable) >= 2', 'sum(c in chargers: c.power ?? 0 W) > 2 kW', 'highest(c in chargers: c.power)']) expect(printExpr(parse(text))).toBe(text);
    expect(parse('highest(charger.power, 10 min)')).toMatchObject({ history: 'highest' });
    expect(parseExpr('any(c in chargers c.power > 10 W)')).toMatchObject({ ok: false, error: { message: expect.stringContaining('":" and what is said of each') } });
  });
});

describe('held to what it is, before it runs', () => {
  test('a condition of each part for all, any and count; a number for the rest — in its unit', () => {
    expect(check(rule('any(c in chargers: c.power > 10 W)'))).toEqual([]);
    expect(check(rule('count(c in chargers: c.power > 10 W) >= 2'))).toEqual([]);
    expect(check(rule('sum(c in chargers: c.power) > 2 kW'))).toEqual([]);
    expect(check(rule('any(c in chargers: c.power)'))).toEqual(['when[0].becomes.of: any asks whether something holds of each part, not a number in W']);
    expect(check(rule('sum(c in chargers: c.power) > 20 %'))).toEqual(['when[0].becomes: compares a number in W with a number in %']);
  });

  test('of a group, by a name of its own that names nothing else; its name only within it', () => {
    expect(check(rule('any(c in lamp: c.power > 10 W)'))).toContainEqual('when[0].becomes: lamp is one part, not several');
    expect(check(rule('any(lamp in chargers: lamp.power > 10 W)'))).toContainEqual('when[0].becomes: "lamp" names something already, or nothing — call each part otherwise');
    expect(check(rule('any(c in chargers: c.power > 10 W) and c.power > 5 W'))).toContainEqual('when[0].becomes.all[1].left: there is no role "c"');
    expect(check(rule('chargers.power > 10 W'))).toContainEqual('when[0].becomes.left: chargers is several parts — name each in turn with "for each"');
  });

  test('what is read of each part is read of the group: each part bound is held to it', () => {
    expect(ruleUses(rule('any(c in chargers: c.power > 10 W)')).reads).toEqual([{ role: 'chargers', means: 'power' }]);
    const part = (name: string, attributes: { key: string; means: string }[]) =>
      ({ name, part: 'main', capabilities: ['switch', 'powerMeter'], description: { parts: [{ id: 'main', label: name, kind: 'outlet', offers: ['switch', 'powerMeter'] }], attributes: attributes.map((each) => ({ ...each, label: each.key, value: { type: 'number', unit: 'W' } })) } }) as never;
    const lamp = { name: 'Lamp', part: 'main', capabilities: ['switch'], description: { parts: [{ id: 'main', label: 'Lamp', kind: 'outlet', offers: ['switch'] }], attributes: [] } } as never;
    const bound = (role: string) => (role === 'lamp' ? [lamp] : [part('Garage plug', [{ key: 'watts', means: 'power' }]), part('Old plug', [])]);
    expect(checkBinding(rule('any(c in chargers: c.power > 10 W)'), bound)).toEqual(['Chargers: Old plug does not report power']);
  });
});

describe('as it runs, and as it is said', () => {
  /** Each charger's power — the second in kW — or, the third, not known. */
  const powers: { value: Value; unit: Unit | null }[] = [
    { value: 300, unit: 'W' },
    { value: 1.2, unit: 'kW' },
    { value: null, unit: null },
  ];
  const scope = (known: number): RuleScope => {
    const base: RuleScope = { param: () => ({ value: null, unit: null }), read: () => null, reachable: () => ({ reachable: true, detail: '' }), name: (role) => role, clock: () => null };
    return {
      ...base,
      members: () =>
        powers.slice(0, known).map((power) => ({ ...base, read: (_role: string, means: string) => (means === 'power' && power.value !== null ? { value: power.value as number, label: 'Power', unit: power.unit } : null) })),
    };
  };

  test('numbers in the first one’s unit, each converted; unknown while one is — unless ?? says otherwise', () => {
    expect(measureNow(parse('sum(c in chargers: c.power)'), scope(2))).toEqual({ value: 1500, unit: 'W' });
    expect(measureNow(parse('highest(c in chargers: c.power)'), scope(2))).toEqual({ value: 1200, unit: 'W' });
    expect(measureNow(parse('sum(c in chargers: c.power)'), scope(3)).value).toBeNull();
    expect(measureNow(parse('sum(c in chargers: c.power ?? 0 W)'), scope(3))).toEqual({ value: 1500, unit: 'W' });
    expect(measureNow(parse('count(c in chargers: c.power > 500 W)'), scope(2))).toEqual({ value: 1, unit: null });
  });

  test('all and any: one part settles it, or one that cannot tell leaves it unknown', () => {
    expect(evaluateNow(parse('any(c in chargers: c.power > 1 kW)'), scope(3))).toBe(true);
    expect(evaluateNow(parse('all(c in chargers: c.power > 1 kW)'), scope(3))).toBe(false);
    expect(evaluateNow(parse('all(c in chargers: c.power > 100 W)'), scope(3))).toBeNull();
    expect(evaluateNow(parse('any(c in chargers: c.power > 2 kW)'), scope(3))).toBeNull();
    expect(evaluateNow(parse('all(c in chargers: c.power > 100 W)'), scope(2))).toBe(true);
    // Its parts not known — no devices to ask: unknown, never taken for true.
    expect(evaluateNow(parse('all(c in chargers: c.power > 100 W)'), { ...scope(2), members: () => null })).toBeNull();
  });

  test('said of the group by its parts, and of each as its name says', () => {
    const say = (text: string) => describeExpr(rule('true'), parse(text), {}, (role) => (role === 'chargers' ? 'Garage plug and Scooter plug' : role));
    expect(say('any(c in chargers: c.power > 10 W)')).toBe('for any of Garage plug and Scooter plug, each c’s power is above 10 W');
    expect(say('sum(charger in chargers: charger.power) > 2 kW')).toBe('the sum of each charger’s power, across Garage plug and Scooter plug is above 2 kW');
  });
});
