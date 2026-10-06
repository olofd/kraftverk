import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AutomationRun, AutomationView, DeviceView } from '@kraftverk/api-contract';
import { inlineParams, type RoleBinding, type Rule } from '@kraftverk/automation';
import { automationId, savedDeviceId, type AutomationId, type Value } from '@kraftverk/device-sdk';

import { aHome, refusal, settle, type TestHome } from './a-home.ts';

/*
  Automations (docs/AUTOMATIONS.md, docs/AUTOMATION-EDITOR.md), asked of the
  home as the app's editor asks: recipes copied into rules of their own,
  drafts said as they are built, made only watching, let act only when a
  person says yes, played, chained and placed on the home page. A station,
  a plug and a forecast of the tests' own, simulated (`kinds.ts`); the
  forecast's package brings a recipe of its own.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

type Roles = Record<string, { device: string; part: string }>;
const whole = (device: { id: string }) => ({ device: device.id, part: 'main' });
const bound = (roles: Roles): Record<string, RoleBinding> => Object.fromEntries(Object.entries(roles).map(([role, binding]) => [role, { device: savedDeviceId(binding.device), part: binding.part }]));

/** A recipe copied into a rule of the automation's own, its settings written into its blocks — as the app does. */
const copy = async (recipe: string, params: Record<string, Value> = {}): Promise<Rule> => inlineParams((await t.home.automations.kit()).recipes.find((one) => one.id === recipe)!.rule, params);
const create = async (name: string, recipe: string, roles: Roles, params: Record<string, Value> = {}, extra: { recheckMinutes?: number } = {}) =>
  t.home.automations.create({ name, rule: await copy(recipe, params), roles: bound(roles), starts: {}, madeFrom: recipe, timeZone: 'Europe/Stockholm', ...extra });

/** A forecast and a plug, simulated: what "if tomorrow is sunny, turn the plug on" needs. */
const forecastAndPlug = async (): Promise<{ weather: DeviceView; plug: DeviceView }> => ({
  weather: await t.added('Weather', { typeId: 'test.forecast' }),
  plug: await t.added('Heater plug', { typeId: 'test.plug' }),
});
const make = (roles: Roles) => create('Sunny heater', 'test.forecast.forecast-switch', roles, { day: 'tomorrow', at: '07:00' });

/** Lets it act on its own, confirmed. */
const arm = async (id: AutomationId) => {
  const asked = await refusal(t.home.automations.update(id, { mode: 'act' }));
  return t.home.automations.update(id, { mode: 'act', confirmation: asked.needsConfirmation! });
};

/** Waits for its run to end, and answers it as the list shows it. */
const ended = async (id: AutomationId): Promise<AutomationRun> => {
  for (let waited = 0; waited < 20_000; waited += 100) {
    await settle(100);
    const now = (await t.home.automations.list()).find((one) => one.id === id)!;
    if (!now.running && now.lastRun) return now.lastRun;
  }
  throw new Error('The run never ended');
};

const stationAndScooterPlug = async () => ({
  station: await t.added('Garage station', { typeId: 'test.station' }),
  plug: await t.added('Scooter plug', { typeId: 'test.plug' }),
});

