import { describe, expect, test } from 'bun:test';

import type { DeviceDescription } from '@kraftverk/device-sdk';

import { checkBinding, checkRule, problemArea, problemPlace, writtenAttribute, type BoundPart } from './check.ts';
import { daysText, describeRule, describeSteps, describeTriggers } from './describe.ts';
import { inlineParams } from './evaluate.ts';
import { ruleUses, takesSteps } from './reads.ts';
import { chargeBetween, mainsLost, startCharging } from './recipes.ts';
import type { Rule, Step, WriteTarget } from './rule.ts';

/*
  The blocks a person builds an automation from (docs/AUTOMATION-EDITOR.md):
  the language's steps, and two more — change a setting, start another
  automation — timers on chosen days, and a recipe's settings written into
  the copy its owner edits.
*/

const NO_FUNCTIONS = { fn: () => null };

/** A plug with a setting it may be told, one it only reports, and one that can harm it. */
const PLUG: DeviceDescription = {
  attributes: [
    { key: 'relay', label: 'Switch', value: { type: 'boolean' }, means: 'on' },
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' },
    { key: 'live', label: 'Live readings', value: { type: 'boolean' }, access: 'write' },
    { key: 'light', label: 'Light', value: { type: 'enum', options: [{ value: 'none', label: 'Off' }, { value: 'relay', label: 'With the switch' }] }, access: 'write' },
    { key: 'countdown', label: 'Countdown', value: { type: 'number', unit: 's' } },
    { key: 'firmwareMode', label: 'Firmware mode', value: { type: 'boolean' }, access: 'write', dangerous: true },
  ],
};

/** A station with settings every station has, by their standard meanings: its own keys are its package's. */
const STATION: DeviceDescription = {
  parts: [{ id: 'main', label: 'Station', kind: 'device', energy: { role: 'storage' } }],
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%' }, means: 'charge' },
    { key: 'acLimit', label: 'AC charge limit', value: { type: 'number', unit: '%', min: 60, max: 100 }, means: 'chargeLimit', access: 'write' },
    { key: 'acWatts', label: 'AC charging power', value: { type: 'number', unit: 'W', min: 600, max: 1800, step: 300 }, means: 'mainsInputLimit', access: 'write' },
  ],
};

const bound = (role: string): BoundPart | null =>
  role === 'plug'
    ? { name: 'Scooter plug', description: PLUG, part: 'main', capabilities: ['switch', 'powerMeter'] }
    : role === 'station'
      ? { name: 'Garage station', description: STATION, part: 'main', capabilities: ['battery'] }
      : null;

const vocabulary = { ...NO_FUNCTIONS, attribute: (role: string, target: WriteTarget) => { const part = bound(role); return part ? writtenAttribute(part.description, part.part, target) : null; } };

const names = (role: string) => (role === 'plug' ? 'Scooter plug' : role === 'station' ? 'Garage station' : role === 'charging' ? '“Charge the scooter”' : role);

const rule = (then: Step[], extra: Partial<Rule> = {}): Rule => ({
  roles: {
    plug: { label: 'Plug', description: 'A plug', capabilities: ['switch', 'powerMeter'] },
    station: { label: 'Station', description: 'A station', capabilities: ['battery'] },
    charging: { automation: true, label: 'Charging', description: 'The charging sequence' },
  },
  params: { fields: {} },
  when: [],
  then,
  ...extra,
});

const live = (value: unknown): Step => ({ write: { role: 'plug', key: 'live', value: { value: value as never } } });

