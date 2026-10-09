import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import type { Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';
import { counted, variableFieldOf, variableKeyFrom, variableProblems, variableStart, type VariableSpec } from './variables.ts';

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
