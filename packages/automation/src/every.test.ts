import { describe, expect, test } from 'bun:test';

import { checkRule, describeRule, describeTriggers, inlineParams, slotOf, type Rule, type Trigger } from './rule.ts';

/*
  Every so many minutes (docs/PLAN-RUN-AND-CHAIN.md, Phase 4): on the
  owner's clock from midnight, once a slot.
*/

const NO_FUNCTIONS = { fn: () => null };
const rule = (when: Trigger[], extra: Partial<Rule> = {}): Rule => ({
  roles: { plug: { label: 'Plug', description: 'A plug', capabilities: ['switch'] } },
  params: { fields: {} },
  when,
  then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
  ...extra,
});

describe('every so many minutes', () => {
  test('its slots are on the clock from midnight', () => {
    expect([slotOf(7 * 60 + 40, 15), slotOf(7 * 60 + 45, 15), slotOf(0, 15), slotOf(23 * 60 + 59, 60)]).toEqual([450, 465, 0, 1380]);
  });

  test('is checked: whole minutes, from 5 to 720', () => {
    expect(checkRule(rule([{ every: { value: 15 } }]), NO_FUNCTIONS)).toEqual([]);
    for (const minutes of [1, 721, 7.5]) expect(checkRule(rule([{ every: { value: minutes } }]), NO_FUNCTIONS)).toEqual(['when[0].every: whole minutes, from 5 to 720']);
    expect(checkRule(rule([{ every: { value: '15' } }]), NO_FUNCTIONS)).toEqual(['when[0].every: expected a number of minutes, got a string']);
  });

  test('reads as how often, and narrowed by a window of the day', () => {
    const night = rule([{ every: { value: 15 } }], { if: { within: { from: { value: '22:00' }, to: { value: '06:00' } } } });
    expect(describeTriggers(night, {}, () => 'Scooter plug')).toEqual(['Every 15 min']);
    expect(describeRule(night, {}, () => 'Scooter plug')).toBe('Every 15 min, if it is between 22:00 and 06:00, turn Scooter plug on.');
  });

  test('a recipe’s interval, from its settings, is written into the copy', () => {
    const recipe = rule([{ every: { param: 'minutes' } }], { params: { fields: { minutes: { type: 'number', title: 'Every', unit: 'min', default: 30 } } } });
    expect(inlineParams(recipe, {}).when).toEqual([{ every: { value: 30 } }]);
  });
});
