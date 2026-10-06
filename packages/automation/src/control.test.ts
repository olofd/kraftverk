import { describe, expect, test } from 'bun:test';

import { checkBinding, checkRule } from './check.ts';
import { describeRule, describeSteps } from './describe.ts';
import { kindsFor, OTHERWISE, THEN, within } from './edit.ts';
import { inlineParams } from './evaluate.ts';
import { changedRoles, eachAsGroup, ruleUses } from './reads.ts';
import { SEQUENCE_LIMITS, type Expr, type Rule, type Step } from './rule.ts';
import { parseExpr } from './text/expr.ts';
import { ruleFromConfig, ruleToConfig } from './text/rules.ts';

/*
  How a run goes, beyond one step after another: steps repeated, tried, a
  run ended where it is, an event waited for — each held to its limits before
  it runs, and said in words.
*/

const roles: Rule['roles'] = { station: { label: 'Station', capabilities: ['acInput'] }, charger: { label: 'Charger', capabilities: ['switch', 'powerMeter'] } };
const rule = (then: readonly Step[], otherwise?: readonly Step[]): Rule => ({ roles, params: { fields: {} }, when: [{ at: { value: '07:00' } }], then, ...(otherwise ? { otherwise } : {}) });
const check = (checked: Rule) => checkRule(checked, { fn: () => null });
const on: Step = { command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: true } } } };
const read = (entry: Record<string, unknown>): Rule => {
  const got = ruleFromConfig({ uses: { station: 'garage-station.input.ac', charger: 'charger-plug' }, when: [{ at: '07:00' }], ...entry }, []);
  expect(got.issues).toEqual([]);
  return got.rule!;
};

describe('held to their limits before they run', () => {
  test('a repeat is so many rounds, never more than the language allows, and never a reading', () => {
    expect(check(rule([{ repeat: { times: { value: 3 }, steps: [on] } }]))).toEqual([]);
    expect(check(rule([{ repeat: { times: { value: SEQUENCE_LIMITS.rounds + 1 }, steps: [on] } }]))).toEqual([`then[0].repeat.times: from 1 to ${SEQUENCE_LIMITS.rounds}`]);
    expect(check(rule([{ repeat: { times: { read: { role: 'charger', means: 'power' } }, steps: [on] } }]))).toContainEqual(expect.stringContaining('a number or a setting, not one read or worked out'));
    expect(check(rule([{ repeat: { times: { value: 3 }, steps: [] } }]))).toEqual(['then[0].repeat.steps: what does it repeat?']);
  });

  test('what a try takes after a failure waits for nothing that might not come — it would fail again', () => {
    const wait: Step = { waitUntil: { condition: { reachable: 'charger' }, atMost: { value: 60, unit: 's' } } };
    expect(check(rule([{ try: { steps: [wait], recover: [on] } }]))).toEqual([]);
    expect(check(rule([{ try: { steps: [on], recover: [wait] } }]))).toEqual(['then[0].try.recover[0]: nothing here may wait for a condition that might not come: it would fail again']);
    expect(kindsFor(within(THEN, 0, 'recover'))).not.toContain('waitFor');
    expect(kindsFor(within(THEN, 0, 'steps'))).toContain('waitFor');
  });

  test('a stop says why; an event waited for is one the part raises, and not after a failure', () => {
    expect(check(rule([{ stop: { why: ' ' } }]))).toEqual(['then[0].stop.why: say it in words']);
    const waitFor: Step = { waitFor: { role: 'station', event: 'mains.restored', atMost: { value: 30, unit: 'min' } } };
    expect(check(rule([waitFor]))).toEqual([]);
    expect(check(rule([on], [waitFor]))).toEqual(['otherwise[0]: nothing here may wait for a condition that might not come: it would fail again']);
    expect(kindsFor(OTHERWISE)).not.toContain('waitFor');
    expect(ruleUses(rule([waitFor]))).toMatchObject({ events: [], awaits: [{ role: 'station', event: 'mains.restored' }] });
    const station = {
      name: 'Garage station',
      part: 'input.ac',
      capabilities: ['acInput'],
      description: { parts: [{ id: 'input.ac', label: 'Mains', kind: 'input', offers: ['acInput'] }], attributes: [], events: [{ id: 'mains.lost', label: 'Mains lost', level: 'warn', part: 'input.ac' }] },
    };
    const charger = { name: 'Charger', part: 'main', capabilities: ['switch', 'powerMeter'], description: { parts: [{ id: 'main', label: 'Charger', kind: 'outlet', offers: ['switch', 'powerMeter'] }], attributes: [] } };
    const bound = (role: string) => [(role === 'station' ? station : charger) as never];
    expect(checkBinding(rule([waitFor]), bound)).toEqual(['Station: Garage station never says "mains.restored"']);
  });
});

