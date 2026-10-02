import type { PolicyValueName } from '@kraftverk/device-sdk';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';


import { aHome, refusal, type TestHome } from './a-home.ts';

/* What the home decides that declarations name — how much is a load worth confirming — asked of the home. */

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

describe('what the home decides', () => {
  test('how much is a load is set here, bounded, audited, and put back with null', async () => {
    expect(await t.home.policy.list()).toContainEqual(expect.objectContaining({ name: 'loadWatts', value: 5, default: 5, unit: 'W' }));

    expect(await t.home.policy.set('loadWatts', 12)).toContainEqual(expect.objectContaining({ name: 'loadWatts', value: 12 }));
    expect((await refusal(t.home.policy.set('loadWatts', -1))).kind).toBe('invalid');
    expect((await refusal(t.home.policy.set('nothing' as PolicyValueName, 1))).kind).toBe('not-found');
    expect((await t.home.timeline()).find((entry) => entry.kind === 'policy.changed')?.summary).toBe('A load worth confirming: now 12 W');

    expect(await t.home.policy.set('loadWatts', null)).toContainEqual(expect.objectContaining({ name: 'loadWatts', value: 5 }));
  });
});
