import { describe, expect, test } from 'bun:test';

import {
  checkBinding,
  checkRule,
  defineFunction,
  describeRule,
  evaluate,
  evaluateNow,
  type Expr,
  type Recipe,
  type RuleScope,
} from './automation.ts';
import { MAIN_PART, type DeviceDescription } from './description.ts';
import type { Value } from './values.ts';

/*
  The rule: one language that recipes, a DSL and an AI all write. What these
  pin down is what makes that safe to hand to something that is not a person —
  every mistake found before it runs, with where; unknown never taken for true;
  and a sentence for whoever approves it.
*/

const sky = defineFunction({
  id: 'test.weather.sky',
  label: 'How the sky looks',
  description: 'Sunny or cloudy',
  needs: { capabilities: ['weather.forecast'] },
  args: { cloudMax: { type: 'number', unit: '%', min: 0, max: 100 } },
  returns: { type: 'enum', options: [{ value: 'sunny', label: 'Sunny' }, { value: 'cloudy', label: 'Cloudy' }] },
  evaluate: async ({ args }) => ({ value: Number(args.cloudMax) > 50 ? 'sunny' : 'cloudy', detail: `Cloud at most ${String(args.cloudMax)} %` }),
});
const vocabulary = { fn: (id: string) => (id === sky.id ? sky : null) };

const turn: Expr = { compare: 'eq', left: { param: 'action' }, right: { value: 'on' } };

const lowBattery: Recipe = {
  id: 'test.station.low',
  label: 'Low battery',
  description: 'When the battery stays low, switch',
  roles: {
    battery: { label: 'Battery', description: 'A battery', capabilities: ['battery'] },
    switch: { label: 'What to switch', description: 'A plug', capabilities: ['switch'] },
  },
  params: {
    fields: {
      below: { type: 'number', title: 'Below', unit: '%', default: 20 },
      minutes: { type: 'number', title: 'For', unit: 'min', default: 5 },
      action: { type: 'enum', title: 'Turn it', default: 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
    },
  },
  when: [{ becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'battery.soc' } }, right: { param: 'below' } }, heldForMinutes: { param: 'minutes' } }],
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: turn } } }],
};

describe('checking a rule before it runs', () => {
  test('a good one has nothing to say', () => {
    expect(checkRule(lowBattery, vocabulary)).toEqual([]);
  });

  test('every mistake, with where it is', () => {
    const broken: Recipe = {
      ...lowBattery,
      roles: { ...lowBattery.roles, forecast: { label: 'Forecast', description: '', capabilities: ['weather.forecast'] } },
      when: [
        { at: { value: '7am' } },
        { becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'battery.soc' } }, right: { value: true } } },
        { becomes: { call: 'test.weather.sky', role: 'forecast', args: { cloudMax: { value: 40 } } } },
        { event: { role: 'nobody', event: 'x' } },
      ],
      if: { compare: 'eq', left: { call: 'test.weather.sky', role: 'switch', args: { cloudMax: { value: 400 } } }, right: { value: 'rainy' } },
      then: [
        { command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: 1 } } } },
        { command: { role: 'battery', capability: 'switch', command: 'explode', args: {} } },
        { command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { param: 'nothing' }, colour: { value: 'red' } } } },
      ],
    };
    expect(checkRule(broken, vocabulary)).toEqual([
      'when[0].at: a time of day is "HH:MM"',
      'when[1].becomes: compares a number in % with a boolean',
      'when[1].becomes: only numbers are above or below each other',
      'when[2].becomes: "becomes" is evaluated on every reading, so it cannot call test.weather.sky',
      'when[2].becomes: expected a condition, got a string',
      'when[3].event: there is no role "nobody"',
      'if.left: How the sky looks needs a part that offers weather.forecast, and switch does not ask for that',
      'if.left.args.cloudMax: 400 is out of range',
      'if: "rainy" is not one of sunny, cloudy',
      'then[0].command.args.on: expected a boolean, got a number',
      'then[1].command: battery does not ask for switch',
      'then[1].command: switch takes no command "explode"',
      'then[2].command.args.on: there is no setting "nothing"',
      'then[2].command.args.colour: switch.set takes no "colour"',
    ]);
  });

  test('a function nobody installed, a read the role cannot answer', () => {
    const rule: Recipe = {
      ...lowBattery,
      when: [{ becomes: { compare: 'lt', left: { read: { role: 'switch', means: 'battery.soc' } }, right: { value: 10 } } }],
      if: { compare: 'eq', left: { call: 'someone.else.fn', role: 'battery' }, right: { value: 'x' } },
    };
    expect(checkRule(rule, vocabulary)).toEqual(['when[0].becomes.left: switch asks for nothing that reports battery.soc', 'if.left: there is no function "someone.else.fn" installed']);
  });
});

