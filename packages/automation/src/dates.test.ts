import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { dateSpanOf, datesText, monthsText, onDates, runsOn } from './clock.ts';
import { describeTriggers } from './describe.ts';
import type { Rule, Trigger } from './rule.ts';
import { ruleFromConfig, ruleToConfig } from './text/rules.ts';

/*
  A time of day narrowed to months and dates of the year
  (docs/PLAN-VARIABLES-AND-TRIGGERS.md §3.3): "at 06:30 in Dec, Jan and
  Feb", "at sunset from 1 Dec to 24 Dec" — a span across the year's end
  when it ends before it begins.
*/

const rule = (when: Trigger[]): Rule => ({ roles: {}, params: { fields: {} }, when, then: [{ setMode: { mode: 'home' } }] });
const NO_FUNCTIONS = { fn: () => null };

describe('months and dates', () => {
  test('a date of the year, or a span of them — and a day some month never has is none', () => {
    expect(dateSpanOf('12-24')).toEqual({ from: 1224, to: 1224 });
    expect(dateSpanOf('12-20..01-06')).toEqual({ from: 1220, to: 106 });
    expect(dateSpanOf('02-29')).toEqual({ from: 229, to: 229 });
    for (const wrong of ['02-30', '13-01', '1-5', '12-24..', 'christmas', 24]) expect(dateSpanOf(wrong)).toBeNull();
  });

  test('within a span, across the year’s end too', () => {
    expect(onDates(['12-20..01-06'], { month: 12, day: 31 })).toBe(true);
    expect(onDates(['12-20..01-06'], { month: 1, day: 6 })).toBe(true);
    expect(onDates(['12-20..01-06'], { month: 1, day: 7 })).toBe(false);
    expect(onDates(['03-01', '12-24'], { month: 12, day: 24 })).toBe(true);
  });

  test('a time runs on its days, in its months, on its dates — all of them', () => {
    const winterWeekdays: Extract<Trigger, { at: unknown }> = { at: { value: '06:30' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'], months: ['dec', 'jan', 'feb'] };
    // Monday 5 January 2026, Monday 6 July 2026, Saturday 3 January 2026.
    expect(runsOn(winterWeekdays, { year: 2026, month: 1, day: 5 })).toBe(true);
    expect(runsOn(winterWeekdays, { year: 2026, month: 7, day: 6 })).toBe(false);
    expect(runsOn(winterWeekdays, { year: 2026, month: 1, day: 3 })).toBe(false);
    expect(runsOn({ at: { value: 'sunset' }, dates: ['12-01..12-24'] }, { year: 2026, month: 12, day: 10 })).toBe(true);
  });

  test('said as a person says them', () => {
    expect(monthsText(['feb', 'dec', 'jan'])).toBe('in Jan, Feb and Dec');
    expect(datesText(['12-01..12-24', '12-31'])).toBe('from 1 Dec to 24 Dec or on 31 Dec');
    expect(describeTriggers(rule([{ at: { value: '06:30' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'], months: ['dec', 'jan', 'feb'] }]), {}, () => '')).toEqual(['At 06:30 on weekdays in Jan, Feb and Dec']);
    expect(describeTriggers(rule([{ at: { value: '17:00' }, dates: ['12-01..12-24'] }]), {}, () => '')).toEqual(['At 17:00 from 1 Dec to 24 Dec']);
  });

  test('in a file, and back — and checked', () => {
    const read = ruleFromConfig({ when: [{ at: '06:30', months: ['dec', 'jan'], dates: '12-01..12-24' }], do: [{ 'set mode': 'home' }] }, ['a']);
    expect(read.issues).toEqual([]);
    expect(read.rule!.when[0]).toEqual({ at: { value: '06:30' }, months: ['dec', 'jan'], dates: ['12-01..12-24'] });
    expect(ruleToConfig(read.rule!, {}).when).toEqual([{ at: '06:30', months: ['dec', 'jan'], dates: ['12-01..12-24'] }]);
    expect(ruleFromConfig({ when: [{ at: '06:30', months: ['winter'] }], do: [] }, ['a']).issues[0]!.message).toBe('"winter" is not a month: jan, feb … dec');
    expect(ruleFromConfig({ when: [{ at: '06:30', dates: ['02-30'] }], do: [] }, ['a']).issues[0]!.message).toBe('"02-30" is not a date of the year: "12-24", or "12-01..12-24"');
    expect(checkRule(rule([{ at: { value: '06:30' }, months: [] }]), NO_FUNCTIONS)).toEqual(['when[0].months: in no month, it never runs']);
    expect(checkRule(rule([{ at: { value: '06:30' }, months: ['jan', 'jan'] }]), NO_FUNCTIONS)).toEqual(['when[0].months: a month is named twice']);
  });
});
