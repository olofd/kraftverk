import { describe, expect, test } from 'bun:test';

import { capabilitiesOf, MAIN_PART, type DeviceDescription } from '@kraftverk/device-sdk';
import type { Value } from '@kraftverk/device-sdk';

import { checkBinding, checkRule } from './check.ts';
import { describeRule, describeTriggers } from './describe.ts';
import { evaluate, evaluateNow, type RuleScope } from './evaluate.ts';
import { chargeBetween, lowBattery, mainsLost, STANDARD_RECIPES } from './recipes.ts';
import type { Command, Expr } from './rule.ts';

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
  once the station has stayed below 15 % for a while and off once it has
  stayed at 50 % or above — a charge window below the lowest limit the
  station's own settings allow. Each side its own trigger, with its own id
  and hold; the one step asks which started it, and reads no level itself.
*/
describe('charging between two levels', () => {
  const station: DeviceDescription = {
    parts: [{ id: MAIN_PART, label: 'Station', kind: 'device' }, { id: 'input.ac', label: 'Mains', kind: 'input' }],
    attributes: [
      { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%' }, means: 'charge' },
      { key: 'input.ac.present', part: 'input.ac', label: 'Mains', value: { type: 'boolean' }, means: 'mainsPresent' },
    ],
  };
  const plug: DeviceDescription = {
    parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
    attributes: [{ key: 'relay', label: 'Power', value: { type: 'boolean' }, means: 'on' }],
  };
  const params = { low: 15, lowFor: 120, high: 50, highFor: 180 };
  /** As a run sees it: the charge, the settings, and the id of the trigger that started it ("" — none did). */
  const scope = (soc: Value, overrides: Record<string, Value> = {}, trigger = ''): RuleScope => ({
    param: (name) => ({ ...params, ...overrides })[name as keyof typeof params] ?? null,
    read: (_role, means) => (means === 'charge' && typeof soc === 'number' ? { value: soc, label: 'Charge', unit: '%' } : null),
    reachable: () => ({ reachable: true, detail: 'connected' }),
    name: (role) => (role === 'battery' ? 'Garage P280' : 'ATORCH plug'),
    clock: () => '12:00',
    run: (fact) => (fact === 'trigger' ? trigger : null),
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
    expect(chargeBetween.when.map((trigger) => trigger.id)).toEqual(['low', 'high']);
    expect(evaluateNow(falls, scope(12))).toBe(true);
    expect(await evaluate(on, scope(12, {}, 'low'))).toBe(true);
    expect(evaluateNow(reaches, scope(50))).toBe(true);
    expect(await evaluate(on, scope(50, {}, 'high'))).toBe(false);
  });

  test('each side holds for its own time, and the step reads no level: the two can never disagree', () => {
    expect(chargeBetween.when.map((trigger) => ('becomes' in trigger ? trigger.heldFor : null))).toEqual([{ param: 'lowFor' }, { param: 'highFor' }]);
    expect(JSON.stringify(on)).not.toContain('charge');
  });

  test('in between, neither edge is true: it charges all the way up, and runs all the way down', () => {
    for (const soc of [16, 30, 49]) {
      expect(evaluateNow(falls, scope(soc))).toBe(false);
      expect(evaluateNow(reaches, scope(soc))).toBe(false);
    }
  });

  test('does nothing when the charge is not known, nothing played between the two, and nothing with a window upside down', async () => {
    expect(evaluateNow(falls, scope(null))).toBeNull();
    expect(evaluateNow(reaches, scope(null))).toBeNull();
    expect(await evaluate(chargeBetween.if!, scope(12, {}, 'low'))).toBe(true);
    expect(await evaluate(chargeBetween.if!, scope(30, {}, ''))).toBe(false);
    expect(await evaluate(chargeBetween.if!, scope(12, { low: 60, high: 50 }, 'low'))).toBe(false);
  });

  test('reads as what it does', () => {
    const name = (role: string) => (role === 'battery' ? 'Garage P280' : 'ATORCH plug');
    expect(describeRule(chargeBetween, params, name)).toBe('Charge Garage P280 with ATORCH plug: on once it has been below 15 % for 2 min, off once it has been at 50 % or above for 3 min.');
    expect(describeRule(lowBattery, { below: 20, heldFor: 300, action: 'on' }, name)).toBe('When Garage P280 stays below 20 % for 5 min, turn ATORCH plug on.');
  });

  test('says when it runs, a trigger at a time', () => {
    const name = (role: string) => (role === 'battery' ? 'Garage P280' : 'ATORCH plug');
    expect(describeTriggers(chargeBetween, params, name)).toEqual([
      "When Garage P280’s charge is below 15 % for 2 min",
      "When Garage P280’s charge is at least 50 % for 3 min",
    ]);
  });
});
