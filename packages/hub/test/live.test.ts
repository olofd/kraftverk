import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { LiveUpdate } from '@kraftverk/api-contract';
import { inlineParams, startCharging } from '@kraftverk/automation';
import { savedDeviceId } from '@kraftverk/device-sdk';

import { aHome, settle, type TestHome } from './a-home.ts';

/*
  What changed, as it changes (docs/API.md, the live stream), asked of the
  home in the process: what says a list is to be read again, and what says
  only itself. The socket that carries it is the server's (app.test.ts).
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

/** Waits for what a test expects to come true, a little at a time. */
const until = async (check: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await settle(25);
  }
};

describe('the live stream', () => {
  test('only what changes a list of devices says so: an automation says itself, a policy value and a setup step nothing', async () => {
    const updates: LiveUpdate[] = [];
    const stream = t.home.live((update) => void updates.push(update));
    try {
      expect(updates[0]!.type).toBe('hello');
      const plug = await t.added('Heater plug', { typeId: 'test.plug' });
      await until(() => updates.some((update) => update.type === 'changed'));
      // Past the stream's flush: what follows is said on its own.
      await settle(300);

      let before = updates.length;
      await t.home.policy.set('loadWatts', 25);
      await t.home.setup.start({ typeId: 'test.station', methodId: 'simulated' });
      await settle(300);
      expect(updates.slice(before).filter((update) => update.type === 'changed' || update.type === 'automation')).toEqual([]);

      const station = await t.added('Garage station', { typeId: 'test.station' });
      await settle(300);
      before = updates.length;
      const created = await t.home.automations.create({
        name: 'Start charging',
        rule: inlineParams(startCharging, {}),
        roles: { supply: { device: savedDeviceId(station.id), part: 'outlet.ac' }, charger: { device: savedDeviceId(plug.id), part: 'main' } },
        starts: {},
        timeZone: 'Europe/Stockholm',
      });
      await until(() => updates.slice(before).some((update) => update.type === 'automation' && update.id === created.id));
      await settle(300);
      expect(updates.slice(before).some((update) => update.type === 'changed')).toBe(false);

      // A link changes what a device's page shows: the list is read again.
      before = updates.length;
      await t.home.links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: station.id, part: 'input.ac' } });
      await until(() => updates.slice(before).some((update) => update.type === 'changed'));
    } finally {
      stream.close();
    }
  });
});
