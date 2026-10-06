import { describe, expect, test } from 'bun:test';

import type { Expr } from '../rule.ts';

import { parseExpr, printExpr } from './expr.ts';

/*
  A condition as a configuration file writes it: read into the expression the
  engine runs, and written back the same — with where a text goes wrong.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${parsed.error.message} at ${parsed.error.offset}`);
  return parsed.expr;
};

const read = (role: string, means: string): Expr => ({ read: { role, means } });

describe('reading a condition', () => {
  test('a reading against a number with its unit, and the unit kept beside it', () => {
    const parsed = parseExpr('charger.power > 50 W');
    expect(parsed.ok && parsed.expr).toEqual({ compare: 'gt', left: read('charger', 'power'), right: { value: 50 } });
    if (parsed.ok && 'compare' in parsed.expr) expect(parsed.units.get(parsed.expr.right)?.unit).toBe('W');
  });

  test('"and" binds before "or", "not" before both; parentheses where they are written', () => {
    expect(parse('a.x < 1 and b.y > 2 or not c reachable')).toEqual({
      any: [{ all: [{ compare: 'lt', left: read('a', 'x'), right: { value: 1 } }, { compare: 'gt', left: read('b', 'y'), right: { value: 2 } }] }, { not: { reachable: 'c' } }],
    });
    expect(parse('not (a reachable and b reachable)')).toEqual({ not: { all: [{ reachable: 'a' }, { reachable: 'b' }] } });
  });

  test('time of day, a window across midnight, sums, the lower of two, a setting, a function', () => {
    expect(parse('time between 23:00 and 05:00')).toEqual({ within: { from: { value: '23:00' }, to: { value: '05:00' } } });
    expect(parse('station.chargeLimit - 5 %')).toEqual({ math: 'subtract', left: read('station', 'chargeLimit'), right: { value: 5 } });
    expect(parse('min(forecast.hours, 4) >= $hours')).toEqual({ compare: 'ge', left: { math: 'min', left: read('forecast', 'hours'), right: { value: 4 } }, right: { param: 'hours' } });
    expect(parse('call open-meteo.weather.skyLooks(forecast, cloudMax = 40) == "sunny"')).toEqual({
      compare: 'eq',
      left: { call: 'open-meteo.weather.skyLooks', role: 'forecast', args: { cloudMax: { value: 40 } } },
      right: { value: 'sunny' },
    });
  });

  test('"30 min" is minutes; "min(" the lower of two', () => {
    const parsed = parseExpr('station.time.toFull < 30 min');
    expect(parsed.ok && parsed.expr).toEqual({ compare: 'lt', left: read('station', 'time.toFull'), right: { value: 30 } });
  });

  test('what is wrong, and where', () => {
    const wrong = (text: string) => {
      const parsed = parseExpr(text);
      if (parsed.ok) throw new Error('read');
      return parsed.error;
    };
    expect(wrong('charger.power >')).toEqual({ message: 'It ends where a value was expected', offset: 15 });
    expect(wrong('charger > 50')).toMatchObject({ offset: 8 });
    expect(wrong('a.x < 1 < 2').message).toBe('One comparison at a time: join two with "and"');
    expect(wrong('25:00 == a.b').message).toBe('25:00 is not a time of day');
    expect(wrong('"open').message).toContain('not closed');
  });
});

describe('writing it back', () => {
  const cases: Expr[] = [
    { compare: 'gt', left: read('charger', 'power'), right: { value: 50 } },
    { any: [{ all: [{ reachable: 'a' }, { not: { reachable: 'b' } }] }, { compare: 'eq', left: read('c', 'mode'), right: { value: 'charging' } }] },
    { all: [{ any: [{ reachable: 'a' }, { reachable: 'b' }] }, { reachable: 'c' }] },
    { all: [{ all: [{ reachable: 'a' }, { reachable: 'b' }] }, { reachable: 'c' }] },
    { not: { compare: 'lt', left: read('a', 'b'), right: { value: -3 } } },
    { math: 'subtract', left: read('a', 'b'), right: { math: 'subtract', left: { value: 1 }, right: { value: 2 } } },
    { math: 'add', left: { math: 'add', left: read('a', 'b'), right: { value: 1 } }, right: { value: 2 } },
    { math: 'max', left: read('a', 'b'), right: { compare: 'gt', left: read('c', 'd'), right: { value: 0 } } },
    { within: { from: { value: '22:00' }, to: { param: 'until' } } },
    { call: 'test.weather.sky', role: 'forecast' },
    { compare: 'eq', left: read('plug', 'on'), right: { value: true } },
    { compare: 'ne', left: { value: null }, right: { value: 'a "quoted" word' } },
  ];
  for (const expr of cases) {
    test(`as it was: ${JSON.stringify(expr).slice(0, 70)}`, () => {
      const text = printExpr(expr);
      expect(text).not.toBeNull();
      expect(parse(text!)).toEqual(expr);
    });
  }

  test('a very small or very large number is written in plain digits, and read back as itself', () => {
    for (const value of [1e-7, 1.5e-7, 1e21, 2.5e22, -3e-9, 0.1, 123.456]) {
      const text = printExpr({ compare: 'gt', left: read('meter', 'power'), right: { value } })!;
      expect(text).not.toMatch(/\de/);
      expect(parse(text)).toEqual({ compare: 'gt', left: read('meter', 'power'), right: { value } });
    }
  });

  test('a number beside a reading says the reading’s unit', () => {
    const unitOf = (_role: string, means: string) => (means === 'power' ? 'W' : means === 'charge' ? '%' : null);
    expect(printExpr({ compare: 'gt', left: read('charger', 'power'), right: { value: 50 } }, { unitOf })).toBe('charger.power > 50 W');
    expect(printExpr({ compare: 'lt', left: read('station', 'charge'), right: { value: 15 } }, { unitOf })).toBe('station.charge < 15 %');
  });

  test('what text cannot say is not said: a list for a value, one condition alone in an "all"', () => {
    expect(printExpr({ value: [1, 2] })).toBeNull();
    expect(printExpr({ all: [{ reachable: 'a' }] })).toBeNull();
    expect(printExpr({ reachable: 'not' })).toBeNull();
  });
});
