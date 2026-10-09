import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Caller, KraftverkApi } from '@kraftverk/api-contract';
import { inlineParams } from '@kraftverk/automation';
import { savedDeviceId } from '@kraftverk/device-sdk';

import { GATES } from '../src/api/gate.ts';
import { aHome, refusal, type TestHome } from './a-home.ts';

/*
  The gate every call of a home passes (src/api/gate.ts): each method of
  the interface decided once, the whole-method refusals held there and not
  in the methods, and a yes a person's alone.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

const ASSISTANT: Caller = { kind: 'agent', for: 'olof' };

/** Every path to a call of an API as it was built: what the gate must decide. */
const pathsOf = (node: object, prefix = ''): string[] =>
  Object.entries(node).flatMap(([key, value]) => (typeof value === 'function' ? [`${prefix}${key}`] : pathsOf(value as object, `${prefix}${key}.`)));

describe('the gate', () => {
  test('decides every call a home answers, and no call it does not', () => {
    const built: KraftverkApi = t.hub.as({ kind: 'person', name: 'olof' });
    expect(pathsOf(built).sort()).toEqual(Object.keys(GATES).sort());
  });

  test('reads leave everything as it was: whatever lists, gets or shows is a read', () => {
    for (const [path, gate] of Object.entries(GATES)) {
      const verb = path.split('.').at(-1)!;
      if (/^(list|get|of|history|kit|vocabulary|schema)$/.test(verb)) expect(gate.kind, path).toBe('read');
      if (/^(add|remove|update|set|delete|create|forget|save|command|write)$/.test(verb)) expect(gate.kind, path).toBe('act');
    }
  });

  test('refuses an assistant what is a person’s, in words, before anything is done', async () => {
    const asked = t.as(ASSISTANT);
    const zone = await refusal(asked.zones.add({ name: 'Work', location: { latitude: 51.5, longitude: 0, radius: 200 } }));
    expect(zone).toMatchObject({ kind: 'forbidden', message: 'An assistant cannot change the family’s zones' });
    expect(await t.home.zones.list()).toEqual([]);
    expect((await refusal(asked.people.invite({ role: 'member', needsApproval: false }))).message).toBe('An assistant cannot change who is in the family');
    expect((await refusal(asked.people.setSharing('p-nobody', { level: 'off' }))).message).toBe('An assistant cannot change what anyone shares');
  });

  test('an assistant reads and acts where it may', async () => {
    const asked = t.as(ASSISTANT);
    expect(await asked.zones.list()).toEqual([]);
    expect((await asked.homes.list()).length).toBeGreaterThan(0);
  });

  test('a yes is a person’s: an assistant never sends one, and is never handed the token for one', async () => {
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const asked = t.as(ASSISTANT);
    const sent = await refusal(asked.devices.command(plug.id, 'main', 'switch', 'set', { args: { on: false }, confirmation: 'a-token' }));
    expect(sent).toMatchObject({ kind: 'forbidden', message: 'Only a person can say yes to this, in the app' });

    const weather = await t.added('Weather', { typeId: 'test.forecast' });
    const recipe = (await t.home.automations.kit()).recipes.find((one) => one.id === 'test.forecast.forecast-switch')!;
    const made = await t.home.automations.create({
      name: 'Sunny heater',
      rule: inlineParams(recipe.rule, { day: 'tomorrow', at: '07:00' }),
      roles: { forecast: { device: savedDeviceId(weather.id), part: 'main' }, switch: { device: savedDeviceId(plug.id), part: 'main' } },
      groups: {},
      starts: {},
      madeFrom: recipe.id,
      timeZone: 'Europe/Stockholm',
    });
    // A person is asked, and given the token their yes comes back with; an assistant is refused.
    expect((await refusal(t.home.automations.update(made.id, { mode: 'act' }))).needsConfirmation).toEqual(expect.any(String));
    const letting = await refusal(asked.automations.update(made.id, { mode: 'act' }));
    expect(letting.kind).toBe('forbidden');
    expect(letting.needsConfirmation).toBeNull();
    expect(letting.message).toEndWith('Only a person can say yes to this, in the app.');
    expect((await t.home.automations.get(made.id)).mode).toBe('watch');
  });
});
