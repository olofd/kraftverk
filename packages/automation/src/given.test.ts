import { describe, expect, test } from 'bun:test';

import { checkRule, checkStarted } from './check.ts';
import { describeSteps } from './describe.ts';
import type { Expr, Rule } from './rule.ts';
import { parseExpr, printExpr } from './text/expr.ts';
import { ruleFromConfig, ruleToConfig } from './text/rules.ts';

/*
  An automation as a function: what a run may be given (`inputs`, read as
  `given.level`), what it answers (`result`, an `answer` step) — and the
  `start` step that gives it values and remembers its answer, held to both
  sides where both are known.
*/

const parse = (text: string): Expr => {
  const parsed = parseExpr(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};
const check = (rule: Rule) => checkRule(rule, { fn: () => null });

/** What charges to a level, and answers the charge it reached. */
const CHARGE = {
  inputs: { level: { title: 'Charge to', value: '80 %', min: '20 %', max: '100 %' } },
  result: { title: 'Charge reached', value: '0 %' },
  uses: { station: 'garage-station', charger: 'charger-plug' },
  do: [{ 'turn on': 'charger' }, { 'wait until': 'station.charge >= given.level', 'at most': '1 h' }, { 'turn off': 'charger' }, { answer: 'station.charge' }],
};

/** What starts it, giving a level and remembering the answer. */
const MORNING = {
  memory: { reached: '0 %' },
  uses: { charge: { automation: 'charge' } },
  do: [{ start: 'charge', with: { level: '90 %' }, 'and wait': '1 h', 'remember as': 'reached' }],
};

describe('as a file writes it', () => {
  test('given.level, read and written back; an input named so a role called "input" still reads', () => {
    expect(parse('given.level')).toEqual({ input: 'level' });
    expect(printExpr(parse('station.charge >= given.level'))).toBe('station.charge >= given.level');
    expect(parse('input.voltage')).toEqual({ read: { role: 'input', means: 'voltage' } });
  });

  test('inputs, a result, an answer — and a start giving values and remembering the answer — read and written back as they were', () => {
    for (const entry of [CHARGE, MORNING]) {
      const read = ruleFromConfig(entry, ['automations', 0]);
      expect(read.issues).toEqual([]);
      expect(check(read.rule!)).toEqual([]);
      const written = ruleToConfig(read.rule!, read.uses);
      expect(ruleFromConfig(written as unknown as Record<string, unknown>, []).rule).toEqual(read.rule);
    }
    const charge = ruleFromConfig(CHARGE, []).rule!;
    expect(charge.inputs).toEqual({ fields: { level: { type: 'number', title: 'Charge to', unit: '%', min: 20, max: 100, default: 80 } } });
    expect(charge.result).toEqual({ type: 'number', title: 'Charge reached', unit: '%', default: 0 });
    const morning = ruleFromConfig(MORNING, []).rule!;
    expect(morning.then).toEqual([{ start: { role: 'charge', args: { level: { value: 90, unit: '%' } }, andWait: { value: 1, unit: 'h' }, remember: 'reached' } }]);
  });

  test('said as a person would', () => {
    const charge = ruleFromConfig(CHARGE, []).rule!;
    const names = (role: string) => (role === 'station' ? 'Garage station' : role === 'charger' ? 'Charger plug' : '“Charge”');
    expect(describeSteps(charge, {}, names).steps.map((line) => line.text).slice(1)).toEqual(['Wait until Garage station’s charge is at least the level it was given — at most 1 h', 'Turn Charger plug off', 'Answer Garage station’s charge']);
    expect(describeSteps(ruleFromConfig(MORNING, []).rule!, {}, names).steps[0]!.text).toBe('Start “Charge” with level 90 % and wait until it ends — at most 1 h, remembering what it answers as reached');
  });
});

describe('held to what it is, before it runs', () => {
  test('an input it takes; an answer of the kind it answers; what is remembered of a start, waited for', () => {
    const charge = ruleFromConfig(CHARGE, []).rule!;
    expect(check({ ...charge, then: [{ answer: parse('given.speed') }] })).toEqual(['then[0].answer: it takes no input called "speed"']);
    expect(check({ ...charge, then: [{ answer: parse('50 W') }] })).toEqual(['then[0].answer: Charge reached is a number in %, not a number in W']);
    const { result: _result, ...answersNothing } = charge;
    expect(check({ ...answersNothing, then: [{ answer: parse('station.charge') }] })).toEqual(['then[0].answer: it answers nothing — say what it answers under result']);
    const morning = ruleFromConfig(MORNING, []).rule!;
    expect(check({ ...morning, then: [{ start: { role: 'charge', remember: 'reached' } }] })).toEqual(['then[0].start.remember: what it answers is known once it ends — wait for it ("and wait")']);
  });

  test('a start held to the inputs and result of the automation it starts', () => {
    const charge = ruleFromConfig(CHARGE, []).rule!;
    const morning = ruleFromConfig(MORNING, []).rule!;
    expect(checkStarted(morning, 'charge', charge)).toEqual([]);
    const starting = (step: Record<string, unknown>) => ruleFromConfig({ ...MORNING, do: [{ start: 'charge', 'and wait': '1 h', ...step }] }, []).rule!;
    expect(checkStarted(starting({ with: { speed: '2 kW' } }), 'charge', charge)).toEqual(['Charge: it takes no input "speed" — it takes level']);
    expect(checkStarted(starting({ with: { level: '10 %' } }), 'charge', charge)).toEqual(['Charge: Charge to must be at least 20']);
    expect(checkStarted(starting({ with: { level: '2 kW' } }), 'charge', charge)).toEqual(['Charge: Charge to is in %, not kW']);
    const { result: _result, ...answersNothing } = charge;
    expect(checkStarted(starting({ 'remember as': 'reached' }), 'charge', answersNothing)).toEqual(['Charge: it answers nothing to remember']);
  });
});