describe('change a setting', () => {
  test('is checked when bound: a setting the part has, may be told, and cannot harm it — with a value that fits', () => {
    expect(checkRule(rule([live(true)]), NO_FUNCTIONS)).toEqual([]);
    expect(checkBinding(rule([live(true)]), bound)).toEqual([]);
    expect(checkBinding(rule([{ write: { role: 'plug', key: 'nothing', value: { value: 1 } } }]), bound)).toEqual(['Plug: Scooter plug has no setting "nothing"']);
    expect(checkBinding(rule([{ write: { role: 'plug', key: 'countdown', value: { value: 60 } } }]), bound)).toEqual(['Plug: Countdown of Scooter plug is read, not set']);
    expect(checkBinding(rule([{ write: { role: 'plug', key: 'firmwareMode', value: { value: true } } }]), bound)).toEqual([
      'Plug: Firmware mode of Scooter plug can harm it, and is never changed by an automation',
    ]);
    expect(checkBinding(rule([live('yes')]), bound)).toEqual(['Plug: Live readings must be true or false']);
  });

  test('is a part’s, never an automation’s, and needs a setting', () => {
    expect(checkRule(rule([{ write: { role: 'charging', key: 'live', value: { value: true } } }]), NO_FUNCTIONS)).toEqual(['then[0].write.role: charging is an automation, not a part of a device']);
    expect(checkRule(rule([{ write: { role: 'plug', key: ' ', value: { value: true } } }]), NO_FUNCTIONS)).toEqual(['then[0].write.key: which setting?']);
  });

  test('reads as its device says it: the setting’s own name, the value in its words', () => {
    const { steps } = describeSteps(rule([live(true), { write: { role: 'plug', key: 'light', value: { value: 'relay' } } }]), {}, names, vocabulary);
    expect(steps.map((line) => [line.kind, line.text])).toEqual([
      ['write', 'Set Scooter plug’s Live readings to on'],
      ['write', 'Set Scooter plug’s Light to With the switch'],
    ]);
    // Not bound yet: by its key.
    expect(describeSteps(rule([live(false)]), {}, names).steps[0]!.text).toBe('Set Scooter plug’s live to off');
  });

  test('is done at once, as a command is: a rule of settings and commands takes no steps', () => {
    expect(takesSteps(rule([live(true)]))).toBe(false);
    expect(ruleUses(rule([live(true)])).writes).toEqual([{ role: 'plug', key: 'live', value: { value: true } }]);
  });
});

