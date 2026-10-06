import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';

import { checkRule } from '../check.ts';
import { describeRule, describeTriggers } from '../describe.ts';
import type { Rule } from '../rule.ts';
import { ruleFromConfig, ruleToConfig } from '../text/rules.ts';
import { fieldSchema } from './schema.ts';
import { parseExpr } from '../text/expr.ts';
import { BUILTIN_ORDER, BUILTINS } from './builtins.ts';
import { ACROSS_FNS, ACROSS_ORDER } from './across.ts';
import { HISTORY_FNS, HISTORY_ORDER } from './history.ts';
import { EXPR_KIND_ORDER, EXPR_KINDS, exprKind, expressionsIn, mapChildren } from './exprs.ts';
import { RULE_PART_DOCS } from './parts.ts';
import { ruleShape } from './shape.ts';
import { fieldValue } from './spec.ts';
import { STEP_KIND_ORDER, STEP_KINDS, stepKind, type StepKind, type StepSpec } from './steps.ts';
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
const entryOf = (trigger: unknown) => ({ uses: { station: 'garage-station', plug: 'smart-plug', charger: 'charger-plug' }, when: [trigger], do: [{ 'turn on': 'plug' }] });

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

const STEPS = Object.keys(STEP_KINDS) as StepKind[];

/** An automation's entry around one step, its roles filled by made-up parts and an automation. */
const doing = (step: unknown) => ({
  uses: { charger: 'charger-plug', station: 'garage-station', plug: 'smart-plug', supply: 'garage-station.outlet.ac', outlets: ['smart-plug', 'garage-station.outlet.ac'], chargeTheScooter: { automation: 'charge-the-scooter' } },
  // What the examples remember: a count, and a reading.
  memory: { timesCharged: 0, lastPower: '0 W' },
  // What the examples answer: a power.
  result: '0 W',
  do: [step],
});

