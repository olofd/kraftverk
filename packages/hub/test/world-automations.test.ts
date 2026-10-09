import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AutomationView } from '@kraftverk/api-contract';
import { STANDARD_RECIPES, withSettings, type Rule } from '@kraftverk/automation';

import { aHome, refusal, settle, type TestHome } from './a-home.ts';

/*
  Automating people and places (docs/PLAN-WORLD-MODEL-WORK.md W7): what an
  automation reads and waits for of the family's world — who is at home,
  someone arriving, a room emptying, a home's mode — and what it does
  there: sets a mode, tells people. Presence and occupancy are what their
  services say on the bus; here the test says it, as they would.
*/

const ANNA = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AA';
const BEN = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0BB';

let t: TestHome;
let home: string;

beforeEach(async () => {
  t = await aHome();
  const at = new Date().toISOString();
  for (const [id, name] of [
    [ANNA, 'Anna'],
    [BEN, 'Ben'],
  ] as const) {
    t.hub.people.ensureKeyless(id, name, at);
    t.hub.people.addMember(id, { role: 'member', invitedBy: null, at });
  }
  home = t.hub.places.homes()[0]!.id;
  t.hub.modes.start();
});

afterEach(async () => {
  t.hub.modes.stop();
  await t.stop();
});

/** Someone comes home, or leaves: their stay kept, and said on the bus as presence would. */
const arrives = async (personId: string) => {
  t.hub.stays.begin(personId, { id: home, kind: 'home' }, new Date().toISOString(), null);
  await t.hub.engine.hear({ kind: 'presence', personId, place: { id: home, kind: 'home' }, change: 'arrived', at: new Date().toISOString() });
  await settle();
};
const leaves = async (personId: string) => {
  const stay = t.hub.stays.open(personId).find((each) => each.placeId === home)!;
  t.hub.stays.end(stay.id, new Date(Date.now() + 1).toISOString());
  await t.hub.engine.hear({ kind: 'presence', personId, place: { id: home, kind: 'home' }, change: 'left', at: new Date().toISOString() });
  await settle();
};

const acting = async (rule: Rule, world: AutomationView['world'] = {}, roles: AutomationView['roles'] = {}): Promise<AutomationView> => {
  const made = await t.home.automations.create({ name: 'Test', rule, roles, groups: {}, starts: {}, world, timeZone: 'Europe/Stockholm' });
  // Let act as a person would, with their yes: what letting one act asks is the automations API's own test.
  t.hub.automations.update(made.id, { mode: 'act' });
  return (await t.home.automations.list()).find((each) => each.id === made.id)!;
};