describe('for each part of a group', () => {
  const groupRoles: Rule['roles'] = { chargers: { group: true, label: 'Chargers', capabilities: ['switch', 'powerMeter'] } };
  const forEach = (steps: readonly Step[], as = 'charger', group = 'chargers'): Step => ({ forEach: { as, in: group, steps } });
  const turnOn = (role: string): Step => ({ command: { role, capability: 'switch', command: 'set', args: { on: { value: true } } } });
  const grouped = (then: readonly Step[]): Rule => ({ roles: groupRoles, params: { fields: {} }, when: [], then });
  const parse = (text: string): Expr => {
    const parsed = parseExpr(text);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.expr;
  };

  test('within its steps, its name is each part — a role of one; outside them, the group is several parts', () => {
    expect(check(grouped([forEach([turnOn('charger'), { waitUntil: { condition: parse('charger.power > 10 W'), atMost: { value: 1, unit: 'min' } } }])]))).toEqual([]);
    expect(check(grouped([turnOn('chargers')]))).toEqual(['then[0].command.role: chargers is several parts — name each in turn with "for each"']);
    expect(check(grouped([forEach([turnOn('charger')]), turnOn('charger')]))).toEqual(['then[1].command.role: there is no role "charger"']);
    expect(check(grouped([forEach([turnOn('chargers')], 'chargers')]))).toEqual([
      'then[0].forEach.as: "chargers" names something already — call each part otherwise',
      'then[0].forEach.steps[0].command.role: chargers is several parts — name each in turn with "for each"',
    ]);
    expect(check({ ...grouped([forEach([turnOn('charger')], 'charger', 'plug')]), roles: { ...groupRoles, plug: { label: 'Plug', capabilities: ['switch'] } } })).toContainEqual('then[0].forEach.in: plug is one part, not several');
    expect(check(grouped([forEach([])]))).toEqual(['then[0].forEach.steps: what does it do with each?']);
  });

  test('written as a list of parts, its needs read from what is done to each, and read back as it was', () => {
    const entry = { uses: { chargers: ['garage-plug', 'garage-station.outlet.ac'] }, do: [{ 'for each': 'charger', in: 'chargers', together: true, do: [{ 'turn on': 'charger' }, { 'wait until': 'charger.power > 10 W', 'at most': '1 min' }] }] };
    const read = ruleFromConfig({ when: [{ at: '07:00' }], ...entry }, []);
    expect(read.issues).toEqual([]);
    expect(read.rule!.roles.chargers).toEqual({ group: true, label: 'Chargers', capabilities: ['powerMeter', 'switch'] });
    expect(read.uses.chargers).toEqual({ parts: [{ device: 'garage-plug', part: 'main' }, { device: 'garage-station', part: 'outlet.ac' }] });
    const written = ruleToConfig(read.rule!, read.uses);
    expect(written.uses).toEqual(entry.uses);
    expect(written.do).toEqual(entry.do);
    // The long form: its label, and what each must offer.
    expect(ruleFromConfig({ when: [{ at: '07:00' }], uses: { chargers: { parts: ['garage-plug'], label: 'My chargers' } }, do: entry.do }, []).rule!.roles.chargers).toMatchObject({ group: true, label: 'My chargers' });
  });

  test('what is done to each is done to the group: read, sent, held — and every part bound is held to it', () => {
    const rule = grouped([forEach([turnOn('charger'), { choose: { if: parse('charger.power > 10 W'), then: [] } }])]);
    expect(eachAsGroup(rule).then).toEqual([forEach([turnOn('chargers'), { choose: { if: parse('chargers.power > 10 W'), then: [] } }])]);
    expect(ruleUses(rule)).toMatchObject({ reads: [{ role: 'chargers', means: 'power' }], groups: ['chargers'] });
    expect(changedRoles(rule)).toEqual(['chargers']);
    const plug = (name: string, offers: readonly string[]) => ({ name, part: 'main', capabilities: offers, description: { parts: [{ id: 'main', label: name, kind: 'outlet', offers }], attributes: [{ key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' }] } }) as never;
    expect(checkBinding(rule, () => [plug('Garage plug', ['switch', 'powerMeter']), plug('Scooter plug', ['switch', 'powerMeter'])])).toEqual([]);
    expect(checkBinding(rule, () => [plug('Garage plug', ['switch', 'powerMeter']), plug('Lamp', ['switch'])])).toEqual(['Chargers: Lamp cannot do that']);
    expect(checkBinding(rule, () => [])).toEqual(['Chargers: no device']);
  });

  test('said as each of its parts — one after the other, or all at the same time', () => {
    const name = (role: string) => (role === 'chargers' ? 'Garage plug and Scooter plug' : role);
    const lines = describeSteps(grouped([{ forEach: { as: 'charger', in: 'chargers', together: true, steps: [turnOn('charger')] } }]), {}, name).steps;
    expect(lines[0]!.text).toBe('For each of Garage plug and Scooter plug, all at the same time');
    expect(lines[0]!.branches).toEqual([{ label: 'For each', steps: [{ kind: 'command', text: 'Turn each charger on', branches: [] }] }]);
    expect(describeRule({ ...grouped([forEach([turnOn('charger')])]), when: [{ at: { value: '07:00' } }] }, {}, name)).toBe('Every day at 07:00, turn each charger on, for each of Garage plug and Scooter plug.');
  });
});

describe('started again while it runs', () => {
  test('written as one of its ways, read back so; letting it go is the way when none is written', () => {
    const restarting = read({ 'while running': 'restart', do: [{ 'turn on': 'charger' }] });
    expect(restarting.whileRunning).toBe('restart');
    expect(ruleToConfig(restarting, {})['while running']).toBe('restart');
    // Kept as a recipe's copy is made.
    expect(inlineParams(restarting, {}).whileRunning).toBe('restart');
    expect(read({ 'while running': 'skip', do: [{ 'turn on': 'charger' }] }).whileRunning).toBeUndefined();
    const wrong = ruleFromConfig({ when: [{ at: '07:00' }], 'while running': 'twice', do: [] }, ['automations', 0]);
    expect(wrong.issues).toEqual([{ message: 'Expected one of skip, restart, queue', path: ['automations', 0, 'while running'] }]);
    expect(check({ ...rule([on]), whileRunning: 'twice' as never })).toEqual(['whileRunning: "twice" is none of skip, restart, queue']);
  });
});

describe('as a file writes them, and as they read', () => {
  test('repeat, until, try, if it fails, stop, wait for', () => {
    const written = read({
      do: [
        { repeat: 5, until: 'charger.power > 50 W', do: [{ 'turn on': 'charger' }, { wait: '20 s' }] },
        { try: [{ 'wait for': 'mains.restored', from: 'station', 'at most': '30 min' }], 'if it fails': [{ stop: 'The mains did not come back', failed: true }] },
        { stop: 'Charging' },
      ],
    });
    expect(written.then).toEqual([
      { repeat: { times: { value: 5 }, until: { compare: 'gt', left: { read: { role: 'charger', means: 'power' } }, right: { value: 50, unit: 'W' } }, steps: [on, { wait: { for: { value: 20, unit: 's' } } }] } },
      { try: { steps: [{ waitFor: { role: 'station', event: 'mains.restored', atMost: { value: 30, unit: 'min' } } }], recover: [{ stop: { why: 'The mains did not come back', failed: true } }] } },
      { stop: { why: 'Charging' } },
    ]);
    expect(check(written)).toEqual([]);
    const lines = describeSteps(written, {}, (role) => (role === 'charger' ? 'Charger plug' : 'Garage station')).steps;
    expect(lines.map((line) => line.text)).toEqual(['Repeat until Charger plug’s power is above 50 W — at most 5 times', 'Try — and if a step does not succeed, take others', 'Stop here: Charging']);
    expect(lines[0]!.branches.map((branch) => branch.label)).toEqual(['Each round']);
    expect(lines[1]!.branches).toEqual([
      { label: 'Try', steps: [{ kind: 'waitFor', text: 'Wait until Garage station says mains back — at most 30 min', branches: [] }] },
      { label: 'If it fails', steps: [{ kind: 'stop', text: 'Stop, not having succeeded: The mains did not come back', branches: [] }] },
    ]);
  });
});
