import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { slotOf } from './clock.ts';
import { describeRule, describeTriggers } from './describe.ts';
import { inlineParams } from './evaluate.ts';
import type { Rule, Trigger } from './rule.ts';

/*
  Every so many minutes (docs/PLAN-RUN-AND-CHAIN.md, Phase 4): on the
  owner's clock from midnight, once a slot.
*/

const NO_FUNCTIONS = { fn: () => null };

const rule = (when: Trigger[], extra: Partial<Rule> = {}): Rule => ({
  roles: { plug: { label: 'Plug', capabilities: ['switch'] } },
  params: { fields: {} },
  when,
  then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
  ...extra,
});

describe('every so many minutes', () => {
  test('its slots are on the clock from midnight', () => {
    expect([slotOf(7 * 60 + 40, 15), slotOf(7 * 60 + 45, 15), slotOf(0, 15), slotOf(23 * 60 + 59, 60)]).toEqual([450, 465, 0, 1380]);
  });

  test('is checked: whole minutes, from 5 min to 12 h — kept in seconds', () => {
    expect(checkRule(rule([{ every: { value: 15 * 60 } }]), NO_FUNCTIONS)).toEqual([]);
    for (const seconds of [60, 12 * 3600 + 60, 450]) expect(checkRule(rule([{ every: { value: seconds } }]), NO_FUNCTIONS)).toEqual(['when[0].every: from 5 min to 12 h, in steps of 1 min']);
    expect(checkRule(rule([{ every: { value: '15' } }]), NO_FUNCTIONS)).toEqual(['when[0].every: expected a length of time, got a string']);
  });

  test('a condition held for: more than nothing, at most a week — a longer timer would not wait at all', () => {
    const held = (seconds: number) => rule([{ becomes: { reachable: 'plug' }, heldFor: { value: seconds } }]);
    expect(checkRule(held(10 * 60), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(held(30), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(held(7 * 24 * 3600), NO_FUNCTIONS)).toEqual([]);
    for (const seconds of [0, -5, 7 * 24 * 3600 + 1]) expect(checkRule(held(seconds), NO_FUNCTIONS)).toEqual(['when[0].heldFor: from 1 s to 168 h']);
  });

  test('reads as how often, and narrowed by a window of the day', () => {
    const night = rule([{ every: { value: 15 * 60 } }], { if: { within: { from: { value: '22:00' }, to: { value: '06:00' } } } });
    expect(describeTriggers(night, {}, () => 'Scooter plug')).toEqual(['Every 15 min']);
    expect(describeRule(night, {}, () => 'Scooter plug')).toBe('Every 15 min, if it is between 22:00 and 06:00, turn Scooter plug on.');
  });

  test('a hold reads as a person says it, in seconds, minutes or hours', () => {
    const held = (seconds: number) => describeTriggers(rule([{ becomes: { reachable: 'plug' }, heldFor: { value: seconds } }]), {}, () => 'Plug')[0];
    expect([held(30), held(120), held(90 * 60)]).toEqual(['When Plug can be reached for 30 s', 'When Plug can be reached for 2 min', 'When Plug can be reached for 1 h 30 min']);
  });

  test('a recipe’s interval, from its settings, is written into the copy', () => {
    const recipe = rule([{ every: { param: 'every' } }], { params: { fields: { every: { type: 'number', title: 'Every', unit: 's', default: 1800 } } } });
    expect(inlineParams(recipe, {}).when).toEqual([{ every: { value: 1800 } }]);
  });
});