describe('checking it against the parts that fill its roles', () => {
  const station: DeviceDescription = {
    parts: [{ id: MAIN_PART, label: 'Station', kind: 'device' }, { id: 'outlet.ac', label: 'AC', kind: 'outlet', offers: ['switch'] }],
    attributes: [
      { key: 'soc', label: 'Battery', value: { type: 'number', unit: '%' }, means: 'battery.soc' },
      { key: 'outlet.ac.on', part: 'outlet.ac', label: 'On', value: { type: 'boolean' }, means: 'switch.on' },
    ],
  };
  test('fits, or says which role does not', () => {
    const bound = (parts: Record<string, string>) => (role: string) =>
      parts[role] ? { name: role === 'battery' ? 'Station' : 'Station — AC', description: station, part: parts[role]!, capabilities: parts[role] === 'main' ? (['battery'] as const) : (['switch'] as const) } : null;
    expect(checkBinding(lowBattery, bound({ battery: 'main', switch: 'outlet.ac' }))).toEqual([]);
    expect(checkBinding(lowBattery, bound({ battery: 'outlet.ac', switch: 'outlet.ac' }))).toEqual(['Battery: Station cannot do that', 'Battery: Station does not report battery.soc']);
    expect(checkBinding(lowBattery, bound({ battery: 'main' }))).toEqual(['What to switch: no device']);
  });
});

describe('running it', () => {
  const scope = (soc: Value, params: Record<string, Value> = {}): RuleScope => ({
    param: (name) => ({ below: 20, action: 'on', ...params })[name] ?? null,
    read: (_role, means) => (means === 'battery.soc' && typeof soc === 'number' ? { value: soc, label: 'Charge', unit: '%' } : null),
    reachable: () => ({ reachable: true, detail: 'connected' }),
    call: async (_fn, _role, args) => sky.evaluate({ part: { name: 'Weather', part: 'main', device: null, offline: '' }, args, now: new Date(), timeZone: 'UTC' }),
    name: () => 'Garage P280',
  });
  const low = (lowBattery.when[0] as { becomes: Expr }).becomes;

  test('a comparison, and what it read, in words', () => {
    const trace: string[] = [];
    expect(evaluateNow(low, scope(15), trace)).toBe(true);
    expect(trace).toEqual(['Garage P280: Charge 15 %']);
    expect(evaluateNow(low, scope(40))).toBe(false);
  });

  test('unknown is never true, and never false either', async () => {
    expect(evaluateNow(low, scope(null))).toBeNull();
    expect(evaluateNow({ not: low }, scope(null))).toBeNull();
    // …except where the answer does not depend on it.
    expect(evaluateNow({ all: [low, { value: false }] }, scope(null))).toBe(false);
    expect(evaluateNow({ any: [low, { value: true }] }, scope(null))).toBe(true);
    expect(evaluateNow({ all: [low, { value: true }] }, scope(null))).toBeNull();
  });

  test('a function’s answer, and its reason', async () => {
    const trace: string[] = [];
    const looks = await evaluate({ compare: 'eq', left: { call: sky.id, role: 'forecast', args: { cloudMax: { value: 80 } } }, right: { value: 'sunny' } }, scope(50), trace);
    expect(looks).toBe(true);
    expect(trace).toEqual(['Cloud at most 80 %']);
    // Not where functions are not allowed: unknown, not a guess.
    expect(evaluateNow({ call: sky.id, role: 'forecast' }, scope(50))).toBeNull();
  });
});

describe('saying what it does', () => {
  const name = (role: string) => ({ battery: 'Garage P280', switch: 'Heater plug' })[role] ?? role;

  test('in the recipe’s own words, its settings as they read', () => {
    const worded = { ...lowBattery, sentence: 'When {battery} stays below {below} for {minutes}, turn {switch} {action}.' };
    expect(describeRule(worded, { below: 20, minutes: 5, action: 'on' }, name)).toBe('When Garage P280 stays below 20 % for 5 min, turn Heater plug on.');
  });

  test('or from the rule itself, when it has none: what a DSL or an AI wrote reads too', () => {
    expect(describeRule(lowBattery, { below: 20, minutes: 5, action: 'off' }, name)).toBe(
      "When Garage P280's charge is below 20 % for 5 min, turn Heater plug off."
    );
  });
});
