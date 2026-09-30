import { describe, expect, test } from 'bun:test';

import { checkBinding, checkRule, describeRule, describeTriggers, evaluate, evaluateNow, type Command, type Expr, type RuleScope } from './automation.ts';
import { capabilitiesOf, MAIN_PART, type DeviceDescription } from './description.ts';
import { chargeBetween, lowBattery, mainsLost, STANDARD_RECIPES } from './recipes.ts';
import type { Value } from './values.ts';

/*
  The shared vocabulary's recipes: written in library capabilities and
  standard meanings only, so any device that offers them fills their roles.
*/

describe('the shared recipes', () => {
  test('are rules that check, needing no package', () => {
    for (const recipe of STANDARD_RECIPES) expect({ id: recipe.id, problems: checkRule(recipe, { fn: () => null }) }).toEqual({ id: recipe.id, problems: [] });
    expect(STANDARD_RECIPES.every((recipe) => recipe.id.startsWith('standard.'))).toBe(true);
  });

  test('wait for the events a capability declares', () => {
    expect(mainsLost.when).toEqual([{ event: { role: 'input', event: 'mains.lost' } }]);
  });
});

/*
  "Charge between two levels": a station fed by a plug, the plug switched on
  when the station stays below 15 % and off when it reaches 50 % — a charge
  window below the lowest limit the station's own settings allow.
*/
describe('charging between two levels', () => {
  const station: DeviceDescription = {
    parts: [{ id: MAIN_PART, label: 'Station', kind: 'device' }, { id: 'input.ac', label: 'Mains', kind: 'input' }],
    attributes: [
      { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%' }, means: 'battery.soc' },
      { key: 'input.ac.present', part: 'input.ac', label: 'Mains', value: { type: 'boolean' }, means: 'grid.present' },
    ],
  };
  const plug: DeviceDescription = {
    parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
    attributes: [{ key: 'relay', label: 'Power', value: { type: 'boolean' }, means: 'switch.on' }],
  };
  const params = { low: 15, high: 50, minutes: 2 };
  const scope = (soc: Value, overrides: Record<string, Value> = {}): RuleScope => ({
    param: (name) => ({ ...params, ...overrides })[name as keyof typeof params] ?? null,
    read: (_role, means) => (means === 'battery.soc' && typeof soc === 'number' ? { value: soc, label: 'Charge', unit: '%' } : null),
    reachable: () => ({ reachable: true, detail: 'connected' }),
    name: (role) => (role === 'battery' ? 'Garage P280' : 'ATORCH plug'),
    clock: () => '12:00',
  });
  const [falls, reaches] = chargeBetween.when.map((trigger) => (trigger as { becomes: Expr }).becomes) as [Expr, Expr];
  const on = (chargeBetween.then[0] as { command: Command }).command.args.on!;

  test('is filled by a station and the plug that feeds it', () => {
    const bound = (role: string) =>
      role === 'battery'
        ? { name: 'Garage P280', description: station, part: MAIN_PART, capabilities: capabilitiesOf(station, MAIN_PART) }
        : { name: 'ATORCH plug', description: plug, part: MAIN_PART, capabilities: capabilitiesOf(plug, MAIN_PART) };
    expect(checkBinding(chargeBetween, bound)).toEqual([]);
  });

  test('falling below the low level turns the charger on; reaching the high level turns it off', async () => {
    expect(evaluateNow(falls, scope(12))).toBe(true);
    expect(await evaluate(on, scope(12))).toBe(true);
    expect(evaluateNow(reaches, scope(50))).toBe(true);
    expect(await evaluate(on, scope(50))).toBe(false);
  });

  test('in between, neither edge is true: it charges all the way up, and runs all the way down', () => {
    for (const soc of [16, 30, 49]) {
      expect(evaluateNow(falls, scope(soc))).toBe(false);
      expect(evaluateNow(reaches, scope(soc))).toBe(false);
    }
  });

  test('does nothing when the charge is not known, and nothing with a window upside down', async () => {
    expect(await evaluate(on, scope(null))).toBeNull();
    expect(await evaluate(chargeBetween.if!, scope(12))).toBe(true);
    expect(await evaluate(chargeBetween.if!, scope(12, { low: 60, high: 50 }))).toBe(false);
  });

  test('reads as what it does', () => {
    const name = (role: string) => (role === 'battery' ? 'Garage P280' : 'ATORCH plug');
    expect(describeRule(chargeBetween, params, name)).toBe('Charge Garage P280 with ATORCH plug: on when it stays below 15 % for 2 min, off when it reaches 50 %.');
    expect(describeRule(lowBattery, { below: 20, minutes: 5, action: 'on' }, name)).toBe('When Garage P280 stays below 20 % for 5 min, turn ATORCH plug on.');
  });

  test('says when it runs, a trigger at a time', () => {
    const name = (role: string) => (role === 'battery' ? 'Garage P280' : 'ATORCH plug');
    expect(describeTriggers(chargeBetween, params, name)).toEqual([
      "When Garage P280’s charge is below 15 % for 2 min",
      "When Garage P280’s charge is at least 50 %",
    ]);
  });
});
