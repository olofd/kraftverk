import { describe, expect, test } from 'bun:test';

import { checkRule, inlineParams, isAutomationRole, STANDARD_RECIPES, type CapabilityName, type Recipe, type Rule, type Value } from '@kraftverk/device-sdk';

import { durationSeconds, durationText, ruleFromConfig, ruleToConfig, type Use } from './rules.ts';

/*
  An automation's rule as its configuration writes it, and back: every
  standard recipe, copied as the app copies one, comes back as it went; and
  the owner's charging pair, written by hand in the file's words, is the rule
  the recipes make.
*/

/** A recipe copied as the app copies one: its settings at their defaults, written into its blocks. */
const copied = (recipe: Recipe): Rule => {
  const defaults = Object.fromEntries(Object.entries(recipe.params.fields).map(([key, field]) => [key, ('default' in field ? field.default : null) as Value]));
  return inlineParams(recipe, defaults);
};

/** Each role filled: a part of a made-up device, or another automation. */
const usesOf = (rule: Rule): Record<string, Use> =>
  Object.fromEntries(Object.entries(rule.roles).map(([role, spec], index) => [role, isAutomationRole(spec) ? { automation: `other-${index}` } : { device: `device-${index}`, part: index % 2 ? 'main' : 'outlet.ac' }]));

