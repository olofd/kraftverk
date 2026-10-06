import { describe, expect, test } from 'bun:test';

import { settingsFromConfig, settingsToConfig } from './settings.ts';

/*
  A rule's settings as a file writes them: short when a value is all there
  is to say, long when it says more; a number kept in its unit — a length of
  time in seconds — and written back as it was.
*/

const fail = (message: string, path: readonly (string | number)[]): never => {
  throw new Error(`${path.join('.')}: ${message}`);
};
const read = (data: unknown) => settingsFromConfig(data, ['settings'], fail);

describe('settings, as a file writes them', () => {
  test('short: a value alone — a number in its unit, a length of time in seconds, on or off, a text — titled by its name', () => {
    expect(read({ low: '20 %', lowFor: '2 min', fast: true, label: 'Garage', count: 3 }).fields).toEqual({
      low: { type: 'number', title: 'Low', unit: '%', default: 20 },
      lowFor: { type: 'number', title: 'Low for', unit: 's', default: 120 },
      fast: { type: 'boolean', title: 'Fast', default: true },
      label: { type: 'string', title: 'Label', default: 'Garage' },
      count: { type: 'number', title: 'Count', default: 3 },
    });
  });

  test('long: its title, its range in its unit, how it is set, its options', () => {
    expect(
      read({
        low: { title: 'Start charging below', value: '20 %', min: '5 %', max: '90 %', step: '5 %', slider: true },
        hold: { title: 'For at least', value: '2 min', max: '1 h' },
        power: { value: '1.5 kW', min: '500 W' },
        mode: { title: 'Then', value: 'eco', options: { eco: 'Save power', boost: 'Charge fast' } },
      }).fields
    ).toEqual({
      low: { type: 'number', title: 'Start charging below', unit: '%', min: 5, max: 90, step: 5, presentation: 'slider', default: 20 },
      hold: { type: 'number', title: 'For at least', unit: 's', max: 3600, default: 120 },
      power: { type: 'number', title: 'Power', unit: 'kW', min: 0.5, default: 1.5 },
      mode: { type: 'enum', title: 'Then', options: [{ value: 'eco', label: 'Save power' }, { value: 'boost', label: 'Charge fast' }], default: 'eco' },
    });
  });

  test('written back as it was: short where a value is all there is to say', () => {
    for (const data of [
      { low: '20 %', lowFor: '2 min', fast: true, count: 3 },
      { low: { title: 'Start charging below', value: '20 %', min: '5 %', max: '90 %', step: '5 %', slider: true } },
      { mode: { title: 'Then', value: 'eco', options: { eco: 'Save power', boost: 'Charge fast' } } },
    ]) {
      expect(settingsToConfig(read(data))).toEqual(data);
    }
  });

  test('what is wrong, where it is', () => {
    expect(() => read({ low: '20 parsecs' })).toThrow('settings.low: "parsecs" is not a unit kraftverk knows');
    expect(() => read({ low: { value: '20 %', max: '2 kW' } })).toThrow('settings.low.max: "max" is in kW, not a unit of %');
    expect(() => read({ low: { value: '20 %', colour: 'red' } })).toThrow('"colour" is not part of a setting');
    expect(() => read({ mode: { value: 'turbo', options: { eco: 'Eco' } } })).toThrow('Its value is one of its options: eco');
    expect(() => read({ 'two words': 1 })).toThrow('"two words" is not a setting\'s name');
  });
});