describe('start another automation', () => {
  test('starts an automation’s role, and may wait for it — bounded, and only where waiting may fail the run', () => {
    expect(checkRule(rule([{ start: { role: 'charging' } }]), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(rule([{ start: { role: 'charging', andWait: { value: 300 } } }]), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(rule([{ start: { role: 'plug' } }]), NO_FUNCTIONS)).toEqual(['then[0].start.role: plug is a part of a device, not an automation']);
    expect(checkRule(rule([{ start: { role: 'charging', andWait: { value: 7200 } } }]), NO_FUNCTIONS)).toEqual(['then[0].start.andWait: from 1 s to 1 h']);
    expect(checkRule(rule([live(true)], { otherwise: [{ start: { role: 'charging', andWait: { value: 60 } } }] }), NO_FUNCTIONS)).toEqual([
      'otherwise[0].start: nothing here may wait for what might not come: it is started, not waited for',
    ]);
    // Started, not waited for: allowed after a failure.
    expect(checkRule(rule([live(true)], { otherwise: [{ start: { role: 'charging' } }] }), NO_FUNCTIONS)).toEqual([]);
  });

  test('an automation is started, never read, asked or switched', () => {
    expect(checkRule(rule([{ command: { role: 'charging', capability: 'switch', command: 'set', args: { on: { value: true } } } }]), NO_FUNCTIONS)).toContain(
      'then[0].command: charging is an automation, not a part of a device'
    );
    expect(checkRule(rule([live(true)], { if: { reachable: 'charging' } }), NO_FUNCTIONS)).toEqual(['if: charging is an automation, not a part of a device']);
  });

  test('takes steps, reads as it does, and its role is no device’s to bind', () => {
    const chain = rule([{ start: { role: 'charging', andWait: { value: 300 } } }]);
    expect(takesSteps(chain)).toBe(true);
    expect(ruleUses(chain).starts).toEqual(['charging']);
    expect(describeSteps(chain, {}, names).steps[0]).toEqual({ kind: 'start', text: 'Start “Charge the scooter” and wait until it ends — at most 5 min', branches: [] });
    expect(checkBinding(chain, bound)).toEqual([]);
  });
});

describe('its problems, where a person finds them', () => {
  test('the language’s path becomes the step, the trigger or the role it is about', () => {
    const roles = rule([]).roles;
    expect(problemPlace('then[4].write.key: which setting?', { roles })).toBe('Step 5: which setting?');
    expect(problemPlace('then[3].ensure.retry[1].wait.for: from 1 s to 1 h', { roles })).toBe('Step 4, each time, step 2: from 1 s to 1 h');
    expect(problemPlace('then[0].choose.else[0].watch.then[2].command: plug does not ask for x', { roles })).toBe('Step 1, otherwise, step 1, if it stays so, step 3: plug does not ask for x');
    expect(problemPlace('otherwise[1].start: nothing here may wait', { roles })).toBe('If a step does not succeed, step 2: nothing here may wait');
    expect(problemPlace('when[0].days: on no day, it never runs', { roles })).toBe('Trigger 1: on no day, it never runs');
    expect(problemPlace('if: expected a condition, got a number', { roles })).toBe('Only if: expected a condition, got a number');
    expect(problemPlace('roles.plug: it has no label', { roles })).toBe('Plug: it has no label');
    expect(problemPlace('then: it does nothing', { roles })).toBe('What it does: it does nothing');
    // Already words: kept as they are.
    expect(problemPlace('Plug: Scooter plug has no setting "x"', { roles })).toBe('Plug: Scooter plug has no setting "x"');
  });

  test('and which part of the automation it is in, from the same path — never from its words', () => {
    expect(problemArea('roles.plug: it has no label')).toBe('uses');
    expect(problemArea('when[0].days: on no day, it never runs')).toBe('when');
    expect(problemArea('if: expected a condition, got a number')).toBe('onlyIf');
    expect(problemArea('then[3].ensure.retry[1].wait.for: from 1 s to 1 h')).toBe('does');
    expect(problemArea('then: it does nothing')).toBe('does');
    expect(problemArea('otherwise[1].start: nothing here may wait')).toBe('fails');
    expect(problemArea('It would start a chain 4 automations deep')).toBe('other');
  });
});

describe('when it runs', () => {
  test('a time on chosen days: at least one, each once, each a day', () => {
    const at = (days: readonly string[]) => rule([live(true)], { when: [{ at: { value: '07:00' }, days: days as never }] });
    expect(checkRule(at(['mon', 'fri']), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(at([]), NO_FUNCTIONS)).toEqual(['when[0].days: on no day, it never runs']);
    expect(checkRule(at(['mon', 'mon']), NO_FUNCTIONS)).toEqual(['when[0].days: a day is named twice']);
    expect(checkRule(at(['someday']), NO_FUNCTIONS)).toEqual(['when[0].days: "someday" is not a day of the week']);
  });

  test('its days, as a person says them', () => {
    expect(daysText(undefined)).toBe('every day');
    expect(daysText(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('on weekdays');
    expect(daysText(['sun', 'sat'])).toBe('at weekends');
    expect(daysText(['wed', 'mon', 'fri'])).toBe('on Mon, Wed and Fri');
    expect(daysText(['thu'])).toBe('on Thu');
    const weekdays = rule([live(true)], { when: [{ at: { value: '07:00' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }] });
    expect(describeTriggers(weekdays, {}, names)).toEqual(['At 07:00 on weekdays']);
    expect(describeRule(weekdays, {}, names, vocabulary)).toBe('At 07:00 on weekdays, set Scooter plug’s Live readings to on.');
  });

  test('no trigger at all: it is played, or started — and reads as what it does', () => {
    expect(checkRule(rule([live(true)]), NO_FUNCTIONS)).toEqual([]);
    expect(describeTriggers(rule([live(true)]), {}, names)).toEqual([]);
    expect(describeRule(rule([live(true)]), {}, names, vocabulary)).toBe('Set Scooter plug’s Live readings to on.');
  });
});

describe('a recipe, copied', () => {
  test('its settings written into its blocks: plain values, no settings left, and the choice its settings made taken', () => {
    const copy = inlineParams(startCharging, {});
    expect(copy.params).toEqual({ fields: {} });
    expect(checkRule(copy, NO_FUNCTIONS)).toEqual([]);
    expect(JSON.stringify(copy)).not.toContain('"param"');
    // Its defaults, as values: wait up to 120 s for the plug.
    expect(copy.then[1]).toEqual({ waitUntil: { condition: { reachable: 'charger' }, atMost: { value: 120 } } });
    // "If it never starts charging: switch it and its supply off again" is no longer a choice: it is the two steps.
    expect(copy.otherwise).toEqual([
      { command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: false } } } },
      { command: { role: 'supply', capability: 'switch', command: 'set', args: { on: { value: false } } } },
    ]);
    // Chosen otherwise, and nothing is done after a failure: no `otherwise` at all.
    const leaveOn = inlineParams(startCharging, { ifItFails: 'leaveOn', tries: 2 });
    expect(leaveOn.otherwise).toBeUndefined();
    expect((leaveOn.then[3] as Extract<Step, { ensure: unknown }>).ensure.tries).toEqual({ value: 2 });
  });

  test('what its settings alone decide is decided: a check of its own sliders goes, and it reads as what it watches', () => {
    const window = inlineParams(chargeBetween, { low: 15, lowFor: 120, high: 50, highFor: 0 });
    // "Only if 15 is below 50" was the recipe checking its settings: always so, and gone; what is left asks of the run.
    expect(window.if).toEqual({ compare: 'ne', left: { run: 'trigger' }, right: { value: '' } });
    // Its triggers keep their ids; a hold of 0 min is none.
    expect(window.when).toEqual([
      { id: 'low', becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'charge' } }, right: { value: 15 } }, heldFor: { value: 120 } },
      { id: 'high', becomes: { compare: 'ge', left: { read: { role: 'battery', means: 'charge' } }, right: { value: 50 } } },
    ]);
    const names = (role: string) => (role === 'battery' ? 'Garage P280' : 'ATORCH plug');
    expect(describeRule(window, {}, names, NO_FUNCTIONS)).toBe(
      'When Garage P280’s charge is below 15 % for 2 min, or when Garage P280’s charge is at least 50 %, if one of its triggers started it, turn ATORCH plug on if it started because Garage P280’s charge is below 15 % for 2 min, off if not.'
    );
    // Settings that can never hold: kept as they are, so it says so rather than acting.
    expect(inlineParams(chargeBetween, { low: 60, high: 50 }).if).toEqual({ value: false });
    // An event, as its capability names it — in the sentence as in its triggers.
    const mains = inlineParams(mainsLost, {});
    expect(describeRule(mains, {}, () => 'Garage P280 — Mains', NO_FUNCTIONS)).toBe('When Garage P280 — Mains reports mains lost, turn Garage P280 — Mains off.');
  });

  test('reads as the recipe did with its defaults — a plain number in the unit of what it is compared with', () => {
    const copy = inlineParams(startCharging, {});
    const recipeNames = (role: string) => (role === 'supply' ? 'Garage station — AC outlets' : 'Scooter plug');
    const defaults = Object.fromEntries(Object.entries(startCharging.params.fields).map(([key, field]) => [key, ('default' in field ? field.default : null) as never]));
    expect(describeSteps(copy, {}, recipeNames).steps.map((line) => line.text)).toEqual(describeSteps(startCharging, defaults, recipeNames).steps.map((line) => line.text));
    expect(describeSteps(copy, {}, recipeNames).steps[3]!.text).toStartWith('Make sure Scooter plug’s power is above 50 W within 20 s');
  });
});

