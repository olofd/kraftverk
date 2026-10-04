import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';

import { checkRule } from '../check.ts';
import { describeTriggers } from '../describe.ts';
import type { Rule } from '../rule.ts';
import { ruleFromConfig, ruleToConfig } from '../text/rules.ts';
import { fieldSchema } from './schema.ts';
import { fieldValue } from './spec.ts';
import { TRIGGER_KIND_ORDER, TRIGGER_KINDS, triggerKind, type TriggerKind } from './triggers.ts';

/*
  The registry of the language's constructs is whole (docs/PLAN-AUTOMATION-
  LANGUAGE.md, phase A): every kind is described once, completely — its
  words, its mark, its reference page with examples — and each of its
  examples reads, checks, says itself and is written back as it was. A kind
  added with a piece missing fails here, not in front of a person.
*/

const KINDS = Object.keys(TRIGGER_KINDS) as TriggerKind[];

/** An automation's entry around one trigger, its roles filled by made-up parts. */
const entryOf = (trigger: unknown) => ({ uses: { station: 'garage-station', plug: 'smart-plug' }, when: [trigger], do: [{ 'turn on': 'plug' }] });

describe('the triggers, as data', () => {
  test('every kind is offered, once, in the editor’s order', () => {
    expect([...TRIGGER_KIND_ORDER].sort()).toEqual([...KINDS].sort());
  });

  for (const kind of KINDS) {
    const spec = TRIGGER_KINDS[kind] as (typeof TRIGGER_KINDS)[TriggerKind];
    test(`${kind}: described whole — its words, its mark, its page`, () => {
      expect(spec.kind).toBe(kind);
      expect(spec.label.trim()).not.toBe('');
      expect(spec.says.trim()).not.toBe('');
      expect(spec.docs.summary.trim()).not.toBe('');
      expect(spec.docs.examples.length).toBeGreaterThan(0);
      // Its verb is its first field's key, and each key is said once.
      expect(spec.fields[0]?.key).toBe(kind);
      expect(new Set(spec.fields.map((field) => field.key)).size).toBe(spec.fields.length);
      for (const field of spec.fields) expect(fieldSchema(field)).toBeDefined();
    });

    test(`${kind}: one to start from is of its kind, and says itself`, () => {
      const blank = spec.blank();
      expect(triggerKind(blank)).toBe(kind);
      for (const field of spec.fields.filter((each) => each.required)) expect(fieldValue(blank, field)).toBeDefined();
    });

    test(`${kind}: each example reads, checks, says itself, and is written back as it was`, () => {
      for (const example of spec.docs.examples) {
        const written = parse(example) as Record<string, unknown>;
        const read = ruleFromConfig(entryOf(written), []);
        expect({ example, issues: read.issues }).toEqual({ example, issues: [] });
        const rule = read.rule as Rule;
        expect(triggerKind(rule.when[0]!)).toBe(kind);
        // Its roles are what the example names; a part that reports what it reads is the binding's to say.
        expect(checkRule(rule, { fn: () => null }).filter((problem) => problem.startsWith('when'))).toEqual([]);
        expect(describeTriggers(rule, {}, (role) => role)[0]).toMatch(/^[A-Z]/);
        expect(ruleToConfig(rule, read.uses).when).toEqual([written]);
      }
    });
  }
});
