import { describe, expect, test } from 'bun:test';

import type { CapabilityName } from '@kraftverk/device-sdk';

import { checkBinding, checkRule } from '../check.ts';
import type { Weekday } from '../clock.ts';
import { evaluateNow, inlineParams, withSettings, type RuleScope } from '../evaluate.ts';
import { STANDARD_RECIPES } from '../recipes.ts';
import { isAutomationRole, isPeopleRole, isPersonRole, isPlaceRole, type Expr, type Recipe, type Rule } from '../rule.ts';
import { durationSeconds, durationText, ruleFromConfig, ruleToConfig, type Use } from './rules.ts';

/*
  An automation's rule as its configuration writes it, and back: every
  standard recipe, copied as the app copies one, comes back as it went; and
  the owner's charging pair, written by hand in the file's words, is the rule
  the recipes make.
*/

/** A recipe copied as the app copies one: its settings kept, at the recipe's values. */
const copied = (recipe: Recipe): Rule => {
  const { id: _id, label: _label, description: _description, sentence: _sentence, ...rule } = recipe;
  return withSettings(rule, {});
};

/** Each role filled: a part of a made-up device, another automation, a made-up person, everyone, a made-up room. */
const usesOf = (rule: Rule): Record<string, Use> =>
  Object.fromEntries(
    Object.entries(rule.roles).map(([role, spec], index): [string, Use] => [
      role,
      isAutomationRole(spec)
        ? { automation: `other-${index}` }
        : isPersonRole(spec)
          ? { person: `person-${index}` }
          : isPeopleRole(spec)
            ? { everyone: true }
            : isPlaceRole(spec)
              ? { space: `room-${index}` }
              : { device: `device-${index}`, part: index % 2 ? 'main' : 'outlet.ac' },
    ])
  );

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
        station: { label: 'Station', capabilities: [] },
        plug: { label: 'The charger’s plug', capabilities: ['switch', 'powerMeter'], oneOf: ['switch'] },
        other: { automation: true, label: 'Other' },
      },
      params: { fields: {} },
      when: [{ at: { value: '07:00' }, days: ['mon', 'fri'] }, { every: { value: 900, unit: 's' } }, { event: { role: 'station', event: 'mains-lost' } }, { becomes: { reachable: 'plug' }, heldFor: { value: 120, unit: 's' } }],
      if: { all: [{ reachable: 'plug' }] },
      then: [
        { command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { compare: 'lt', left: { read: { role: 'station', means: 'charge' } }, right: { value: 50 } } } } },
        { command: { role: 'station', capability: 'light' as CapabilityName, command: 'mode', args: { mode: { value: 'sos' }, list: { value: [1, 2] } } } },
        { command: { role: 'station', capability: 'beep' as CapabilityName, command: 'now', args: {} } },
        { write: { role: 'station', key: 'acChargeLimit', value: { value: 80 } } },
        { write: { role: 'station', means: 'dischargeFloor', value: { value: 20 } } },
        { wait: { for: { value: 90, unit: 's' } } },
        { waitUntil: { condition: { reachable: 'plug' }, atMost: { value: 120, unit: 's' } } },
        { ensure: { condition: { compare: 'gt', left: { read: { role: 'plug', means: 'power' } }, right: { value: 50 } }, within: { value: 20, unit: 's' }, tries: { value: 5 }, retry: [{ wait: { for: { value: 5, unit: 's' } } }] } },
        { choose: { if: { reachable: 'plug' }, then: [], else: [{ start: { role: 'other', andWait: { value: 600, unit: 's' } } }] } },
        { choose: { if: { value: true }, then: [{ start: { role: 'other' } }] } },
        { watch: { condition: { reachable: 'plug' }, for: { value: 5, unit: 's' }, then: [] } },
        { watch: { condition: { reachable: 'plug' }, for: { value: 5, unit: 's' }, else: [] } },
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
        uses: { supply: { part: 'garage-p280.outlet.ac', label: 'What powers the charger', needs: ['switch', 'powerMeter'] }, charger: { part: 'smart-plug', label: 'The charger’s plug', needs: ['powerMeter', 'switch'] } },
        do: [
          { 'turn on': 'supply' },
          { 'wait until': 'charger reachable', 'at most': '2 min' },
          { 'turn on': 'charger' },
          { 'make sure': 'charger.power > 50 W', within: '20 s', tries: 5, 'each time': [{ 'turn off': 'charger' }, { wait: '5 s' }, { 'turn on': 'charger' }] },
        ],
        'if a step fails': [{ 'turn off': 'charger' }, { 'turn off': 'supply' }],
      },
      ['automations', 'start-charging-scooter']
    );
    expect(start.issues).toEqual([]);
    expect(checkRule(start.rule!, { fn: () => null })).toEqual([]);
    expect(start.uses).toEqual({ supply: { device: 'garage-p280', part: 'outlet.ac' }, charger: { device: 'smart-plug', part: 'main' } });
    // Its settings written into its blocks, as a file of literal values says them.
    const recipe = inlineParams(copied(STANDARD_RECIPES.find((each) => each.id === 'standard.start-charging')!), {});
    // What it does is the recipe's — but for "if it never starts charging", already chosen: switch both off.
    expect(start.rule!.then).toEqual(recipe.then);
  });

  test('a charge kept between two levels: each trigger with what it does beside it — no ids, no asking which started it', () => {
    const entry = {
      uses: { battery: 'garage-p280', charger: 'smart-plug' },
      when: [
        { becomes: 'battery.charge < 20 %', for: '2 min', do: [{ 'turn on': 'charger' }] },
        { becomes: 'battery.charge >= 40 %', for: '2 min', do: [{ 'turn off': 'charger' }] },
      ],
      do: [],
    };
    const read = ruleFromConfig(entry, ['automations', 'battery-window']);
    expect(read.issues).toEqual([]);
    expect(checkRule(read.rule!, { fn: () => null })).toEqual([]);
    // What the recipe makes, its settings at these levels.
    const recipe = inlineParams(STANDARD_RECIPES.find((each) => each.id === 'standard.charge-between')!, { low: 20, lowFor: 120, high: 40, highFor: 120 });
    expect(read.rule!.when).toEqual(recipe.when);
    expect(read.rule!.if).toBeUndefined();
    // Written back as it was written.
    expect(ruleToConfig(read.rule!, read.uses)).toMatchObject({ when: entry.when, do: [] });
  });

  test('a trigger with no steps of its own takes the automation’s; with none there either, it is said where', () => {
    const shared = ruleFromConfig({ uses: { plug: 'smart-plug' }, when: [{ at: '07:00', do: [{ 'turn on': 'plug' }] }, { at: '22:00' }], do: [{ 'turn off': 'plug' }] }, ['a']);
    expect(checkRule(shared.rule!, { fn: () => null })).toEqual([]);
    const bare = ruleFromConfig({ uses: { plug: 'smart-plug' }, when: [{ at: '07:00', do: [{ 'turn on': 'plug' }] }, { at: '22:00' }], do: [] }, ['a']);
    expect(checkRule(bare.rule!, { fn: () => null })).toEqual(['when[1].then: it does nothing — say what it does, or what the automation does']);
    // A name of its own is checked as one.
    expect(ruleFromConfig({ uses: { plug: 'smart-plug' }, when: [{ at: '07:00', id: 'Morning' }], do: [{ 'turn on': 'plug' }] }, ['a']).issues).toEqual([
      { message: 'A name of its own is letters and digits, starting with a lowercase letter: "low"', path: ['a', 'when', 0, 'id'] },
    ]);
  });

  test('each problem with where it is: the step, and how far into its text', () => {
    const read = ruleFromConfig(
      {
        uses: { charger: 'smart-plug' },
        do: [{ 'turn on': 'charger' }, { 'make sure': 'charger.power >', within: '20 s', tries: 3 }, { jump: 'charger' }, { 'wait until': 'charger reachable' }],
      },
      ['automations', 'x']
    );
    expect(read.rule).toBeNull();
    expect(read.issues).toEqual([
      { message: 'It ends where a value was expected', path: ['automations', 'x', 'do', 1, 'make sure'], offset: 15 },
      { message: 'Not a step: "jump". A step starts with turn on, turn off, switch, send, set, set mode, set variable, count, start timer, stop timer, notify, wait, wait until, wait for, make sure, if, watch, repeat, for each, try, stop, answer, start, run script or remember', path: ['automations', 'x', 'do', 2] },
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
        when: [{ becomes: 'station.charge < 20 %' }, { event: 'mains.lost', from: 'mains' }],
        do: [{ 'turn on': 'plug' }, { 'wait until': 'plug.power > 50 W', 'at most': '20 s' }],
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
  const read = (condition: string) => ruleFromConfig({ uses: { plug: 'plug' }, when: [{ becomes: condition }], do: [{ 'turn on': 'plug' }] }, ['a']);
  const problems = (condition: string) => checkRule(read(condition).rule!, { fn: () => null });
  const scope = (watts: number): RuleScope => ({
    param: () => ({ value: null, unit: null }),
    read: (_role, means) => (means === 'power' ? { value: watts, label: 'Power', unit: 'W' } : null),
    reachable: () => ({ reachable: true, detail: '' }),
    name: (role) => role,
    clock: () => null,
  });

  test('a number keeps the unit it is written in, is written back so, and is converted where it meets a reading', () => {
    const rule = read('plug.power > 2 kW').rule!;
    expect(rule.when[0]).toEqual({ becomes: { compare: 'gt', left: { read: { role: 'plug', means: 'power' } }, right: { value: 2, unit: 'kW' } } });
    expect(ruleToConfig(rule, { plug: { device: 'plug', part: 'main' } }).when).toEqual([{ becomes: 'plug.power > 2 kW' }]);
    const becomes = (rule.when[0] as { becomes: Expr }).becomes;
    expect(evaluateNow(becomes, scope(2500))).toBe(true);
    expect(evaluateNow(becomes, scope(1500))).toBe(false);
    // With no unit, a number is in the unit of what it is beside.
    expect(evaluateNow((read('plug.power > 2000').rule!.when[0] as { becomes: Expr }).becomes, scope(2500))).toBe(true);
  });

  test('two quantities never meet: refused before it runs — and a unit the language does not know, where it is written', () => {
    expect(problems('plug.power > 50 °C')).toEqual(['when[0].becomes: compares a number in W with a number in °C']);
    expect(problems('plug.priceRank <= 4 W')).toEqual(['when[0].becomes: compares a number with no unit with a number in W']);
    expect(read('plug.power > 50 parsecs').issues).toEqual([{ message: '"parsecs" is not a unit kraftverk knows: W, kWh, %, °C, min …', path: ['a', 'when', 0, 'becomes'], offset: 16 }]);
    // Beside a sum, too: a charge less 5 %, but not less 5 W.
    expect(problems('plug.charge < plug.charge - 5 %')).toEqual([]);
    expect(problems('plug.charge < plug.charge - 5 W')).toEqual(['when[0].becomes.right: % and W are not of one quantity']);
  });

  test('a setting keeps the unit it is set in: the setting\'s own is the binding\'s to hold it to', () => {
    const set = (step: Record<string, unknown>) => ruleFromConfig({ uses: { st: 'station' }, do: [{ set: 'st', ...step }] }, ['a']);
    expect(set({ meaning: 'chargeLimit', to: '80 %' }).rule!.then[0]).toEqual({ write: { role: 'st', means: 'chargeLimit', value: { value: 80, unit: '%' } } });
    expect(set({ setting: 'inputLimit', to: '2 kW' }).rule!.then[0]).toEqual({ write: { role: 'st', key: 'inputLimit', value: { value: 2, unit: 'kW' } } });
    expect(set({ setting: 'inputLimit', to: '2000' }).rule!.then[0]).toEqual({ write: { role: 'st', key: 'inputLimit', value: { value: 2000 } } });
    // Bound: held to the setting's range in its own unit — 2 kW is 2000 W — and refused in another quantity's.
    const station = (max: number) => ({
      name: 'Station',
      part: 'main',
      capabilities: [],
      description: { parts: [{ id: 'main', label: 'Station', kind: 'device' }], attributes: [{ key: 'inputLimit', label: 'Input limit', value: { type: 'number', unit: 'W', min: 0, max }, access: 'write' }] },
    });
    const twoKilowatts = set({ setting: 'inputLimit', to: '2 kW' }).rule!;
    expect(checkBinding(twoKilowatts, () => [station(3000) as never])).toEqual([]);
    expect(checkBinding(twoKilowatts, () => [station(1500) as never])).toHaveLength(1);
    expect(checkBinding(set({ setting: 'inputLimit', to: '50 °C' }).rule!, () => [station(3000) as never])).toEqual(['St: Input limit is set in W, not °C']);
  });
});

describe('a script, by its key where a step runs it', () => {
  test('run script: key.step — its role made as uses would have it, written back so, and read back as it went', () => {
    const read = ruleFromConfig({ do: [{ 'run script': 'tidy-up.tidyUp', with: { after: '10 min' } }, { if: 'true', then: [{ 'run script': 'tidy-up' }] }] }, ['a']);
    expect(read.issues).toEqual([]);
    expect(read.rule!.roles).toEqual({ tidyUp: { script: true, label: 'Tidy up' } });
    expect(read.uses).toEqual({ tidyUp: { script: 'tidy-up' } });
    expect(read.rule!.then[0]).toEqual({ script: { role: 'tidyUp', step: 'tidyUp', args: { after: { value: 10, unit: 'min' } } } });
    // The same script, run twice: one role.
    expect((read.rule!.then[1] as unknown as { choose: { then: unknown[] } }).choose.then[0]).toEqual({ script: { role: 'tidyUp' } });
    const written = ruleToConfig(read.rule!, read.uses);
    expect(written.uses).toEqual({});
    expect(written.do).toEqual([{ 'run script': 'tidy-up.tidyUp', with: { after: '10 min' } }, { if: true, then: [{ 'run script': 'tidy-up' }] }]);
    expect(ruleFromConfig(written as Record<string, unknown>, ['a']).rule).toEqual(read.rule);
  });

  test('a key that begins with a digit makes a role that begins with a letter — one the checker takes — and reads back so', () => {
    const read = ruleFromConfig({ do: [{ 'run script': '1-minute-tidy' }] }, ['a']);
    expect(read.rule!.roles).toEqual({ script1MinuteTidy: { script: true, label: '1 minute tidy' } });
    expect(checkRule(read.rule!, { fn: () => null })).toEqual([]);
    const written = ruleToConfig(read.rule!, read.uses);
    expect(written.do).toEqual([{ 'run script': '1-minute-tidy' }]);
    expect(ruleFromConfig(written as Record<string, unknown>, ['a']).rule).toEqual(read.rule);
  });

  test('the long form stays where it says more: a label of its own, or a function a condition calls', () => {
    const labelled = ruleFromConfig({ uses: { tidy: { script: 'tidy-up', label: 'The tidy' } }, do: [{ 'run script': 'tidy' }] }, ['a']);
    expect(ruleToConfig(labelled.rule!, labelled.uses).uses).toEqual({ tidy: { script: 'tidy-up', label: 'The tidy' } });
    const called = ruleFromConfig({ uses: { tidyUp: { script: 'tidy-up' } }, 'only if': 'tidyUp.feelsLike(20, 50) > 18', do: [{ 'run script': 'tidyUp' }] }, ['a']);
    expect(called.issues).toEqual([]);
    expect(ruleToConfig(called.rule!, called.uses)).toMatchObject({ uses: { tidyUp: { script: 'tidy-up' } }, do: [{ 'run script': 'tidyUp' }] });
    // A key whose role name is another role's: a role of its own, written in full.
    const taken = ruleFromConfig({ uses: { tidyUp: 'desk-plug' }, do: [{ 'turn off': 'tidyUp' }, { 'run script': 'tidy-up' }] }, ['a']);
    expect(taken.uses).toMatchObject({ tidyUp2: { script: 'tidy-up' } });
    const again = ruleToConfig(taken.rule!, taken.uses);
    expect(again.uses).toMatchObject({ tidyUp2: { script: 'tidy-up' } });
    expect(ruleFromConfig(again as Record<string, unknown>, ['a']).rule).toEqual(taken.rule);
  });
});