/*
  A setting by its standard meaning (docs/PLAN-RUN-AND-CHAIN.md, Phase 4):
  what a recipe names, since it cannot know a product's keys. The part that
  fills the role says which of its settings has the meaning.
*/
describe('change a setting by what it means', () => {
  const limit = (value: unknown): Step => ({ write: { role: 'station', means: 'chargeLimit', value: { value: value as never } } });

  test('checked: a standard meaning — by key or by meaning, not both — and, bound, a setting there that has it', () => {
    expect(checkRule(rule([limit(80)]), NO_FUNCTIONS)).toEqual([]);
    expect(checkRule(rule([{ write: { role: 'station', means: 'station.limit', value: { value: 80 } } }]), NO_FUNCTIONS)).toEqual(['then[0].write.means: "station.limit" is not a standard meaning']);
    expect(checkRule(rule([{ write: { role: 'station', means: 'chargeLimit', key: 'acLimit', value: { value: 80 } } as never }]), NO_FUNCTIONS)).toEqual([
      'then[0].write: a setting by its key or by its meaning, not both',
    ]);
    expect(checkBinding(rule([limit(80)]), bound)).toEqual([]);
    expect(checkBinding(rule([limit(40)]), bound)).toEqual(['Station: AC charge limit must be at least 60']);
    expect(checkBinding(rule([{ write: { role: 'plug', means: 'chargeLimit', value: { value: 80 } } }]), bound)).toEqual(['Plug: Scooter plug has no setting that is its charge limit']);
    // A reading with the meaning is not a setting.
    expect(checkBinding(rule([{ write: { role: 'station', means: 'charge', value: { value: 80 } } }]), bound)).toEqual(['Station: Garage station has no setting that is its charge']);
  });

  test('a value between steps is refused: 600, 900 … 1800 W, never 700', () => {
    const power = (watts: number): Step => ({ write: { role: 'station', means: 'mainsInputLimit', value: { value: watts } } });
    expect(checkBinding(rule([power(1200)]), bound)).toEqual([]);
    expect(checkBinding(rule([power(700)]), bound)).toEqual(['Station: AC charging power must be in steps of 300 from 600']);
  });

  test('reads as the device names it once bound, and as the meaning before', () => {
    expect(describeSteps(rule([limit(80)]), {}, names, vocabulary).steps[0]!.text).toBe('Set Garage station’s AC charge limit to 80 %');
    expect(describeSteps(rule([limit(80)]), {}, (role) => (role === 'station' ? 'the station' : role)).steps[0]!.text).toBe('Set the station’s Charge limit to 80');
  });
});