describe('automations', () => {
  test('lists the recipes to start from — the shared ones and those the installed packages bring — each with its rule, and where it came from', async () => {
    const { recipes } = await t.home.automations.kit();
    expect(recipes.map((recipe) => recipe.id).sort()).toEqual([
      'standard.charge-between',
      'standard.cheap-hours',
      'standard.low-battery',
      'standard.mains-lost',
      'standard.start-charging',
      'standard.stop-charging',
      'test.forecast.forecast-switch',
    ]);
    expect(recipes.find((recipe) => recipe.id === 'test.forecast.forecast-switch')).toMatchObject({
      from: { typeId: 'test.forecast', name: 'Test forecast' },
      rule: { roles: { forecast: expect.objectContaining({ capabilities: ['weather.forecast'] }) }, params: { fields: expect.objectContaining({ day: expect.anything() }) } },
    });
    expect(recipes.find((recipe) => recipe.id === 'standard.low-battery')).toMatchObject({ from: null });
  });

  /*
    A charge window of your own: the plug that feeds a station's mains input
    on when the station stays below 15 %, off when it reaches 50 %.
  */
  test('a station and the plug that feeds it make a charge window of your own', async () => {
    const station = await t.added('Garage station', { typeId: 'test.station' });
    const plug = await t.added('Charger plug', { typeId: 'test.plug' });
    await t.home.links.add({ kind: 'feeds', source: whole(plug), target: { device: station.id, part: 'input.ac' } });
    const window = await create('Charge between 15 and 50 %', 'standard.charge-between', { battery: whole(station), charger: whole(plug) }, { low: 15, lowFor: 120, high: 50, highFor: 0 });
    expect(window).toMatchObject({
      mode: 'watch',
      problems: [],
      madeFrom: { id: 'standard.charge-between', label: 'Charge between two levels' },
      sentence:
        'When Garage station’s charge is below 15 % for 2 min, turn Charger plug on; when Garage station’s charge is at least 50 %, turn Charger plug off.',
    });
    expect((await t.home.automations.check(window.id)).saw.join(' ')).toContain('Garage station: Charge');
    // Its card says how each condition stands now, and what it read to say so.
    expect(window.now.conditions.map((condition) => condition.text)).toEqual(['Garage station’s charge is below 15 % for 2 min', 'Garage station’s charge is at least 50 %']);

    // It can keep things so; a time of day and an event have nothing to keep.
    const { recipes } = await t.home.automations.kit();
    expect(recipes.find((recipe) => recipe.id === 'standard.charge-between')?.hasConditions).toBe(true);
    expect(recipes.find((recipe) => recipe.id === 'standard.mains-lost')?.hasConditions).toBe(false);
    expect(window.recheckMinutes).toBeNull();
    expect((await t.home.automations.update(window.id, { recheckMinutes: 10 })).recheckMinutes).toBe(10);

    // Let act, how often it keeps things so changes what it does: confirmed, as letting it act is.
    expect((await arm(window.id)).mode).toBe('act');
    const refused = await refusal(t.home.automations.update(window.id, { recheckMinutes: 5 }));
    expect(refused.kind).toBe('needs-yes');
    expect((await t.home.automations.update(window.id, { recheckMinutes: 5, confirmation: refused.needsConfirmation! })).recheckMinutes).toBe(5);
    // The same again changes nothing, and asks nothing.
    expect((await t.home.automations.update(window.id, { recheckMinutes: 5 })).recheckMinutes).toBe(5);

    // A new name is not a new start: what it did stands, and it does not run again for it.
    const runs = async () =>
      (await t.home.timeline()).filter((entry) => entry.resource === window.id && !['automation.changed', 'automation.let-act', 'automation.created'].includes(entry.kind)).length;
    await settle();
    const before = await runs();
    await t.home.automations.update(window.id, { name: 'Charge window, renamed' });
    await settle();
    expect(await runs()).toBe(before);
    // Let act at 80 %, it switched the plug off on its own: that run waits for the station to see its mains go, and writes down how it went.
    await settle(500);
  });

  test('the shared recipes, on a station: a battery that runs low, and mains that goes — each a part that fits', async () => {
    const station = await t.added('Garage station', { typeId: 'test.station' });
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const low = await create('Charge when low', 'standard.low-battery', { battery: whole(station), switch: whole(plug) });
    expect(low).toMatchObject({ problems: [], sentence: 'When Garage station’s charge is below 20 % for 5 min, turn Heater plug on.' });

    const shed = (part: string) => create('Shed the heater', 'standard.mains-lost', { input: { device: station.id, part }, switch: whole(plug) });
    // Only the part that says when mains is lost can fill the role.
    expect((await refusal(shed('main'))).kind).toBe('invalid');
    expect(await shed('input.ac')).toMatchObject({ problems: [], sentence: 'When Garage station — Mains reports mains lost, turn Heater plug off.' });
  });

  test('a role takes only a device that fits it', async () => {
    const { weather, plug } = await forecastAndPlug();
    const wrong = await refusal(make({ forecast: whole(plug), switch: whole(weather) }));
    expect(wrong.kind).toBe('invalid');
    expect(wrong.message).toContain('cannot do that');
  });

  test('a draft is checked and said as it is built — every problem at once — and nothing is kept', async () => {
    const { weather, plug } = await forecastAndPlug();
    const rule = await copy('test.forecast.forecast-switch', { day: 'tomorrow', at: '07:00' });
    const draft = (given: { rule?: Rule; roles?: Roles }) => t.home.automations.draft({ rule: given.rule ?? rule, roles: bound(given.roles ?? {}), starts: {} });

    const empty = await draft({});
    expect(empty.problems).toEqual(['Forecast: choose one of your devices', 'What to switch: choose one of your devices']);
    // Said with its roles by their labels, as words in the sentence, until they are filled.
    expect(empty.steps.map((line) => line.text)).toEqual(['Turn what to switch on']);

    const filled = await draft({ roles: { forecast: whole(weather), switch: whole(plug) } });
    expect(filled).toMatchObject({ problems: [], when: ['Every day at 07:00'], names: { forecast: 'Weather', switch: 'Heater plug' } });
    expect(filled.sentence).toStartWith('Every day at 07:00, if ');

    // Its own settings are its blocks: a rule with settings is no automation's.
    expect((await draft({ rule: { ...rule, params: { fields: { x: { type: 'number', title: 'X' } } } }, roles: { forecast: whole(weather), switch: whole(plug) } })).problems).toEqual([
      'An automation has no settings of its own: its values are in its blocks',
    ]);
    // Not a rule at all: said so, and nothing else.
    expect(await draft({ rule: { then: 'nothing' } as unknown as Rule })).toMatchObject({ problems: ['That is not a rule: it needs roles, settings, triggers and steps'], steps: [] });
    expect(await t.home.automations.list()).toEqual([]);
  });

  test('is made only watching on its own, says what it does, and is let act only when confirmed', async () => {
    const { weather, plug } = await forecastAndPlug();
    const created = await make({ forecast: whole(weather), switch: whole(plug) });
    expect(created).toMatchObject({ mode: 'watch', problems: [], homePlace: null, madeFrom: { id: 'test.forecast.forecast-switch' } });

    const unconfirmed = await refusal(t.home.automations.update(created.id, { mode: 'act' }));
    expect(unconfirmed.kind).toBe('needs-yes');
    expect(unconfirmed.needsConfirmation).toEqual(expect.any(String));
    expect((await refusal(t.home.automations.update(created.id, { mode: 'act', confirmation: 'confirm' }))).kind).toBe('needs-yes');
    const asked = await refusal(t.home.automations.update(created.id, { mode: 'act' }));
    // A yes to letting it act is not one to letting it act with another rule.
    const other = { rule: await copy('test.forecast.forecast-switch', { day: 'today', at: '09:00' }), roles: bound({ forecast: whole(weather), switch: whole(plug) }), starts: {} };
    expect((await refusal(t.home.automations.update(created.id, { mode: 'act', ...other, confirmation: asked.needsConfirmation! }))).kind).toBe('needs-yes');
    expect((await arm(created.id)).mode).toBe('act');
    // Changing what one that acts does is confirmed again; a rule comes with what fills its roles.
    expect((await refusal(t.home.automations.update(created.id, other))).kind).toBe('needs-yes');
    expect((await refusal(t.home.automations.update(created.id, { rule: other.rule }))).kind).toBe('invalid');

    expect((await t.home.timeline()).find((entry) => entry.kind === 'automation.let-act')).toMatchObject({ actor: 'olof' });
  });

  test('played, it runs now — for real, though it only watches on its own — takes its steps as it goes, and its runs are listed', async () => {
    const { station, plug } = await stationAndScooterPlug();
    const roles = { supply: { device: station.id, part: 'outlet.ac' }, charger: whole(plug) };
    const params = { reachSeconds: 20, withinSeconds: 10, offSeconds: 3, tries: 1 };
    // A sequence is started, not kept so.
    expect((await refusal(create('Start charging the scooter', 'standard.start-charging', roles, params, { recheckMinutes: 10 }))).kind).toBe('invalid');
    const created = await create('Start charging the scooter', 'standard.start-charging', roles, params);
    expect(created).toMatchObject({ mode: 'watch', takesSteps: true, running: null, lastRun: null, when: [] });
    expect(created.steps.map((step) => step.text)).toEqual([
      'Turn Garage station — AC outlets on',
      'Wait until Scooter plug can be reached — at most 20 s',
      'Turn Scooter plug on',
      'Make sure Scooter plug’s power is above 50 W within 10 s — if not, try again, at most once',
    ]);

    const started = await t.home.automations.start(created.id);
    expect(started.running).toMatchObject({ outcome: 'running', startedBy: 'olof', why: 'Started by olof', startedByRun: null });
    const run = await ended(created.id);
    expect(run).toMatchObject({ outcome: 'acted' });
    // Simulated, the outlet and the plug may be on already: "already so" is as good as done.
    expect(run.steps.map((step) => `${step.kind} ${step.outcome.replace('already', 'done')}`)).toEqual(['command done', 'waitUntil met', 'command done', 'ensure met']);
    expect(await t.home.automations.runs(created.id)).toHaveLength(1);
    // Asked of either device, it is among those its page lists.
    expect((await t.home.automations.list({ device: plug.id })).map((one) => one.id)).toEqual([created.id]);
    const notRunning = await refusal(t.home.automations.stop(created.id));
    expect([notRunning.kind, notRunning.message]).toEqual(['conflict', 'It is not running']);
    expect((await t.home.timeline()).map((entry) => entry.kind)).toEqual(expect.arrayContaining(['automation.started', 'automation.acted']));

    // Off is off: nobody plays it.
    await t.home.automations.update(created.id, { mode: 'off' });
    expect((await refusal(t.home.automations.start(created.id))).kind).toBe('conflict');
  }, 30_000);

  test('each says which others change the parts it changes', async () => {
    const { station, plug } = await stationAndScooterPlug();
    const roles = { supply: { device: station.id, part: 'outlet.ac' }, charger: whole(plug) };
    const start = await create('Start charging the scooter', 'standard.start-charging', roles, { reachSeconds: 20, withinSeconds: 10, tries: 1 });
    const stop = await create('Stop charging the scooter', 'standard.stop-charging', roles);
    expect(stop.sharedWith).toEqual([{ id: start.id, name: 'Start charging the scooter', parts: ['Garage station — AC outlets', 'Scooter plug'] }]);
    const again = (await t.home.automations.list()).find((one) => one.id === start.id)!;
    expect(again.sharedWith.map((other) => other.id)).toEqual([stop.id]);
  });

  test('one automation is read on its own, for its page — and one that is not there says so', async () => {
    const { station, plug } = await stationAndScooterPlug();
    const made = await create('Start charging the scooter', 'standard.start-charging', { supply: { device: station.id, part: 'outlet.ac' }, charger: whole(plug) });
    expect(await t.home.automations.get(made.id)).toMatchObject({ id: made.id, name: 'Start charging the scooter', takesSteps: true, running: null });
    expect((await refusal(t.home.automations.get(automationId('a-000000000000')))).kind).toBe('not-found');
  });

  test('one starts another: a chain that would come back to itself is refused, and one whose other is deleted says so', async () => {
    const { station, plug } = await stationAndScooterPlug();
    const charge = await create('Start charging the scooter', 'standard.start-charging', { supply: { device: station.id, part: 'outlet.ac' }, charger: whole(plug) }, { reachSeconds: 20, withinSeconds: 10, tries: 1 });
    const role = { charging: { automation: true as const, label: 'The charging', description: 'What charges the scooter' } };
    const morning = await t.home.automations.create({
      name: 'Morning',
      rule: { roles: role, params: { fields: {} }, when: [], then: [{ start: { role: 'charging', andWait: { value: 60 } } }] },
      roles: {},
      starts: { charging: charge.id },
      timeZone: 'Europe/Stockholm',
    });
    expect(morning).toMatchObject({ madeFrom: null, starts: { charging: charge.id }, names: { charging: '“Start charging the scooter”' } });
    expect(morning.steps.map((step) => step.text)).toEqual(['Start “Start charging the scooter” and wait until it ends — at most 1 min']);

    // Played: the other runs as its step, and says which run started it.
    await t.home.automations.start(morning.id);
    expect((await ended(morning.id)).outcome).toBe('acted');
    const [child] = await t.home.automations.runs(charge.id);
    expect(child).toMatchObject({ outcome: 'acted', startedBy: 'olof', startedByRun: { automationId: morning.id, name: 'Morning' } });

    // The other made to start this one back: refused, as a chain that would start itself.
    const back = { rule: { roles: role, params: { fields: {} }, when: [], then: [{ start: { role: 'charging' } }] } as Rule, roles: {}, starts: { charging: morning.id } };
    expect((await t.home.automations.draft(back, charge.id)).problems).toEqual(['Starting “Start charging the scooter” would come back to it: a chain may not start itself']);
    expect((await refusal(t.home.automations.update(charge.id, back))).kind).toBe('invalid');

    // Deleted, the one that started it has nothing to start, and says so.
    await t.home.automations.delete(charge.id);
    const [left] = await t.home.automations.list();
    expect(left).toMatchObject({ id: morning.id, starts: {}, problems: ['The charging: nothing to start — the automation it started is gone'] });
  }, 30_000);

  test('on the home page, in their places: put there, moved, taken off — the others closing up', async () => {
    const { weather, plug } = await forecastAndPlug();
    const ids: AutomationId[] = [];
    for (const name of ['One', 'Two', 'Three']) ids.push((await create(name, 'test.forecast.forecast-switch', { forecast: whole(weather), switch: whole(plug) }, { day: 'tomorrow' })).id);
    const place = (id: AutomationId, homePlace: number | null) => t.home.automations.update(id, { homePlace });
    const onHome = (all: AutomationView[]) =>
      all
        .filter((one) => one.homePlace !== null)
        .sort((a, b) => a.homePlace! - b.homePlace!)
        .map((one) => one.name);
    await place(ids[0]!, 0);
    await place(ids[1]!, 1);
    expect(onHome(await t.home.automations.list())).toEqual(['One', 'Two']);
    // First among them: the others move along.
    expect((await place(ids[2]!, 0)).homePlace).toBe(0);
    expect(onHome(await t.home.automations.list())).toEqual(['Three', 'One', 'Two']);
    await place(ids[0]!, null);
    expect(onHome(await t.home.automations.list())).toEqual(['Three', 'Two']);
    // Deleted, the rest close up behind it.
    await t.home.automations.delete(ids[2]!);
    expect((await t.home.automations.list()).find((one) => one.name === 'Two')?.homePlace).toBe(0);
    // Its place is no change to what it does: it asks nothing, even when it acts.
    await arm(ids[1]!);
    expect((await place(ids[1]!, null)).homePlace).toBeNull();
  });

  test('checks what it would do now without doing it, and is deleted', async () => {
    const { weather, plug } = await forecastAndPlug();
    const created = await make({ forecast: whole(weather), switch: whole(plug) });
    expect(['would-act', 'idle']).toContain((await t.home.automations.check(created.id)).outcome);
    // Read on its own, for its page — checking it changed nothing.
    expect(await t.home.automations.get(created.id)).toMatchObject({ id: created.id, lastRun: null });
    await t.home.automations.delete(created.id);
    expect(await t.home.automations.list()).toEqual([]);
    expect((await refusal(t.home.automations.delete(created.id))).kind).toBe('not-found');
  });

  test('one outlet of a station fills the switch role, and only a part it has that can switch', async () => {
    const weather = await t.added('Weather', { typeId: 'test.forecast' });
    const station = await t.added('Garage station', { typeId: 'test.station' });
    const withPart = (part: string) => create('Sunny lights', 'test.forecast.forecast-switch', { forecast: whole(weather), switch: { device: station.id, part } }, { day: 'today' });

    expect((await refusal(withPart('main'))).message).toContain('cannot do that');
    expect((await refusal(withPart('outlet.garage-door'))).message).toContain('has no part');
    expect((await withPart('outlet.dc')).sentence).toContain('Garage station — 12V DC / car port');
  });

  test('says when a device it uses has been removed', async () => {
    const { weather, plug } = await forecastAndPlug();
    await make({ forecast: whole(weather), switch: whole(plug) });
    await t.home.devices.remove(plug.id);
    const [automation] = await t.home.automations.list();
    expect(automation!.problems).toEqual(['What to switch: Heater plug has been removed']);
  });
});
