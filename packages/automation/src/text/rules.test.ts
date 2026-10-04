import { describe, expect, test } from 'bun:test';

import type { CapabilityName, Value } from '@kraftverk/device-sdk';

import { checkRule } from '../check.ts';
import type { Weekday } from '../clock.ts';
import { inlineParams } from '../evaluate.ts';
import { STANDARD_RECIPES } from '../recipes.ts';
import { isAutomationRole, type Recipe, type Rule } from '../rule.ts';
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

  test('days are written as a person says them: weekdays, weekends, or the list', () => {
    const at = (days: Weekday[]) =>
      ruleToConfig({ roles: {}, params: { fields: {} }, when: [{ at: { value: '07:00' }, days }], then: [] }, {}).when;
    expect(at(['mon', 'tue', 'wed', 'thu', 'fri'])).toEqual([{ at: '07:00', days: 'weekdays' }]);
    expect(at(['sat', 'sun'])).toEqual([{ at: '07:00', days: 'weekends' }]);
    expect(at(['mon', 'fri'])).toEqual([{ at: '07:00', days: ['mon', 'fri'] }]);
  });

  test('roles nothing fills yet — a rule being built — are written empty and read back so', () => {
    for (const recipe of STANDARD_RECIPES) {
      const rule = copied(recipe);
      const written = ruleToConfig(rule, {});
      const read = ruleFromConfig(written as Record<string, unknown>, ['automations', 'a']);
      expect(read.issues).toEqual([]);
      expect(read.rule).toEqual(rule);
      expect(read.uses).toEqual({});
    }
    // By hand: empty, as YAML writes it.
    const read = ruleFromConfig({ uses: { plug: null, other: { automation: null } }, do: [{ 'turn on': 'plug' }, { start: 'other' }] }, ['automations', 'a']);
    expect(read.issues).toEqual([]);
    expect(read.uses).toEqual({});
    expect(Object.keys(read.rule!.roles)).toEqual(['plug', 'other']);
  });

  test('a rule with every kind of step and trigger, and what text cannot say kept as data', () => {
    const rule: Rule = {
      roles: {
        station: { label: 'Station', description: 'Station', capabilities: [] },
        plug: { label: 'The charger’s plug', description: 'The plug the charger is in', capabilities: ['switch', 'powerMeter'], oneOf: ['switch'] },
        other: { automation: true, label: 'Other', description: 'Other' },
      },
      params: { fields: {} },
      when: [{ at: { value: '07:00' }, days: ['mon', 'fri'] }, { every: { value: 900 } }, { event: { role: 'station', event: 'mains-lost' } }, { becomes: { reachable: 'plug' }, heldFor: { value: 120 } }],
      if: { all: [{ reachable: 'plug' }] },
      then: [
        { command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { compare: 'lt', left: { read: { role: 'station', means: 'battery.soc' } }, right: { value: 50 } } } } },
        { command: { role: 'station', capability: 'light' as CapabilityName, command: 'mode', args: { mode: { value: 'sos' }, list: { value: [1, 2] } } } },
        { command: { role: 'station', capability: 'beep' as CapabilityName, command: 'now', args: {} } },
        { write: { role: 'station', key: 'acChargeLimit', value: { value: 80 } } },
        { write: { role: 'station', means: 'battery.dischargeFloor', value: { value: 20 } } },
        { wait: { for: { value: 90 } } },
        { waitUntil: { condition: { reachable: 'plug' }, atMost: { value: 120 } } },
        { ensure: { condition: { compare: 'gt', left: { read: { role: 'plug', means: 'power.draw' } }, right: { value: 50 } }, within: { value: 20 }, tries: { value: 5 }, retry: [{ wait: { for: { value: 5 } } }] } },
        { choose: { if: { reachable: 'plug' }, then: [], else: [{ start: { role: 'other', andWait: { value: 600 } } }] } },
        { choose: { if: { value: true }, then: [{ start: { role: 'other' } }] } },
        { watch: { condition: { reachable: 'plug' }, for: { value: 5 }, then: [] } },
        { watch: { condition: { reachable: 'plug' }, for: { value: 5 }, else: [] } },
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
      { message: '"wait until" needs "at most": every wait has its limit: then the run stops, not having succeeded', path: ['automations', 'x', 'do', 3] },
    ]);
  });
});

describe('lengths of time', () => {
  test('written in the largest unit that says them whole, and read in any', () => {
    expect([5, 90, 120, 3600, 0].map(durationText)).toEqual(['5 s', '90 s', '2 min', '1 h', '0 s']);
    // A bare number says no unit: seconds in one place, minutes in another, it is refused.
    expect(['5 s', '2 min', '1 h', '1.5 min', 30, 'soon'].map(durationSeconds)).toEqual([5, 120, 3600, 90, null, null]);
    for (const [step, path] of [[{ wait: 15 }, ['a', 'do', 0, 'wait']], [{ 'wait until': 'plug reachable', 'at most': '15' }, ['a', 'do', 0, 'at most']]] as const) {
      expect(ruleFromConfig({ do: [step] }, ['a']).issues).toEqual([{ message: 'A length of time says its unit: "15 s", "15 min" or "15 h"', path }]);
    }
    expect(ruleFromConfig({ when: [{ every: 15 }], do: [] }, ['a']).issues).toEqual([{ message: 'A length of time says its unit: "15 s", "15 min" or "15 h"', path: ['a', 'when', 0, 'every'] }]);
  });

  test('a hold, kept in minutes, is written as it was given: every second of an hour comes back', () => {
    const lost: number[] = [];
    for (let seconds = 1; seconds <= 3600; seconds++) {
      const read = ruleFromConfig({ uses: { plug: 'smart-plug' }, when: [{ becomes: 'plug reachable', for: `${seconds} s` }], do: [{ 'turn on': 'plug' }] }, ['a']);
      const again = ruleFromConfig(ruleToConfig(read.rule!, read.uses), ['a']);
      if (again.issues.length || JSON.stringify(again.rule) !== JSON.stringify(read.rule)) lost.push(seconds);
    }
    expect(lost).toEqual([]);
  });
});

