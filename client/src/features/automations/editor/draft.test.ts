import { describe, expect, test } from 'bun:test';

import type { AutomationId, RecipeView, RoleBinding } from '@kraftverk/api-client';
import { checkRule, savedDeviceId, startCharging, type DeviceDescription, type Step } from '@kraftverk/device-sdk';

import { automationRole, blankStep, EMPTY, fromRecipe, insertStep, kindsFor, listAt, mayWait, moveStep, OTHERWISE, partRole, pruned, removeStep, THEN, withStep, within } from './draft';

/*
  The editor's draft, changed the way its screens change it: blocks added,
  nested, moved and removed at any depth; a part picked for a block fills a
  role of its own, once; a recipe copied with its settings written in.
*/

const PLUG: DeviceDescription = {
  parts: [{ id: 'main', label: 'Socket', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'relay', label: 'Switch', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power.draw' },
  ],
};
const plug: RoleBinding = { device: savedDeviceId('d-plug'), part: 'main' };
const pause = (seconds: number): Step => ({ wait: { seconds: { value: seconds } } });

describe('blocks', () => {
  test('added, nested, moved and removed at any depth — the rule the language checks', () => {
    let rule = insertStep(EMPTY.rule, THEN, 0, blankStep('choose', null));
    rule = insertStep(rule, within(THEN, 0, 'then'), 0, pause(5));
    rule = insertStep(rule, within(THEN, 0, 'then'), 1, pause(10));
    rule = moveStep(rule, within(THEN, 0, 'then'), 1, -1);
    expect(listAt(rule, within(THEN, 0, 'then'))).toEqual([pause(10), pause(5)]);
    rule = withStep(rule, within(THEN, 0, 'then'), 0, () => pause(20));
    rule = removeStep(rule, within(THEN, 0, 'then'), 1);
    expect(rule.then).toEqual([{ choose: { if: { value: true }, then: [pause(20)], else: [] } }]);
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
  test('a part picked fills one role, whatever uses it; one nothing uses is not kept', () => {
    const first = partRole(EMPTY, plug, PLUG, 'Scooter plug');
    expect(first.role).toBe('part1');
    expect(first.draft.rule.roles.part1).toEqual({ label: 'Scooter plug', description: 'Scooter plug', capabilities: ['switch', 'powerMeter'] });
    // Picked again, for another block: the same role.
    expect(partRole(first.draft, plug, PLUG, 'Scooter plug').role).toBe('part1');
    const used = { ...first.draft, rule: insertStep(first.draft.rule, THEN, 0, blankStep('command', 'part1')) };
    expect(checkRule(used.rule, { fn: () => null })).toEqual([]);
    expect(pruned(used).roles).toEqual({ part1: plug });
    expect(pruned(first.draft)).toMatchObject({ rule: { roles: {} }, roles: {} });
  });

  test('an automation to start fills a role of its own kind', () => {
    const { draft, role } = automationRole(EMPTY, 'a-charge' as AutomationId, '“Charge the scooter”');
    expect(role).toBe('automation1');
    expect(draft.rule.roles.automation1).toEqual({ automation: true, label: '“Charge the scooter”', description: '“Charge the scooter”' });
    expect(draft.starts).toEqual({ automation1: 'a-charge' });
  });
});

test('a recipe copied: its settings at their defaults, written into its blocks — the owner’s to change', () => {
  const recipe = { id: startCharging.id, label: startCharging.label, rule: startCharging } as unknown as RecipeView;
  const draft = fromRecipe(recipe);
  expect(draft.name).toBe('Start charging');
  expect(draft.rule.params).toEqual({ fields: {} });
  expect(draft.rule.then[1]).toEqual({ waitUntil: { condition: { reachable: 'charger' }, atMostSeconds: { value: 120 } } });
  expect(checkRule(draft.rule, { fn: () => null })).toEqual([]);
});