describe('the steps, as data', () => {
  test('every kind is offered, once, in the editor’s order', () => {
    expect([...STEP_KIND_ORDER].sort()).toEqual([...STEPS].sort());
  });

  for (const kind of STEPS) {
    const spec = STEP_KINDS[kind] as unknown as StepSpec;
    test(`${kind}: described whole — its words, its mark, its page`, () => {
      expect(spec.kind).toBe(kind);
      expect(spec.label.trim()).not.toBe('');
      expect(spec.says.trim()).not.toBe('');
      expect(spec.docs.summary.trim()).not.toBe('');
      expect(spec.docs.examples.length).toBeGreaterThan(0);
      expect(new Set(spec.fields.map((field) => field.key)).size).toBe(spec.fields.length);
      for (const field of spec.fields) expect(fieldSchema(field)).toBeDefined();
    });

    test(`${kind}: one to start from is of its kind`, () => {
      expect(stepKind(spec.blank('plug'))).toBe(kind);
      expect(stepKind(spec.blank(null))).toBe(kind);
    });

    test(`${kind}: each example reads, checks, says itself, and reads back as it was written`, () => {
      for (const example of spec.docs.examples) {
        const read = ruleFromConfig(doing(parse(example)), []);
        expect({ example, issues: read.issues }).toEqual({ example, issues: [] });
        const rule = read.rule as Rule;
        expect(stepKind(rule.then[0]!)).toBe(kind);
        expect({ example, problems: checkRule(rule, { fn: () => null }).filter((problem) => problem.startsWith('then')) }).toEqual({ example, problems: [] });
        expect(describeRule(rule, {}, (role) => role)).toMatch(/^[A-Z]/);
        // Written as the file would have it — a command its shortest way — and read back, it is the same step.
        const again = ruleFromConfig(ruleToConfig(rule, read.uses) as unknown as Record<string, unknown>, []);
        expect(again.rule?.then).toEqual(rule.then);
      }
    });
  }

  test('every kind of expression: described, each example read as one that holds it, rebuilt as it was', () => {
    expect([...EXPR_KIND_ORDER].sort() as string[]).toEqual(Object.keys(EXPR_KINDS).sort());
    for (const kind of EXPR_KIND_ORDER) {
      const spec = EXPR_KINDS[kind];
      expect(spec.label.trim()).not.toBe('');
      expect(spec.docs.summary.trim()).not.toBe('');
      for (const example of spec.docs.examples) {
        const parsed = parseExpr(example);
        if (!parsed.ok) throw new Error(`${kind}: ${example}: ${parsed.error.message}`);
        expect({ example, kinds: [...expressionsIn(parsed.expr)].map(exprKind) }).toEqual({ example, kinds: expect.arrayContaining([kind]) });
        // Taken apart by its children and put back, it is what it was.
        expect(mapChildren(parsed.expr, (child) => child)).toEqual(parsed.expr);
      }
    }
  });

  test('every kind of expression has examples; every function of the language, each example a call of it', () => {
    for (const kind of EXPR_KIND_ORDER) expect({ kind, examples: EXPR_KINDS[kind].docs.examples.length > 0 }).toEqual({ kind, examples: true });
    for (const name of BUILTIN_ORDER) {
      const spec = BUILTINS[name];
      expect(spec.docs.examples.length).toBeGreaterThan(0);
      for (const example of spec.docs.examples) {
        const parsed = parseExpr(example);
        if (!parsed.ok) throw new Error(`${name}: ${example}: ${parsed.error.message}`);
        expect({ example, calls: [...expressionsIn(parsed.expr)].some((each) => 'apply' in each && each.apply === name) }).toEqual({ example, calls: true });
      }
    }
  });

  test('every way of taking a group together has examples, each one of its own', () => {
    for (const name of ACROSS_ORDER) {
      const spec = ACROSS_FNS[name];
      expect(spec.docs.examples.length).toBeGreaterThan(0);
      for (const example of spec.docs.examples) {
        const parsed = parseExpr(example);
        if (!parsed.ok) throw new Error(`${name}: ${example}: ${parsed.error.message}`);
        expect({ example, takes: [...expressionsIn(parsed.expr)].some((each) => 'across' in each && each.across === name) }).toEqual({ example, takes: true });
      }
    }
  });

  test('every way of looking back has examples, each a look back of its own', () => {
    for (const name of HISTORY_ORDER) {
      const spec = HISTORY_FNS[name];
      expect(spec.docs.examples.length).toBeGreaterThan(0);
      for (const example of spec.docs.examples) {
        const parsed = parseExpr(example);
        if (!parsed.ok) throw new Error(`${name}: ${example}: ${parsed.error.message}`);
        expect({ example, looks: [...expressionsIn(parsed.expr)].some((each) => 'history' in each && each.history === name) }).toEqual({ example, looks: true });
      }
    }
  });

  test('every part of an automation has its page, and each example is a whole automation that reads, checks and is written back as it was', () => {
    for (const [part, docs] of Object.entries(RULE_PART_DOCS)) {
      expect(docs.summary.trim()).not.toBe('');
      expect(docs.examples.length).toBeGreaterThan(0);
      for (const example of docs.examples) {
        const entry = parse(example) as Record<string, unknown>;
        // Each example is about its own part.
        expect({ part, says: docs.key in entry }).toEqual({ part, says: true });
        const read = ruleFromConfig(entry, []);
        expect({ example, issues: read.issues }).toEqual({ example, issues: [] });
        expect({ example, problems: checkRule(read.rule!, { fn: () => null }) }).toEqual({ example, problems: [] });
        const again = ruleFromConfig(ruleToConfig(read.rule!, read.uses) as unknown as Record<string, unknown>, []);
        expect(again.rule).toEqual(read.rule);
      }
    }
  });

  test('the database knows how rules are kept: every kind and field, and the meanings a reading names, in its fingerprint', () => {
    const shape = ruleShape();
    for (const kind of [...KINDS, ...STEPS]) expect(shape).toContain(`${kind}(`);
    expect(shape).toContain('waitUntil.atMost:duration!');
    // A rule keeps "charge", not its label: renamed, a kept rule would read nothing.
    expect(shape).toMatch(/means .*\bcharge\b/);
  });
});