describe('the family’s world, automated', () => {
  test('“when the last one leaves, set away; when one comes back, home” — a recipe, made and acting', async () => {
    const recipe = STANDARD_RECIPES.find((each) => each.id === 'standard.away-when-everyone-leaves')!;
    expect(recipe).toBeDefined();
    await acting(withSettings(recipe as unknown as Rule, {}));
    await arrives(ANNA);
    await arrives(BEN);
    expect(t.hub.modes.now(home, 'presence')).toBe('home');
    await leaves(ANNA);
    expect(t.hub.modes.now(home, 'presence')).toBe('home');
    await leaves(BEN);
    expect(t.hub.modes.now(home, 'presence')).toBe('away');
    expect((await t.home.timeline()).find((entry) => entry.kind === 'home.mode')?.actor).toMatchObject({ kind: 'automation' });
    await arrives(BEN);
    expect(t.hub.modes.now(home, 'presence')).toBe('home');
  });

  test('someone arriving: everyone told who, by name, in their inbox', async () => {
    const rule: Rule = {
      roles: { family: { people: true, label: 'Family' } },
      params: { fields: {} },
      when: [{ arrives: { who: 'someone', at: 'home' } }],
      then: [{ notify: { to: 'family', title: '{run.who} is home', text: '{home.people} of you are home now', level: 'info' } }],
    };
    await acting(rule, { family: { everyone: true } });
    await arrives(BEN);
    const told = t.hub.notifications.inbox(ANNA);
    expect(told.map((each) => [each.title, each.body, each.from.kind])).toEqual([['Ben is home', '1 of you are home now', 'automation']]);
    expect(t.hub.notifications.inbox(BEN)).toHaveLength(1);
  });

  test('a mode becoming night: what waits for it starts; a room emptying: so does what waits for that', async () => {
    t.lampAt('lamp-1');
    const plug = await t.added('Lamp');
    const rule: Rule = {
      roles: { lamp: { label: 'Lamp', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [{ modeBecomes: { mode: 'night' } }],
      then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: false } } } }],
    };
    const automation = await acting(rule, {}, { lamp: { device: plug.id, part: 'main' } });
    t.hub.modes.set(home, 'night', { kind: 'person', id: null, name: 'olof' });
    await t.hub.engine.hear({ kind: 'mode', homeId: home, axis: 'day', mode: 'night', previous: 'day', by: { kind: 'person', id: null, name: 'olof' }, cause: [], at: new Date().toISOString() });
    await settle(300);
    const runs = await t.home.automations.runs(automation.id);
    expect(runs[0]?.why).toBe(`${t.hub.places.home(home)!.name} became night`);

    // A room someone is in, then nobody: what waits for it to empty starts as it does.
    const bath = t.hub.spaces.addSpace({ parentId: t.hub.spaces.site(home).id, kind: 'room', name: 'Bathroom' });
    const someone = t.hub.occupancies.begin(bath.id, new Date().toISOString(), [], null);
    const emptied = await acting(
      { roles: { bath: { place: true, label: 'Bathroom' } }, params: { fields: {} }, when: [{ empties: { place: 'bath' } }], then: [{ setMode: { mode: 'evening' } }] },
      { bath: { place: bath.id, kind: 'space' } }
    );
    expect(emptied.now.conditions).toEqual([{ text: 'Nobody is in Bathroom any more', holds: false }]);
    t.hub.occupancies.end(someone, new Date(Date.now() + 1).toISOString());
    await t.hub.engine.hear({ kind: 'occupancy', homeId: home, spaceId: bath.id, occupied: false, at: new Date().toISOString() });
    await settle(300);
    expect(t.hub.modes.now(home, 'day')).toBe('evening');
  });

  test('in the file, and back from it: who and where by their keys', async () => {
    const kitchen = t.hub.spaces.addSpace({ parentId: t.hub.spaces.site(home).id, kind: 'room', name: 'Kitchen' });
    const rule: Rule = {
      roles: { kitchen: { place: true, label: 'Kitchen' }, family: { people: true, label: 'Family' } },
      params: { fields: {} },
      when: [{ empties: { place: 'kitchen', heldFor: { value: 10, unit: 'min' } } }],
      then: [{ notify: { to: 'family', title: 'Nobody is in the kitchen' } }],
    };
    const made = await t.home.automations.create({ key: 'kitchen-quiet', name: 'Kitchen quiet', rule, roles: {}, groups: {}, starts: {}, world: { kitchen: { place: kitchen.id, kind: 'space' }, family: { everyone: true } }, timeZone: 'Europe/Stockholm' });
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    expect(text).toContain('uses:\n      kitchen:\n        space: kitchen\n      family:\n        people: everyone\n    when:\n      - empties: kitchen\n        for: 10 min');
    await t.home.automations.delete(made.id);
    const plan = await t.home.configuration.plan({ text });
    expect(plan.problems).toEqual([]);
    await t.home.configuration.apply({ plan: plan.id! });
    const back = (await t.home.automations.list()).find((each) => each.key === 'kitchen-quiet')!;
    expect(back.world).toEqual({ kitchen: { place: kitchen.id, kind: 'space' }, family: { everyone: true } });
    expect(back.sentence).toBe('When nobody has been in Kitchen for 10 min, tell everyone “Nobody is in the kitchen”.');
  });

  test('checked: who and where must be the family’s, a mode one it has', async () => {
    const rule: Rule = { roles: { olof: { person: true, label: 'Olof' } }, params: { fields: {} }, when: [{ arrives: { who: 'olof', at: 'home' } }], then: [{ setMode: { mode: 'home' } }] };
    const unfilled = await refusal(t.home.automations.create({ name: 'Nobody', rule, roles: {}, groups: {}, starts: {}, timeZone: 'Europe/Stockholm' }));
    expect(unfilled.message + JSON.stringify(unfilled.problems)).toContain('Olof: choose someone');
    const strange = await refusal(t.home.automations.create({ name: 'Somewhere', rule: { ...rule, then: [{ setMode: { mode: 'party' } }] }, roles: {}, groups: {}, starts: {}, world: { olof: { person: ANNA } }, timeZone: 'Europe/Stockholm' }));
    expect(strange.message + JSON.stringify(strange.problems)).toContain('there is no mode');
    const made = await t.home.automations.create({ name: 'Anna home', rule, roles: {}, groups: {}, starts: {}, world: { olof: { person: ANNA } }, timeZone: 'Europe/Stockholm' });
    expect(made.world).toEqual({ olof: { person: ANNA } });
    expect(made.sentence).toBe('When Anna arrives home, set the home to home.');
  });

  test('sharing less is not leaving: nobody told someone left, and the last one home stays home', async () => {
    const told: Rule = { roles: { family: { people: true, label: 'Family' } }, params: { fields: {} }, when: [{ leaves: { who: 'someone', at: 'home' } }], then: [{ notify: { to: 'family', title: '{run.who} left' } }] };
    await acting(told, { family: { everyone: true } });
    await acting(withSettings(STANDARD_RECIPES.find((each) => each.id === 'standard.away-when-everyone-leaves')! as unknown as Rule, {}));
    await arrives(ANNA);
    // Ben shares nothing now: where he is cannot be told — not away.
    t.hub.people.setSharing(BEN, { level: 'off' }, BEN, new Date().toISOString());
    const stay = t.hub.stays.open(ANNA).find((each) => each.placeId === home)!;
    t.hub.stays.end(stay.id, new Date(Date.now() + 1).toISOString());
    await t.hub.engine.hear({ kind: 'presence', personId: ANNA, place: { id: home, kind: 'home' }, change: 'unshared', at: new Date().toISOString() });
    await settle();
    expect(t.hub.notifications.inbox(ANNA)).toEqual([]);
    expect(t.hub.modes.now(home, 'presence')).toBe('home');
  });

  test('two arriving together: each told, neither let go while the other’s run goes on', async () => {
    const rule: Rule = { roles: { family: { people: true, label: 'Family' } }, params: { fields: {} }, when: [{ arrives: { who: 'someone', at: 'home' } }], then: [{ wait: { for: { value: 1, unit: 's' } } }, { notify: { to: 'family', title: '{run.who} is home' } }] };
    await acting(rule, { family: { everyone: true } });
    await Promise.all([arrives(ANNA), arrives(BEN)]);
    await settle(2600);
    expect(t.hub.notifications.inbox(ANNA).map((each) => each.title).sort()).toEqual(['Anna is home', 'Ben is home']);
  });

  test('two automations setting the mode back and forth: each change it caused itself is not heard by it again', async () => {
    const back = (from: string, to: string): Rule => ({ roles: {}, params: { fields: {} }, when: [{ modeBecomes: { mode: from } }], then: [{ wait: { for: { value: 1, unit: 's' } } }, { setMode: { mode: to } }] });
    await acting(back('away', 'home'));
    await acting(back('home', 'away'));
    t.hub.modes.set(home, 'away', { kind: 'person', id: null, name: 'olof' });
    await t.hub.engine.hear({ kind: 'mode', homeId: home, axis: 'presence', mode: 'away', previous: 'home', by: { kind: 'person', id: null, name: 'olof' }, cause: [], at: new Date().toISOString() });
    await settle(3500);
    const changes = (await t.home.timeline()).filter((entry) => entry.kind === 'home.mode' && entry.actor.kind === 'automation');
    expect(changes.length).toBeLessThanOrEqual(2);
  });

  test('a home left: what acted for it is turned off, never moved onto another', async () => {
    const cabin = t.hub.places.addHome({ key: 'cabin', name: 'Cabin', type: 'cabin', timeZone: 'Europe/Stockholm' });
    const made = await t.home.automations.create({ name: 'Cabin away', rule: { roles: {}, params: { fields: {} }, when: [{ modeBecomes: { mode: 'night' } }], then: [{ setMode: { mode: 'away' } }] }, roles: {}, groups: {}, starts: {}, homeId: cabin.id, timeZone: 'Europe/Stockholm' });
    t.hub.automations.update(made.id, { mode: 'act' });
    await t.home.homes.remove(cabin.id);
    expect(t.hub.automations.get(made.id)!.mode).toBe('off');
    expect(t.hub.engine.roleProblems(t.hub.automations.get(made.id)!)).toEqual(['The home it is for has been let go']);
  });
});
