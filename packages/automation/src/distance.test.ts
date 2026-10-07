import { describe, expect, test } from 'bun:test';

import { distanceBetween } from '@kraftverk/device-sdk';

import { checkRule } from './check.ts';
import { describeExpr } from './describe.ts';
import { evaluateNow, measureNow, type RuleScope } from './evaluate.ts';
import { ruleUses } from './reads.ts';
import type { Expr, Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';

/*
  How far: the position a part reports, measured from the home — or from
  another part's — over the Earth's surface, in metres. Made-up places.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

/** A home, and a phone a kilometre or so north-east of it. */
const HOME = { latitude: 59.3293, longitude: 18.0686 };
const PHONE = { latitude: 59.3365, longitude: 18.0800, accuracy: 20 };
const CAR = { latitude: 59.3293, longitude: 18.0700 };

const rule = (becomes: string, roles: Rule['roles'] = { phone: { label: 'Phone', capabilities: ['location'] }, lamp: { label: 'Lamp', capabilities: ['switch'] } }): Rule => ({
  roles,
  params: { fields: {} },
  when: [{ becomes: parse(becomes) }],
  then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
});

describe('the distance between two places', () => {
  test('over the Earth’s surface: nothing to itself, about 111 km a degree of latitude', () => {
    expect(distanceBetween(HOME, HOME)).toBe(0);
    expect(Math.round(distanceBetween({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }) / 100) / 10).toBe(111.2);
    expect(Math.round(distanceBetween(HOME, PHONE))).toBe(Math.round(distanceBetween(PHONE, HOME)));
  });
});

describe('distance in a rule', () => {
  test('read and written back as it was', () => {
    expect(parse('distance(phone.position) < 500 m')).toEqual({ compare: 'lt', left: { distance: { role: 'phone', means: 'position' } }, right: { value: 500, unit: 'm' } });
    for (const text of ['distance(phone.position) < 500 m', 'distance(phone.position, car.position) > 2 km']) expect(printExpr(parse(text))).toBe(text);
    expect(parseExpr('distance(1 km)').ok).toBe(false);
  });

  test('a length, compared in any; of a position a role asks for', () => {
    expect(checkRule(rule('distance(phone.position) < 500 m'), { fn: () => null })).toEqual([]);
    expect(checkRule(rule('distance(phone.position) > 2 km'), { fn: () => null })).toEqual([]);
    expect(checkRule(rule('distance(phone.position) > 20 %'), { fn: () => null }).join()).toContain('%');
    expect(checkRule(rule('distance(phone.charge) < 5 m'), { fn: () => null })).toEqual(['when[0].becomes.left.distance: charge is not a position']);
    expect(checkRule(rule('distance(lamp.position) < 5 m'), { fn: () => null })).toEqual(['when[0].becomes.left.distance: lamp asks for nothing that reports position']);
  });

  test('in words, and what it reads', () => {
    expect(describeExpr(rule('distance(phone.position) < 500 m'), parse('distance(phone.position) < 500 m'), {}, (role) => (role === 'phone' ? 'Olof’s phone' : role))).toBe('how far Olof’s phone is from home is below 500 m');
    expect(describeExpr(rule('distance(phone.position) < 500 m'), parse('distance(phone.position, car.position)'), {}, (role) => role)).toBe('how far phone is from car');
    expect(ruleUses(rule('distance(phone.position, car.position) < 50 m')).reads).toEqual([
      { role: 'phone', means: 'position' },
      { role: 'car', means: 'position' },
    ]);
  });

  test('as it runs: in metres from the home, or from another part — unknown without either', () => {
    const where: Record<string, typeof PHONE | typeof CAR> = { phone: PHONE, car: CAR };
    const trace: string[] = [];
    const scope: RuleScope = {
      param: () => ({ value: null, unit: null }),
      read: () => null,
      reachable: () => ({ reachable: true, detail: '' }),
      name: (role) => (role === 'phone' ? 'Olof’s phone' : role),
      clock: () => '12:00',
      position: (role) => (where[role] ? { position: where[role]!, label: 'Position' } : null),
      home: () => HOME,
    };
    const away = measureNow(parse('distance(phone.position)'), scope, trace);
    expect(away).toEqual({ value: Math.round(distanceBetween(PHONE, HOME)), unit: 'm' });
    expect(trace).toEqual(['Olof’s phone: 1.0 km from home']);
    expect(evaluateNow(parse('distance(phone.position) > 1 km'), scope)).toBe(true);
    expect(evaluateNow(parse('distance(phone.position) < 500 m'), scope)).toBe(false);
    expect(measureNow(parse('distance(phone.position, car.position)'), scope).value).toBe(Math.round(distanceBetween(PHONE, CAR)));
    // The home has not said where it is; or the phone has not.
    expect(evaluateNow(parse('distance(phone.position) < 500 m'), { ...scope, home: () => null })).toBeNull();
    expect(evaluateNow(parse('distance(phone.position) < 500 m'), { ...scope, position: () => null })).toBeNull();
  });
});
