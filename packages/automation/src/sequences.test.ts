import { describe, expect, test } from 'bun:test';

import { checkRule } from './check.ts';
import { describeRule, describeSteps, describeTriggers, whose } from './describe.ts';
import { evaluateNow, settledChoice, type RuleScope } from './evaluate.ts';
import { ruleCommands, ruleUses, takesSteps } from './reads.ts';
import { chargeBetween, startCharging, stopCharging } from './recipes.ts';
import { SEQUENCE_LIMITS, type Rule, type Step } from './rule.ts';

/**
 * Sequences in the rule language (docs/SEQUENCES.md): steps that wait, make
 * sure, choose and watch — checked before they run, and read back as a list a
 * person can follow.
 */

const NO_FUNCTIONS = { fn: () => null };

const names = (role: string) => (role === 'supply' ? 'Garage station’s AC outlets' : role === 'charger' ? 'Scooter plug' : role);

const defaults = (rule: Rule) => Object.fromEntries(Object.entries(rule.params.fields).map(([key, field]) => [key, 'default' in field ? (field.default as never) : null]));

/** A rule of one switch, with the steps given. */
const rule = (then: Step[], extra: Partial<Rule> = {}): Rule => ({
  roles: { plug: { label: 'Plug', description: 'A plug', capabilities: ['switch', 'powerMeter'] } },
  params: { fields: { seconds: { type: 'number', title: 'Seconds', unit: 's', min: 1, max: 60, default: 5 } } },
  when: [],
  then,
  ...extra,
});

const on: Step = { command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } };

const drawing: Rule['if'] = { compare: 'gt', left: { read: { role: 'plug', means: 'power.draw' } }, right: { value: 50 } };