describe('what a role needs', () => {
  test('is what the rule does with it: the commands it is sent, the standard readings it is read for, the events it raises', () => {
    const read = ruleFromConfig(
      {
        uses: { station: 'garage-station', plug: 'smart-plug', mains: 'garage-station.input.ac' },
        when: [{ becomes: 'station.battery.soc < 20 %' }, { event: 'mains.lost', from: 'mains' }],
        do: [{ 'turn on': 'plug' }, { 'wait until': 'plug.power.draw > 50 W', 'at most': '20 s' }],
      },
      ['a']
    );
    expect(read.issues).toEqual([]);
    expect(Object.fromEntries(Object.entries(read.rule!.roles).map(([role, spec]) => [role, 'capabilities' in spec ? spec.capabilities : null]))).toEqual({
      station: ['battery'],
      plug: ['powerMeter', 'switch'],
      mains: ['acInput'],
    });
    // A role only read is no longer one any device would do.
    expect(checkRule(read.rule!, { fn: () => null })).toEqual([]);
  });
});

describe('units', () => {
  const read = (condition: string, context = {}) => ruleFromConfig({ uses: { plug: 'plug' }, when: [{ becomes: condition }], do: [] }, ['a'], context);
  test('a number beside a reading is in its unit: converted from another of the same quantity, refused from another quantity', () => {
    // power.draw is in W, its standard meaning says.
    expect(read('plug.power.draw > 2 kW').rule!.when[0]).toEqual({ becomes: { compare: 'gt', left: { read: { role: 'plug', means: 'power.draw' } }, right: { value: 2000 } } });
    expect(read('plug.power.draw > 2.2 kW').rule!.when[0]).toMatchObject({ becomes: { right: { value: 2200 } } });
    expect(read('plug.power.draw < 50 W').rule!.when[0]).toMatchObject({ becomes: { right: { value: 50 } } });
    expect(read('plug.power.draw > 50 °C').issues).toEqual([{ message: 'That is read in W: "°C" is not a unit of it', path: ['a', 'when', 0, 'becomes'], offset: 18 }]);
    // A unit on a reading that has none: refused.
    expect(read('plug.price.rank <= 4 W').issues[0]!.message).toBe('That is read in no unit: "W" is not one');
    // A type's own meaning: its part's unit, as the context says it — or, unknown, the number as written.
    expect(read('plug.acme.flow > 2 kW', { unitOf: () => 'W' }).rule!.when[0]).toMatchObject({ becomes: { right: { value: 2000 } } });
    expect(read('plug.acme.flow > 2 kW').rule!.when[0]).toMatchObject({ becomes: { right: { value: 2 } } });
    // Beside a sum, too: the charge limit less 5 %.
    expect(read('plug.battery.soc < plug.battery.chargeLimit - 5 %').issues).toEqual([]);
  });

  test('a setting set by its meaning is set in its unit; a unit where nothing says one is refused, not dropped', () => {
    const set = (step: Record<string, unknown>, context = {}) => ruleFromConfig({ uses: { st: 'station' }, do: [{ set: 'st', ...step }] }, ['a'], context);
    expect(set({ meaning: 'acme.inputLimit', to: '2 kW' }, { unitOf: () => 'W' }).rule!.then[0]).toEqual({ write: { role: 'st', means: 'acme.inputLimit', value: { value: 2000 } } });
    expect(set({ meaning: 'battery.chargeLimit', to: '80 %' }).rule!.then[0]).toMatchObject({ write: { value: { value: 80 } } });
    expect(set({ meaning: 'acme.inputLimit', to: '50 °C' }, { unitOf: () => 'W' }).issues[0]!.message).toBe('That is read in W: "°C" is not a unit of it');
    // By its key, or its meaning's unit unknown: what unit it is in nobody says, so a unit written is not quietly dropped.
    expect(set({ setting: 'inputLimit', to: '2 kW' }).issues).toEqual([{ message: 'Nothing here says what unit it is in: write it without "kW", in the unit it is set in', path: ['a', 'do', 0, 'to'], offset: 0 }]);
    expect(set({ meaning: 'acme.inputLimit', to: '2 kW' }).issues[0]!.message).toContain('Nothing here says what unit it is in');
    expect(set({ setting: 'inputLimit', to: '2000' }).rule!.then[0]).toMatchObject({ write: { value: { value: 2000 } } });
  });
});
