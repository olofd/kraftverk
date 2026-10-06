import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { describeTriggers } from './describe.ts';
import { evaluateNow, measureNow, type RuleScope } from './evaluate.ts';
import type { Expr, Rule } from './rule.ts';
import { sunTimes } from './sun.ts';
import { parseExpr, printExpr } from './text/expr.ts';
import { ruleFromConfig } from './text/rules.ts';

/*
  The sun: when it rises and sets where a place is — to a minute or so, and
  not at all on a day it stays up or down — and the times of day a rule
  writes with it: `sunset`, `30 min before sunset`, `time between sunset
  and sunrise`, `at: sunset`.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

/** Greenwich, and a place far north: made-up homes. */
const GREENWICH = { latitude: 51.4779, longitude: 0 };
const FAR_NORTH = { latitude: 78.2, longitude: 15.6 };
const utc = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(11, 16));
const near = (got: number | null, hour: number, minute: number) => {
  expect(got).not.toBeNull();
  const at = new Date(got!);
  expect(Math.abs(at.getUTCHours() * 60 + at.getUTCMinutes() - (hour * 60 + minute))).toBeLessThanOrEqual(3);
};

describe('when the sun rises and sets', () => {
  test('at Greenwich: early in summer, late in winter, near six at the equinox', () => {
    const june = sunTimes({ year: 2026, month: 6, day: 21 }, GREENWICH);
    near(june.sunrise, 3, 43);
    near(june.sunset, 20, 21);
    const december = sunTimes({ year: 2026, month: 12, day: 21 }, GREENWICH);
    near(december.sunrise, 8, 4);
    near(december.sunset, 15, 53);
    const march = sunTimes({ year: 2026, month: 3, day: 20 }, GREENWICH);
    near(march.sunrise, 6, 3);
    near(march.sunset, 18, 13);
  });

  test('far north: not at all in midsummer or midwinter', () => {
    expect(sunTimes({ year: 2026, month: 6, day: 21 }, FAR_NORTH)).toEqual({ sunrise: null, sunset: null });
    expect(sunTimes({ year: 2026, month: 12, day: 21 }, FAR_NORTH)).toEqual({ sunrise: null, sunset: null });
    expect(utc(sunTimes({ year: 2026, month: 3, day: 20 }, FAR_NORTH).sunrise)).not.toBeNull();
  });
});

describe('a time of day by the sun', () => {
  test('read and written back as it was', () => {
    expect(parse('30 min before sunset')).toEqual({ sun: 'sunset', offset: { by: { value: 30, unit: 'min' }, before: true } });
    for (const text of ['sunrise', 'sunset', '30 min before sunset', '1 h after sunrise', 'setting.lead before sunset', 'time between sunset and sunrise', 'time between 1 h after sunrise and 30 min before sunset']) expect(printExpr(parse(text))).toBe(text);
    expect(parseExpr('30 min before lunch').ok).toBe(false);
  });

  test('held to a time of day, and so long before or after it as a number or a setting', () => {
    const rule = (at: string): Rule => ({ roles: { lamp: { label: 'Lamp', capabilities: ['switch'] } }, params: { fields: {} }, when: [{ at: parse(at) }], then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }] });
    expect(checkRule(rule('sunset'), { fn: () => null })).toEqual([]);
    expect(checkRule(rule('30 min before sunset'), { fn: () => null })).toEqual([]);
    expect(checkRule(rule('13 h before sunset'), { fn: () => null })).toEqual(['when[0].at.offset.by: from 1 min to 12 h']);
    const read = ruleFromConfig({ uses: { lamp: 'hall-lamp' }, when: [{ at: '30 min before sunset' }], do: [{ 'turn on': 'lamp' }] }, []);
    expect(read.issues).toEqual([]);
    expect(describeTriggers(read.rule!, {}, () => 'Hall lamp')).toEqual(['Every day at 30 min before sunset']);
  });

  test('as it runs: today’s, moved as it says, on the automation’s clock — unknown without a place', () => {
    const asked: [string, number][] = [];
    const scope: RuleScope = {
      param: () => ({ value: null, unit: null }),
      read: () => null,
      reachable: () => ({ reachable: true, detail: '' }),
      name: (role) => role,
      clock: () => '21:30',
      // Sunset at 21:10 today; each minute it is moved, the time moves with it.
      sun: (event, offset) => (asked.push([event, offset]), event === 'sunset' ? `${String(21 + Math.floor((10 + offset / 60) / 60)).padStart(2, '0')}:${String((((10 + offset / 60) % 60) + 60) % 60).padStart(2, '0')}` : '04:00'),
    };
    expect(measureNow(parse('30 min before sunset'), scope).value).toBe('20:40');
    expect(asked).toEqual([['sunset', -1800]]);
    expect(evaluateNow(parse('time between sunset and sunrise'), scope)).toBe(true);
    expect(evaluateNow(parse('time between sunset and sunrise'), { ...scope, sun: () => null })).toBeNull();
  });
});
