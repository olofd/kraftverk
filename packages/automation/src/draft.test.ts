import { describe, expect, test } from 'bun:test';

import { savedDeviceId, type AutomationId, type DeviceDescription } from '@kraftverk/device-sdk';

import { checkRule } from './check.ts';
import { automationRole, draftOfRecipe, EMPTY_DRAFT, partRole, pruned, roleName, sameParts, type RoleBinding } from './draft.ts';
import { blankStep } from './edit.ts';
import { insertStep, kindsFor, listAt, mayWait, moveStep, OTHERWISE, removeStep, THEN, within, withStep } from './edit.ts';
import { startCharging, stopCharging } from './recipes.ts';
import type { Step } from './rule.ts';

/*
  An automation as it is being built, changed the way an editor changes it:
  blocks added, nested, moved and removed at any depth; a part picked for a
  block fills a role of its own, once; a recipe copied with its settings
  written in.
*/

const PLUG: DeviceDescription = {
  parts: [{ id: 'main', label: 'Socket', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'relay', label: 'Switch', value: { type: 'boolean' }, means: 'on' },
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' },
  ],
};

const plug: RoleBinding = { device: savedDeviceId('d-plug'), part: 'main' };

const pause = (seconds: number): Step => ({ wait: { for: { value: seconds, unit: 's' } } });

describe('blocks', () => {
  test('added, nested, moved and removed at any depth — the rule the language checks', () => {
    let rule = insertStep(EMPTY_DRAFT.rule, THEN, 0, blankStep('choose', null));
    rule = insertStep(rule, within(THEN, 0, 'then'), 0, pause(5));
    rule = insertStep(rule, within(THEN, 0, 'then'), 1, pause(10));
    rule = moveStep(rule, within(THEN, 0, 'then'), 1, -1);
    expect(listAt(rule, within(THEN, 0, 'then'))).toEqual([pause(10), pause(5)]);
    rule = withStep(rule, within(THEN, 0, 'then'), 0, () => pause(20));
    rule = removeStep(rule, within(THEN, 0, 'then'), 1);
    // A new choice asks about a reading of a part still to choose: a condition the editor draws, never one only said in words.
    expect(rule.then).toEqual([{ choose: { if: { compare: 'gt', left: { read: { role: '', means: '' } }, right: { value: 0 } }, then: [pause(20)], else: [] } }]);
    // After a failure: the list is there only while it holds a step.
    rule = insertStep(rule, OTHERWISE, 0, pause(1));
    expect(rule.otherwise).toEqual([pause(1)]);
    rule = removeStep(rule, OTHERWISE, 0);
    expect(rule.otherwise).toBeUndefined();
  });

  test('a list offers the kinds it may take: nothing that waits in a retry or after a failure, nothing nested past four', () => {
    expect(kindsFor(THEN)).toContain('waitUntil');
    expect(kindsFor(OTHERWISE)).not.toContain('waitUntil');
    expect(kindsFor(within(THEN, 0, 'retry'))).not.toContain('ensure');
    expect(kindsFor(within(within(within(THEN, 0, 'then'), 0, 'then'), 0, 'then'))).not.toContain('choose');
    expect(mayWait(THEN)).toBe(true);
    expect(mayWait(within(THEN, 0, 'retry'))).toBe(false);
  });
});

describe('roles', () => {
  test('a part picked fills one role, whatever uses it — named and labelled by what it is, not by a name that can change; one nothing uses is not kept', () => {
    const first = partRole(EMPTY_DRAFT, plug, PLUG);
    // Named as a file says it, and its conditions read: switch, not part1.
    expect(first.role).toBe('switch');
    expect(first.draft.rule.roles.switch).toEqual({ label: 'Switch', capabilities: ['powerMeter', 'switch'] });
    // Picked again, for another block: the same role.
    expect(partRole(first.draft, plug, PLUG).role).toBe('switch');
    // Another part of the same kind: switch2.
    expect(partRole(first.draft, { ...plug, device: savedDeviceId('d-other') }, PLUG).role).toBe('switch2');
    const used = { ...first.draft, rule: insertStep(first.draft.rule, THEN, 0, blankStep('command', 'switch')) };
    expect(checkRule(used.rule, { fn: () => null })).toEqual([]);
    expect(pruned(used).roles).toEqual({ switch: plug });
    expect(pruned(first.draft)).toMatchObject({ rule: { roles: {} }, roles: {} });
    // A label with no letters to name it by: part.
    expect(roleName(EMPTY_DRAFT.rule, '42')).toBe('part');
    expect(roleName(EMPTY_DRAFT.rule, 'Laddare för skotern')).toBe('laddareForSkotern');
  });

  test('an automation to start fills a role of its own kind, labelled as what it is', () => {
    const { draft, role } = automationRole(EMPTY_DRAFT, 'a-charge' as AutomationId);
    expect(role).toBe('automation');
    expect(draft.rule.roles.automation).toEqual({ automation: true, label: 'Another automation' });
    expect(draft.starts).toEqual({ automation: 'a-charge' as AutomationId });
    expect(automationRole(draft, 'a-other' as AutomationId).role).toBe('automation2');
  });
});

test('a recipe copied: its settings kept, at the recipe’s values, read in its blocks — the owner’s to set, in one place', () => {
  const draft = draftOfRecipe(startCharging);
  expect(draft.rule.params).toEqual(startCharging.params);
  expect(draft.rule.then[1]).toEqual({ waitUntil: { condition: { reachable: 'charger' }, atMost: { param: 'reachSeconds' } } });
  expect(checkRule(draft.rule, { fn: () => null })).toEqual([]);
  // What a recipe says for whoever fills a role stays with it.
  expect(Object.values(draft.rule.roles).some((role) => 'description' in role)).toBe(false);
});

test('stop after start: the parts another automation uses for the same roles are offered, when they fit', () => {
  const station: RoleBinding = { device: savedDeviceId('d-station'), part: 'ac' };
  const start = { id: 'a-start' as AutomationId, name: 'Start charging the scooter', rule: draftOfRecipe(startCharging).rule, roles: { supply: station, charger: plug } };
  const unrelated = { id: 'a-other' as AutomationId, name: 'Heater', rule: { ...start.rule, roles: { heater: start.rule.roles.charger! } }, roles: { heater: plug } };
  const stop = draftOfRecipe(stopCharging);

  expect(sameParts(stop, [start, unrelated], () => true)).toEqual([{ id: start.id, name: start.name, roles: { supply: station, charger: plug } }]);
  // A part that does not fit here is not offered.
  expect(sameParts(stop, [start], (role) => role !== 'supply')).toEqual([]);
  // Nothing left to choose, nothing offered.
  expect(sameParts({ ...stop, roles: { supply: station, charger: plug } }, [start], () => true)).toEqual([]);
});
