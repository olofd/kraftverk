import { describe, expect, test } from 'bun:test';

import { checkBinding, describeRule, lowBattery, mainsLost, MAIN_PART, partsOf, capabilitiesOf, validateDescription } from '@kraftverk/device-sdk';

import { mainsWatcher } from '../src/automation.ts';
import { describeStation } from '../src/index.ts';
import { SimulatedStation } from '../src/simulator.ts';

/*
  What the station brings to automations: the events its mains input raises
  when mains comes and goes — `acInput`'s own — so the shared recipes, which
  ask for capabilities and not for this product, run on it.
*/

describe('mains, as events', () => {
  test('raised on a change, never on the first reading, and not for what is not known', () => {
    const raised: string[] = [];
    const watch = mainsWatcher((event) => raised.push(event));
    watch(null);
    watch(false); // the first thing known: where it starts, not a loss
    watch(false);
    watch(true);
    watch(null);
    watch(false);
    expect(raised).toEqual(['mains.restored', 'mains.lost']);
  });

  test('a simulated station losing mains says so, from its mains input', () => {
    const station = new SimulatedStation({ get: () => null, set: () => {}, delete: () => {} } as never);
    const raised: string[] = [];
    const watch = mainsWatcher((event) => raised.push(event));
    watch(station.status().gridConnected);
    station.setGridConnected(false);
    watch(station.status().gridConnected);
    expect(raised).toEqual(['mains.lost']);
    const declared = describeStation().events?.find((event) => event.id === 'mains.lost');
    expect(declared).toMatchObject({ part: 'input.ac', level: 'warn' });
  });
});

describe('the shared recipes, on a station', () => {
  const description = describeStation(2);
  const bound = (parts: Record<string, string>) => (role: string) =>
    parts[role] ? { name: 'Garage P280', description, part: parts[role]!, capabilities: capabilitiesOf(description, parts[role]!) } : null;

  test('are filled by its parts: its battery or a pack, its mains input, one of its outlets', () => {
    expect(validateDescription(description, 'aferiy.p280')).toEqual([]);
    expect(checkBinding(lowBattery, bound({ battery: MAIN_PART, switch: 'outlet.ac' }))).toEqual([]);
    expect(checkBinding(lowBattery, bound({ battery: 'pack.2', switch: 'outlet.ac' }))).toEqual([]);
    expect(checkBinding(mainsLost, bound({ input: 'input.ac', switch: 'outlet.dc' }))).toEqual([]);
    expect(checkBinding(mainsLost, bound({ input: MAIN_PART, switch: 'outlet.dc' }))).toContain('Mains input: Garage P280 cannot do that');
    expect(partsOf(description).map((part) => part.id)).toContain('input.ac');
  });

  test('read as sentences', () => {
    const name = (role: string) => (role === 'switch' ? 'Heater plug' : 'Garage P280');
    expect(describeRule(lowBattery, { below: 20, minutes: 5, action: 'on' }, name)).toBe('When Garage P280 stays below 20 % for 5 min, turn Heater plug on.');
    expect(describeRule(mainsLost, { action: 'off' }, name)).toBe('When Garage P280 loses mains power, turn Heater plug off.');
  });
});
