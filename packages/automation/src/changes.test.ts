import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { describeTriggers } from './describe.ts';
import type { Rule, Trigger } from './rule.ts';
import { ruleFromConfig, ruleToConfig } from './text/rules.ts';
import type { VariableSpec } from './variables.ts';

/*
  `changes:` (docs/PLAN-VARIABLES-AND-TRIGGERS.md §3.1): when a reading or
  a variable changes — from one value, to another, by at least so much —
  and the run knows what it was and became, run.from and run.to, typed as
  what it watches.
*/

const LAUNDRY: VariableSpec = { key: 'laundry', kind: 'choice', field: { type: 'enum', title: 'Laundry', options: [{ value: 'washing', label: 'Washing' }, { value: 'drying', label: 'Drying' }, { value: 'done', label: 'Done' }] } };
const TARGET: VariableSpec = { key: 'target', kind: 'number', field: { type: 'number', title: 'Target', unit: '°C' } };
const vocabulary = { fn: () => null, variables: () => [LAUNDRY, TARGET] };
const laundry = { variable: { key: 'laundry', at: 'home' } } as const;
const rule = (trigger: Trigger, then: Rule['then'] = [{ setMode: { mode: 'home' } }]): Rule => ({ roles: {}, params: { fields: {} }, when: [trigger], then });

describe('changes', () => {
  test('in a file: what it watches, and words written plainly as words — back as written', () => {
    const read = ruleFromConfig({ when: [{ changes: 'home.var.laundry', from: 'washing', to: 'drying' }], do: [{ 'set mode': 'home' }] }, ['a']);
    expect(read.issues).toEqual([]);
    expect(read.rule!.when[0]).toEqual({ changes: laundry, from: { value: 'washing' }, to: { value: 'drying' } });
    expect(ruleToConfig(read.rule!, {}).when).toEqual([{ changes: 'home.var.laundry', from: 'washing', to: 'drying' }]);
    const power = ruleFromConfig({ when: [{ changes: 'home.var.target', 'by at least': '0.5 °C' }], do: [] }, ['a']);
    expect(power.rule!.when[0]).toEqual({ changes: { variable: { key: 'target', at: 'home' } }, byAtLeast: { value: 0.5, unit: '°C' } });
    // Words that would read as yes are kept as words.
    expect(ruleToConfig(rule({ changes: laundry, to: { value: 'true' } }), {}).when).toEqual([{ changes: 'home.var.laundry', to: '"true"' }]);
  });

  test('said in the words of what it watches', () => {
    expect(describeTriggers(rule({ changes: laundry, from: { value: 'washing' }, to: { value: 'done' } }), {}, () => '', vocabulary)).toEqual(['When “Laundry” changes from “Washing” to “Done”']);
    expect(describeTriggers(rule({ changes: { variable: { key: 'target', at: 'home' } }, byAtLeast: { value: 0.5 } }), {}, () => '', vocabulary)).toEqual(['When “Target” changes by at least 0.5 °C']);
  });

  test('checked: from and to of its kind, by at least only for a number — and run.from, run.to as what it watches', () => {
    expect(checkRule(rule({ changes: laundry, to: { value: 'done' } }), vocabulary)).toEqual([]);
    expect(checkRule(rule({ changes: laundry, to: { value: 3 } }), vocabulary).join(' ')).toContain('when[0].to: it changes as');
    expect(checkRule(rule({ changes: laundry, byAtLeast: { value: 1 } }), vocabulary)).toEqual(['when[0].byAtLeast: only a number moves by so much — this is a string']);
    expect(checkRule(rule({ changes: { variable: { key: 'target', at: 'home' } }, byAtLeast: { value: 0 } }), vocabulary)).toEqual(['when[0].byAtLeast: more than nought']);
    const told = (expr: string) => rule({ changes: laundry }, [{ notify: { to: 'everyone', title: expr } }]);
    expect(checkRule(told('From {run.from} to {run.to}'), vocabulary)).toEqual([]);
    const withoutChange: Rule = { roles: {}, params: { fields: {} }, when: [{ every: { value: 60, unit: 's' } }], then: [{ notify: { to: 'everyone', title: 'Now {run.to}' } }] };
    expect(checkRule(withoutChange, vocabulary).join(' ')).toContain('run.to is what a change became, but nothing that starts this is a change');
  });
});
