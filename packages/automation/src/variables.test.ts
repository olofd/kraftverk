import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import type { Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';
import { variableFromConfig, variableToConfig } from './text/variables.ts';
import type { ConfigField } from '@kraftverk/device-sdk';

import { counted, stillHolds, timerField, variableFieldOf, variableKeyFrom, variableProblems, variableStart, variableTypedOf, variableValueText, type VariableSpec } from './variables.ts';

/*
  A home's variables, as the language has them: what each starts as, how a
  counter counts, what is wrong with one declared — and `home.var.key` read,
  written and checked against the home's.
*/

const RUNS: VariableSpec = { key: 'dryerRuns', kind: 'counter', field: { type: 'number', title: 'Dryer runs', integer: true, min: 0, max: 3 } };
const GUESTS: VariableSpec = { key: 'guests', kind: 'toggle', field: { type: 'boolean', title: 'Guests staying' } };

describe('a variable', () => {
  test('starts as its default — or nothing, none, nought, its first option', () => {
    expect(variableStart(GUESTS)).toBe(false);
    expect(variableStart(RUNS)).toBe(0);
    expect(variableStart({ key: 'wake', kind: 'time', field: { type: 'string', title: 'Wake' } })).toBeNull();
    expect(variableStart({ key: 'laundry', kind: 'choice', field: { type: 'enum', title: 'Laundry', options: [{ value: 'washing', label: 'Washing' }] } })).toBe('washing');
  });

  test('a counter counts by one, by so many, back to its start — held to its range', () => {
    expect(counted(RUNS, 1)).toBe(2);
    expect(counted(RUNS, 2, { by: 5 })).toBe(3);
    expect(counted(RUNS, 2, { by: -5 })).toBe(0);
    expect(counted(RUNS, 2, { reset: true })).toBe(0);
    expect(counted(RUNS, 2, { by: 0.5 })).toBeNull();
  });

  test('declared: its key, its title, its field fitting its kind, what it starts as fitting its field', () => {
    expect(variableProblems(RUNS)).toEqual([]);
    expect(variableProblems({ ...RUNS, key: 'Dryer runs' })).toEqual(['"Dryer runs": a variable\'s key is a word in camelCase, as "dryerRuns"']);
    expect(variableProblems({ ...RUNS, field: { ...RUNS.field, integer: false } as never })).toEqual(['A counter counts in whole numbers']);
    expect(variableProblems({ ...GUESTS, field: { type: 'number', title: 'Guests' } })).toEqual(['A yes or no holds boolean, not number']);
    expect(variableProblems({ key: 'target', kind: 'number', field: { type: 'number', title: 'Target', min: 16, max: 25, default: 30 } })).toEqual(['What it starts as must be at most 25']);
    expect(variableProblems({ key: 'wake', kind: 'time', field: { type: 'string', title: 'Wake', default: 'soon' } })).toEqual(['"soon" is not a time of day: 07:00']);
  });

  test('starts within its range, whatever it is', () => {
    expect(variableStart({ key: 'cold', kind: 'number', field: { type: 'number', title: 'Cold', max: -5 } })).toBe(-5);
    expect(variableStart({ key: 'warm', kind: 'number', field: { type: 'number', title: 'Warm', min: 10 } })).toBe(10);
    expect(variableStart({ key: 'down', kind: 'counter', field: { type: 'number', title: 'Down', integer: true, min: -10, max: -5 } })).toBe(-5);
  });

  test('declared only as a file can carry it: no unit on a counter, a time in seconds, a step above nought', () => {
    expect(variableProblems({ ...RUNS, field: { ...RUNS.field, unit: 'W' } as never })).toEqual(['A counter counts: it has no unit']);
    expect(variableProblems({ ...RUNS, field: { ...RUNS.field, max: 2.5 } as ConfigField })).toEqual(['A counter’s least, most and start are whole numbers']);
    expect(variableProblems({ key: 'pause', kind: 'number', field: { type: 'number', title: 'Pause', unit: 'min' } })).toEqual(['A length of time is kept in seconds']);
    expect(variableProblems({ key: 'target', kind: 'number', field: { type: 'number', title: 'Target', step: 0 } })).toEqual(['Its step is more than nought']);
    expect(variableProblems({ ...GUESTS, field: { ...GUESTS.field, words: { true: 'Here', false: 'Gone' } } as ConfigField })).toEqual(['A variable does not say "words"']);
  });

  test('what it holds still means the same, declared anew: its kind, its unit, its range', () => {
    const field = { type: 'number', title: 'Target', unit: '°C', max: 25 } as const;
    const target: VariableSpec = { key: 'target', kind: 'number', field };
    expect(stillHolds(target, { ...target, field: { ...field, title: 'Warmth' } }, 21)).toBe(true);
    expect(stillHolds(target, { ...target, field: { ...field, max: 20 } }, 21)).toBe(false);
    expect(stillHolds(target, { ...target, field: { ...field, unit: '°F' } }, 21)).toBe(false);
    expect(stillHolds(target, { ...target, kind: 'counter', field: { ...field, integer: true } }, 21)).toBe(false);
  });

  test('said in its own words: an option by its label, a number in its unit, words quoted', () => {
    expect(variableValueText({ field: { type: 'enum', title: 'Laundry', options: [{ value: 'drying', label: 'Drying' }] } }, 'drying')).toBe('“Drying”');
    expect(variableValueText({ field: { type: 'number', title: 'Target', unit: '°C' } }, 21)).toBe('21 °C');
    expect(variableValueText(GUESTS, true)).toBe('yes');
    expect(variableValueText({ field: { type: 'string', title: 'Wake' } }, '06:45')).toBe('06:45');
    expect(variableValueText({ field: { type: 'string', title: 'Note' } }, 'Back at six')).toBe('“Back at six”');
    expect(variableValueText(RUNS, null)).toBe('nothing');
  });

  test('changed by a person: its options keep the values automations name them by; what it starts as kept while it fits', () => {
    const laundry: ConfigField = { type: 'enum', title: 'Laundry', options: [{ value: 'wash', label: 'Washing' }, { value: 'done', label: 'Done' }], default: 'done' };
    expect(variableFieldOf({ title: 'Laundry', kind: 'choice', options: ['Washing', 'Drying', 'Done'] }, laundry)).toEqual({
      type: 'enum',
      title: 'Laundry',
      options: [{ value: 'wash', label: 'Washing' }, { value: 'drying', label: 'Drying' }, { value: 'done', label: 'Done' }],
      default: 'done',
    });
    expect(variableFieldOf({ title: 'Laundry', kind: 'choice', options: ['Washing'] }, laundry)).toEqual({ type: 'enum', title: 'Laundry', options: [{ value: 'wash', label: 'Washing' }] });
    // A length of time said in minutes is kept in seconds.
    expect(variableFieldOf({ title: 'Pause', kind: 'number', unit: 'min', min: 1, max: 30 })).toEqual({ type: 'number', title: 'Pause', unit: 's', min: 60, max: 1800 });
    expect(variableTypedOf({ key: 'runs', kind: 'counter', field: RUNS.field })).toEqual({ title: 'Dryer runs', kind: 'counter', unit: null, min: null, max: 3 });
  });

  test('in a file: a number with no unit is in the one it says; a step is a difference; written back the same', () => {
    const fail = (message: string): never => {
      throw new Error(message);
    };
    const pause = variableFromConfig('pause', { kind: 'number', unit: 'min', starts: 5, max: 30 }, [], fail);
    expect(pause.field).toEqual({ type: 'number', title: 'Pause', unit: 's', max: 1800, default: 300 });
    expect(variableToConfig(pause)).toEqual({ kind: 'number', starts: '5 min', max: '30 min' });
    const target = variableFromConfig('target', { kind: 'number', starts: '20 °C', step: '0.9 °F' }, [], fail);
    expect(target.field.type === 'number' && target.field.step).toBeCloseTo(0.5);
    expect(variableToConfig({ key: 'tiny', kind: 'number', field: { type: 'number', title: 'Tiny', unit: 'W', default: 0.0000001 } })).toEqual({ kind: 'number', starts: '0.0000001 W' });
  });

  test('a timer: its states its own, a length from a second to a week — and in a file, for so long', () => {
    const laundry: VariableSpec = { key: 'laundry', kind: 'timer', field: timerField('Laundry'), length: 45 * 60 };
    expect(variableProblems(laundry)).toEqual([]);
    expect(variableStart(laundry)).toBe('idle');
    expect(variableProblems({ ...laundry, length: 0 })).toEqual(['A timer runs for a whole number of seconds, from a second to a week']);
    expect(variableProblems({ ...laundry, field: { type: 'enum', title: 'Laundry', options: [{ value: 'on', label: 'On' }] } })).toEqual(['A timer holds its states: idle, running, paused, ended']);
    expect(variableProblems({ ...RUNS, length: 60 })).toEqual(['Only a timer has a length']);
    const fail = (message: string): never => {
      throw new Error(message);
    };
    expect(variableFromConfig('laundry', { kind: 'timer', for: '45 min' }, [], fail)).toEqual(laundry);
    expect(variableToConfig(laundry)).toEqual({ kind: 'timer', for: '45 min' });
    expect(() => variableFromConfig('laundry', { kind: 'timer' }, [], fail)).toThrow('A timer says how long it runs');
    expect(variableFieldOf({ title: 'Oven', kind: 'timer' })).toEqual(timerField('Oven'));
  });

  test('typed by a person: its key from its title, its field from its kind', () => {
    expect(variableKeyFrom('Guests staying', () => false)).toBe('guestsStaying');
    expect(variableKeyFrom('Torktumlarens körningar', () => false)).toBe('torktumlarensKorningar');
    expect(variableKeyFrom('2 lamps', () => false)).toBe('v2Lamps');
    expect(variableKeyFrom('Guests', (key) => key === 'guests')).toBe('guests2');
    expect(variableFieldOf({ title: ' Dryer runs ', kind: 'counter' })).toEqual({ type: 'number', title: 'Dryer runs', integer: true, min: 0 });
    expect(variableFieldOf({ title: 'Laundry', kind: 'choice', options: ['Washing', ' Done', 'Washing', ''] })).toEqual({
      type: 'enum',
      title: 'Laundry',
      options: [
        { value: 'washing', label: 'Washing' },
        { value: 'done', label: 'Done' },
      ],
    });
  });

  test('read as home.var.key — or a place role’s — written back the same, and checked against the home’s', () => {
    for (const text of ['home.var.guests', 'cabin.var.dryerRuns >= 3']) {
      const parsed = parseExpr(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(printExpr(parsed.expr)).toBe(text);
    }
    const rule = (key: string): Rule => ({ roles: {}, params: { fields: {} }, when: [{ every: { value: 5, unit: 'min' } }], then: [{ count: { key } }], otherwise: [] }) as Rule;
    const vocabulary = { fn: () => null, variables: () => [RUNS, GUESTS] };
    expect(checkRule(rule('dryerRuns'), vocabulary)).toEqual([]);
    expect(checkRule(rule('guests'), vocabulary).join(' ')).toContain('counter');
    expect(checkRule(rule('nothing'), vocabulary).join(' ')).toContain('nothing');
  });
});