describe('the language', () => {
  test('starting and stopping a charge are sequences it checks clean: no trigger of their own — played, or started — taking steps', () => {
    for (const recipe of [startCharging, stopCharging]) {
      expect(checkRule(recipe, NO_FUNCTIONS)).toEqual([]);
      expect(recipe.when).toEqual([]);
      expect(takesSteps(recipe)).toBe(true);
    }
    // A rule of commands alone does everything at once, as before.
    expect(takesSteps(chargeBetween)).toBe(false);
  });

  test('every wait has a limit and every retry a count: literal or setting, held to them', () => {
    expect(checkRule(rule([{ wait: { seconds: { value: SEQUENCE_LIMITS.waitSeconds + 1 } } }]), NO_FUNCTIONS)).toEqual(['then[0].wait.seconds: a pause of between 1 and 3600']);
    expect(checkRule(rule([{ ensure: { condition: drawing!, withinSeconds: { value: 20 }, tries: { value: 11 }, retry: [on] } }]), NO_FUNCTIONS)).toEqual(['then[0].ensure.tries: tries between 1 and 10']);
    // A setting with no maximum could be anything its form accepts.
    const unbounded = rule([{ wait: { seconds: { param: 'long' } } }], { params: { fields: { long: { type: 'number', title: 'Long', unit: 's', min: 1 } } } });
    expect(checkRule(unbounded, NO_FUNCTIONS)).toEqual(['then[0].wait.seconds: the setting "long" must be held to a pause of between 1 and 3600']);
    // Minutes are not seconds.
    const minutes = rule([{ wait: { seconds: { param: 'm' } } }], { params: { fields: { m: { type: 'number', title: 'M', unit: 'min', min: 1, max: 5 } } } });
    expect(checkRule(minutes, NO_FUNCTIONS)).toEqual(['then[0].wait.seconds: expected a number of seconds, got a number in min']);
  });

  test('what might not come is waited for only where failing is allowed: not in a retry, not in what runs after a failure', () => {
    const waits: Step = { waitUntil: { condition: { reachable: 'plug' }, atMostSeconds: { value: 60 } } };
    expect(checkRule(rule([on], { otherwise: [waits] }), NO_FUNCTIONS)).toEqual(['otherwise[0]: nothing here may wait for a condition that might not come: it would fail again']);
    expect(checkRule(rule([{ ensure: { condition: drawing!, withinSeconds: { value: 20 }, tries: { value: 3 }, retry: [waits] } }]), NO_FUNCTIONS)).toEqual([
      'then[0].ensure.retry[0]: nothing here may wait for a condition that might not come: it would fail again',
    ]);
    // In a choice within `then`, it may.
    expect(checkRule(rule([{ choose: { if: { reachable: 'plug' }, then: [on], else: [waits] } }]), NO_FUNCTIONS)).toEqual([]);
  });

  test('conditions are conditions, of roles it has; a choice or a watch does something; steps nest only so deep', () => {
    expect(checkRule(rule([{ waitUntil: { condition: { read: { role: 'plug', means: 'power.draw' } }, atMostSeconds: { value: 5 } } }]), NO_FUNCTIONS)).toEqual([
      'then[0].waitUntil.condition: expected a condition, got a number in W',
    ]);
    expect(checkRule(rule([{ waitUntil: { condition: { reachable: 'lamp' }, atMostSeconds: { value: 5 } } }]), NO_FUNCTIONS)).toEqual(['then[0].waitUntil.condition: there is no role "lamp"']);
    expect(checkRule(rule([{ watch: { condition: drawing!, seconds: { value: 5 } } }]), NO_FUNCTIONS)).toEqual(['then[0].watch: it does nothing either way']);
    const nest = (depth: number): Step => ({ choose: { if: { reachable: 'plug' }, then: [depth <= 1 ? on : nest(depth - 1)] } });
    expect(checkRule(rule([nest(SEQUENCE_LIMITS.depth - 1)]), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(rule([nest(SEQUENCE_LIMITS.depth)]), NO_FUNCTIONS)).toEqual([`then[0].choose.then[0].choose.then[0].choose.then[0].choose.then: steps within steps, more than ${SEQUENCE_LIMITS.depth} deep`]);
  });

  test('says what it reads, whose reach it asks about, and every command it may send', () => {
    const uses = ruleUses(startCharging);
    expect(uses.reaches).toEqual(['charger']);
    expect(uses.reads).toContainEqual({ role: 'charger', means: 'power.draw' });
    // Supply on, charger on; each retry off and on; if it fails, both off.
    expect(ruleCommands(startCharging).map((command) => `${command.role} ${JSON.stringify(command.args.on)}`)).toEqual([
      'supply {"value":true}',
      'charger {"value":true}',
      'charger {"value":false}',
      'charger {"value":true}',
      'charger {"value":false}',
      'supply {"value":false}',
    ]);
  });

  test('can be reached is its holder’s word: yes or no, never unknown — and says why not', () => {
    const scope = (reachable: boolean): RuleScope => ({ param: () => null, read: () => null, reachable: () => ({ reachable, detail: 'Its gateway cannot reach it' }), name: names, clock: () => '12:00' });
    const trace: string[] = [];
    expect(evaluateNow({ reachable: 'charger' }, scope(false), trace)).toBe(false);
    expect(trace).toEqual(['Scooter plug: cannot be reached (Its gateway cannot reach it)']);
    expect(evaluateNow({ not: { reachable: 'charger' } }, scope(true))).toBe(false);
  });
});

describe('read back', () => {
  test('starting a charge, as numbered steps, with what it does if a step does not succeed', () => {
    const { steps, otherwise } = describeSteps(startCharging, defaults(startCharging), names);
    const flat = (lines: typeof steps): unknown[] => lines.map((line) => (line.branches.length ? [line.text, line.branches.map((branch) => [branch.label, flat(branch.steps)])] : line.text));
    expect(flat(steps)).toEqual([
      'Turn Garage station’s AC outlets on',
      'Wait until Scooter plug can be reached — at most 2 min',
      'Turn Scooter plug on',
      ["Make sure Scooter plug’s power is above 50 W within 20 s — if not, try again, at most 5 times", [['Each time', ['Turn Scooter plug off', 'Wait 5 s', 'Turn Scooter plug on']]]],
    ]);
    // What its owner chose is no step: the steps it chose, in its place.
    expect(flat(otherwise)).toEqual(['Turn Scooter plug off', 'Turn Garage station’s AC outlets off']);
    expect(describeTriggers(startCharging, defaults(startCharging), names)).toEqual([]);
  });

  test('a choice its settings decide reads as what it chose; one left on does nothing if it fails', () => {
    const leftOn = { ...defaults(startCharging), ifItFails: 'leaveOn' };
    expect(describeSteps(startCharging, leftOn, names).otherwise).toEqual([]);
    // A choice that turns on what is read is still a step.
    const reading: Rule = { ...stopCharging, then: [{ choose: { if: { compare: 'gt', left: { read: { role: 'supply', means: 'power.draw' } }, right: { value: 10 } }, then: [{ command: { role: 'supply', capability: 'switch', command: 'set', args: { on: { value: false } } } }] } }] };
    expect(describeSteps(reading, defaults(stopCharging), names).steps.map((line) => line.text)).toEqual(['If the power of Garage station’s AC outlets is above 10 W']);
    expect(settledChoice(startCharging, startCharging.otherwise![0] as Extract<Step, { choose: unknown }>, leftOn)).toEqual([]);
  });

  test('something of a part, as English says it', () => {
    expect(whose('Garage P280', 'charge')).toBe('Garage P280’s charge');
    expect(whose('Garage P280 — AC outlets', 'power')).toBe('Garage P280 — AC outlets’ power');
    expect(whose('what powers the charger', 'power')).toBe('the power of what powers the charger');
    expect(whose('the charger’s plug', 'power')).toBe('the power of the charger’s plug');
  });

  test('stopping a charge, in one sentence: the plug off, then the supply only if nothing else draws', () => {
    expect(describeRule(stopCharging, defaults(stopCharging), names)).toBe(
      "Turn Scooter plug off, then watch whether the power of Garage station’s AC outlets is below 10 W, and if it stays so turn Garage station’s AC outlets off."
    );
    const { steps } = describeSteps(stopCharging, defaults(stopCharging), names);
    expect(steps[1]).toEqual({
      kind: 'watch',
      text: "Watch for 5 s whether the power of Garage station’s AC outlets is below 10 W",
      branches: [{ label: 'If it stays so', steps: [{ kind: 'command', text: 'Turn Garage station’s AC outlets off', branches: [] }] }],
    });
  });
});