describe('a rule, written and read back', () => {
  for (const recipe of STANDARD_RECIPES) {
    test(`${recipe.label}: as it went`, () => {
      const rule = copied(recipe);
      const uses = usesOf(rule);
      const written = ruleToConfig(rule, uses);
      const read = ruleFromConfig(written as Record<string, unknown>, ['automations', 'a']);
      expect(read.issues).toEqual([]);
      expect(read.rule).toEqual(rule);
      expect(read.uses).toEqual(uses);
    });
  }

  test('a rule with every kind of step and trigger, and what text cannot say kept as data', () => {
    const rule: Rule = {
      roles: {
        station: { label: 'Station', description: 'Station', capabilities: [] },
        plug: { label: 'The charger’s plug', description: 'The plug the charger is in', capabilities: ['switch', 'powerMeter'], oneOf: ['switch'] },
        other: { automation: true, label: 'Other', description: 'Other' },
      },
      params: { fields: {} },
      when: [{ at: { value: '07:00' }, days: ['mon', 'fri'] }, { every: { value: 15 } }, { event: { role: 'station', event: 'mains-lost' } }, { becomes: { reachable: 'plug' }, heldForMinutes: { value: 2 } }],
      if: { all: [{ reachable: 'plug' }] },
      then: [
        { command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { compare: 'lt', left: { read: { role: 'station', means: 'battery.soc' } }, right: { value: 50 } } } } },
        { command: { role: 'station', capability: 'light' as CapabilityName, command: 'mode', args: { mode: { value: 'sos' }, list: { value: [1, 2] } } } },
        { command: { role: 'station', capability: 'beep' as CapabilityName, command: 'now', args: {} } },
        { write: { role: 'station', key: 'acChargeLimit', value: { value: 80 } } },
        { write: { role: 'station', means: 'battery.dischargeFloor', value: { value: 20 } } },
        { wait: { seconds: { value: 90 } } },
        { waitUntil: { condition: { reachable: 'plug' }, atMostSeconds: { value: 120 } } },
        { ensure: { condition: { compare: 'gt', left: { read: { role: 'plug', means: 'power.draw' } }, right: { value: 50 } }, withinSeconds: { value: 20 }, tries: { value: 5 }, retry: [{ wait: { seconds: { value: 5 } } }] } },
        { choose: { if: { reachable: 'plug' }, then: [], else: [{ start: { role: 'other', waitSeconds: { value: 600 } } }] } },
        { choose: { if: { value: true }, then: [{ start: { role: 'other' } }] } },
        { watch: { condition: { reachable: 'plug' }, seconds: { value: 5 }, then: [] } },
        { watch: { condition: { reachable: 'plug' }, seconds: { value: 5 }, else: [] } },
      ],
      otherwise: [],
    };
    const uses: Record<string, Use> = { station: { device: 'garage-p280', part: 'outlet.ac' }, plug: { device: 'smart-plug', part: 'main' }, other: { automation: 'night' } };
    const written = ruleToConfig(rule, uses);
    // The list it sends is not text: it stays the rule's own data, in its place.
    expect((written.do as Record<string, unknown>[])[1]).toEqual({ send: 'mode', to: 'station', capability: 'light', with: { mode: '"sos"', list: { value: [1, 2] } } });
    expect(written['only if']).toEqual({ all: [{ reachable: 'plug' }] });
    const read = ruleFromConfig(written as Record<string, unknown>, []);
    expect(read.issues).toEqual([]);
    expect(read.rule).toEqual(rule);
  });

  test('the owner’s charging pair, in the file’s words, is what the recipes make', () => {
    const start = ruleFromConfig(
      {
        uses: { supply: { part: 'garage-p280.outlet.ac', label: 'What powers the charger', description: 'What switches power to the charger: a station’s AC outlets, or a plug in front of its charger', needs: ['switch', 'powerMeter'] }, charger: { part: 'smart-plug', label: 'The charger’s plug', description: 'The smart plug the charger is in: it switches the charger and measures what it draws', needs: ['powerMeter', 'switch'] } },
        do: [
          { 'turn on': 'supply' },
          { 'wait until': 'charger reachable', 'at most': '2 min' },
          { 'turn on': 'charger' },
          { 'make sure': 'charger.power.draw > 50 W', within: '20 s', tries: 5, 'each time': [{ 'turn off': 'charger' }, { wait: '5 s' }, { 'turn on': 'charger' }] },
        ],
        'if a step fails': [{ 'turn off': 'charger' }, { 'turn off': 'supply' }],
      },
      ['automations', 'start-charging-scooter']
    );
    expect(start.issues).toEqual([]);
    expect(checkRule(start.rule!, { fn: () => null })).toEqual([]);
    expect(start.uses).toEqual({ supply: { device: 'garage-p280', part: 'outlet.ac' }, charger: { device: 'smart-plug', part: 'main' } });
    const recipe = copied(STANDARD_RECIPES.find((each) => each.id === 'standard.start-charging')!);
    // What it does is the recipe's — but for "if it never starts charging", already chosen: switch both off.
    expect(start.rule!.then).toEqual(recipe.then);
  });

  test('each problem with where it is: the step, and how far into its text', () => {
    const read = ruleFromConfig(
      {
        uses: { charger: 'smart-plug' },
        do: [{ 'turn on': 'charger' }, { 'make sure': 'charger.power.draw >', within: '20 s', tries: 3 }, { jump: 'charger' }, { 'wait until': 'charger reachable' }],
      },
      ['automations', 'x']
    );
    expect(read.rule).toBeNull();
    expect(read.issues).toEqual([
      { message: 'It ends where a value was expected', path: ['automations', 'x', 'do', 1, 'make sure'], offset: 20 },
      { message: 'Not a step: "jump". A step starts with turn on, turn off, switch, send, set, wait, wait until, make sure, if, watch or start', path: ['automations', 'x', 'do', 2] },
      { message: '"wait until" needs "at most": every wait has its limit', path: ['automations', 'x', 'do', 3] },
    ]);
  });
});

describe('lengths of time', () => {
  test('written in the largest unit that says them whole, and read in any', () => {
    expect([5, 90, 120, 3600, 0].map(durationText)).toEqual(['5 s', '90 s', '2 min', '1 h', '0 s']);
    expect(['5 s', '2 min', '1 h', '1.5 min', 30, 'soon'].map(durationSeconds)).toEqual([5, 120, 3600, 90, 30, null]);
  });
});
