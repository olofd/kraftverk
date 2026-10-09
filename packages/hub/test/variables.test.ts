import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { LiveUpdate } from '@kraftverk/api-contract';
import type { Rule } from '@kraftverk/automation';

import { aHome, refusal, settle, type TestHome } from './a-home.ts';

/*
  A home's variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md V1): declared by a
  person, each held to its kind and field; set and counted by a person, a
  script and an automation — on the timeline, said live; read by what an
  automation decides and waits for; carried by the configuration file as
  what each is, never what it holds.
*/

let t: TestHome;
let home: string;
beforeEach(async () => {
  t = await aHome();
  home = t.hub.places.homes()[0]!.id;
});
afterEach(async () => {
  await t.stop();
});

const GUESTS = { key: 'guests', kind: 'toggle', field: { type: 'boolean', title: 'Guests staying' } } as const;
const RUNS = { key: 'dryerRuns', kind: 'counter', field: { type: 'number', title: 'Dryer runs', integer: true, min: 0, max: 3 } } as const;
const TARGET = { key: 'target', kind: 'number', field: { type: 'number', title: 'Target', unit: '°C', min: 16, max: 25, default: 21 } } as const;

/** An automation made and let act, as a person would with their yes. */
const acting = async (rule: Rule) => {
  const made = await t.home.automations.create({ name: 'Test', rule, roles: {}, groups: {}, starts: {}, world: {}, timeZone: 'Europe/Stockholm' });
  t.hub.automations.update(made.id, { mode: 'act' });
  return made;
};

describe('a home’s variables', () => {
  test('declared, each held to its kind: set, counted within its range, on the timeline — and said live', async () => {
    const updates: LiveUpdate[] = [];
    const live = t.home.live((update) => updates.push(update));
    expect(await t.home.variables.add(home, GUESTS)).toMatchObject({ key: 'guests', value: false, setAt: null, by: null });
    await t.home.variables.add(home, RUNS);
    expect((await t.home.variables.add(home, TARGET)).value).toBe(21);
    expect((await t.home.variables.list(home)).map((variable) => variable.key)).toEqual(['guests', 'dryerRuns', 'target']);

    expect(await t.home.variables.set(home, 'guests', true)).toMatchObject({ value: true, by: 'olof' });
    expect((await t.home.variables.count(home, 'dryerRuns')).value).toBe(1);
    expect((await t.home.variables.count(home, 'dryerRuns', { by: 5 })).value).toBe(3);
    expect((await t.home.variables.count(home, 'dryerRuns', { reset: true })).value).toBe(0);
    expect((await t.home.timeline()).find((entry) => entry.kind === 'variable.set')?.summary).toBe('Dryer runs is 0, was 3');
    // Said live as the stream says what changed: at most a quarter of a second later.
    await settle(300);
    expect(updates.some((update) => update.type === 'world' && update.what === 'variable' && update.homeId === home)).toBe(true);
    live.close();

    // What does not fit: said, and nothing changes.
    expect((await refusal(t.home.variables.set(home, 'target', 30))).message).toContain('at most 25');
    expect((await refusal(t.home.variables.set(home, 'guests', 'yes'))).kind).toBe('invalid');
    expect((await refusal(t.home.variables.count(home, 'guests'))).message).toBe('Guests staying is not a counter: set it');
    expect((await refusal(t.home.variables.set(home, 'nothing', 1))).kind).toBe('not-found');
    expect((await refusal(t.home.variables.add(home, { ...GUESTS, field: { ...GUESTS.field, title: 'Again' } }))).kind).toBe('conflict');
    expect((await refusal(t.home.variables.add(home, { key: 'Bad key', kind: 'toggle', field: { type: 'boolean', title: 'Bad' } }))).message).toContain('camelCase');
    expect((await refusal(t.home.variables.add(home, { key: 'runs', kind: 'counter', field: { type: 'number', title: 'Runs' } }))).message).toBe('A counter counts in whole numbers');
  });

  test('changed so what it holds no longer fits: back to what it starts as; let go, its key free again', async () => {
    const target = await t.home.variables.add(home, TARGET);
    await t.home.variables.set(home, 'target', 24);
    expect((await t.home.variables.update(target.id, { field: { ...TARGET.field, max: 22 } })).value).toBe(21);
    const kept = await t.home.variables.update(target.id, { field: { ...TARGET.field, title: 'Warmth' } });
    expect(kept.field.title).toBe('Warmth');
    await t.home.variables.remove(target.id);
    expect(await t.home.variables.list(home)).toEqual([]);
    expect((await t.home.variables.add(home, TARGET)).value).toBe(21);
  });

  test('a number given as text is kept as a number; one chosen as it starts is kept, so a new start does not change it', async () => {
    const target = await t.home.variables.add(home, TARGET);
    expect((await t.home.variables.set(home, 'target', '22' as never)).value).toBe(22);
    expect(t.hub.variableStore.value(target.id)?.value).toBe(22);
    await t.home.variables.set(home, 'target', 21);
    await t.home.variables.update(target.id, { field: { ...TARGET.field, default: 19 } });
    expect(t.hub.variables.now(home, 'target')).toBe(21);
  });

  test('declared anew in another unit, what it held is not taken in it: back to what it starts as — and said so', async () => {
    const target = await t.home.variables.add(home, TARGET);
    await t.home.variables.set(home, 'target', 22);
    const heard: string[] = [];
    const off = t.hub.bus.subscribe((message) => (message.kind === 'variable' ? heard.push(`${String(message.previous)} → ${String(message.value)}`) : undefined));
    const changed = await t.home.variables.update(target.id, { field: { type: 'number', title: 'Target', unit: '°F', min: 60, max: 80, default: 70 } });
    off();
    expect(changed.value).toBe(70);
    expect(heard).toEqual(['22 → 70']);
  });

  test('rekeyed while an automation names it: refused, saying which', async () => {
    const guests = await t.home.variables.add(home, GUESTS);
    await t.home.automations.create({ name: 'Welcome', rule: { roles: {}, params: { fields: {} }, when: [{ becomes: { variable: { key: 'guests', at: 'home' } } }], then: [{ setMode: { mode: 'home' } }] }, roles: {}, groups: {}, starts: {}, world: {}, timeZone: 'Europe/Stockholm' });
    expect((await refusal(t.home.variables.update(guests.id, { key: 'visitors' }))).message).toBe('“Welcome” uses "guests": change it first');
  });

  test('an automation that sets back what started it: started again when a person sets it again at once', async () => {
    await t.home.variables.add(home, GUESTS);
    const doorbell = await acting({
      roles: {},
      params: { fields: {} },
      when: [{ becomes: { variable: { key: 'guests', at: 'home' } } }],
      then: [{ setVariable: { key: 'guests', to: { value: false } } }],
    });
    t.hub.engine.start();
    for (let time = 0; time < 2; time++) {
      await t.home.variables.set(home, 'guests', true);
      await settle(300);
      expect(t.hub.variables.now(home, 'guests')).toBe(false);
    }
    const runs = await t.home.automations.runs(doorbell.id);
    expect(runs).toHaveLength(2);
    // Said as what it did, not "nothing needed doing".
    expect(runs[0]!.summary).toBe('Set “Guests staying” to no');
  });

  test('a time taken from a variable: run when the clock comes to it — and a variable of words is no time', async () => {
    await t.home.variables.add(home, { key: 'wake', kind: 'time', field: { type: 'string', title: 'Wake at' } });
    await t.home.variables.add(home, { key: 'note', kind: 'text', field: { type: 'string', title: 'Note' } });
    const problems = async (key: string) => (await t.home.automations.draft({ rule: { roles: {}, params: { fields: {} }, when: [{ at: { variable: { key, at: 'home' } } }], then: [{ setMode: { mode: 'home' } }] }, roles: {}, groups: {}, starts: {}, world: {} })).problems;
    expect(await problems('wake')).toEqual([]);
    expect((await problems('note')).join(' ')).toContain('Note is not a time of day');
    // Now, on the automation's clock: its minute is the one it wakes at.
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    await t.home.variables.set(home, 'wake', now);
    const waking = await acting({ roles: {}, params: { fields: {} }, when: [{ at: { variable: { key: 'wake', at: 'home' } } }], then: [{ setMode: { mode: 'home' } }] });
    expect((await t.home.automations.list()).find((each) => each.id === waking.id)?.sentence).toBe('Every day at “Wake at”, set the home to home.');
    await t.hub.engine.tick();
    await settle(100);
    expect((await t.home.automations.runs(waking.id))).toHaveLength(1);
  });

  test('a script sets and counts them — but does not declare them', async () => {
    await t.home.variables.add(home, RUNS);
    const script = t.as({ kind: 'automation', id: 'a-1', name: 'A tidy', for: null, run: { id: 'r-1', askedBy: null } });
    expect((await script.variables.count(home, 'dryerRuns')).value).toBe(1);
    expect((await refusal(script.variables.add(home, GUESTS))).kind).toBe('forbidden');
  });

  test('an automation counts one, and another waits for it to reach three: what started it said, and none sets it for ever', async () => {
    await t.home.variables.add(home, RUNS);
    await t.home.variables.add(home, GUESTS);
    const counting = await acting({ roles: {}, params: { fields: {} }, when: [{ every: { value: 5, unit: 'min' } }], then: [{ count: { key: 'dryerRuns' } }] });
    const waiting = await acting({
      roles: {},
      params: { fields: {} },
      when: [{ becomes: { compare: 'ge', left: { variable: { key: 'dryerRuns', at: 'home' } }, right: { value: 3 } } }],
      then: [{ setVariable: { key: 'guests', to: { value: true } } }],
    });
    // Listening, as the hub's engine does: what a variable's change starts, it hears.
    t.hub.engine.start();
    // Its steps said in words: what it changes, by its title.
    expect((await t.home.automations.list()).find((each) => each.id === counting.id)?.sentence).toBe('Every 5 min, count “Dryer runs”.');
    for (let time = 0; time < 3; time++) {
      await t.home.automations.start(counting.id);
      await settle(100);
    }
    await settle(300);
    expect(t.hub.variables.now(home, 'dryerRuns')).toBe(3);
    expect(t.hub.variables.now(home, 'guests')).toBe(true);
    const runs = await t.home.automations.runs(waiting.id);
    expect(runs[0]?.why).toBe('“Dryer runs” is at least 3');
    // At its most it stays there, and says so.
    await t.home.automations.start(counting.id);
    await settle(100);
    const last = (await t.home.automations.runs(counting.id))[0]!;
    expect(last.steps.at(-1)).toMatchObject({ outcome: 'already', detail: 'It is 3 now' });
  });

  test('checked as an automation is made: a variable the home has, of the kind a step asks', async () => {
    await t.home.variables.add(home, GUESTS);
    const problems = async (rule: Rule) => (await t.home.automations.draft({ rule, roles: {}, groups: {}, starts: {}, world: {} })).problems;
    expect(await problems({ roles: {}, params: { fields: {} }, when: [{ every: { value: 5, unit: 'min' } }], then: [{ setVariable: { key: 'guests', to: { value: true } } }] })).toEqual([]);
    expect((await problems({ roles: {}, params: { fields: {} }, when: [{ every: { value: 5, unit: 'min' } }], then: [{ setVariable: { key: 'nobody', to: { value: true } } }] })).join(' ')).toContain('nobody');
    expect((await problems({ roles: {}, params: { fields: {} }, when: [{ every: { value: 5, unit: 'min' } }], then: [{ count: { key: 'guests' } }] })).join(' ')).toContain('counter');
    expect((await problems({ roles: {}, params: { fields: {} }, when: [{ every: { value: 5, unit: 'min' } }], then: [{ setVariable: { key: 'guests', to: { value: 3 } } }] })).length).toBeGreaterThan(0);
  });

  test('in the file as what each is — never what it holds — and back from it', async () => {
    await t.home.variables.add(home, TARGET);
    await t.home.variables.add(home, RUNS);
    await t.home.variables.set(home, 'target', 23);
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    expect(text).toContain('variables:\n      target:\n        kind: number\n        starts: 21 °C\n        min: 16 °C\n        max: 25 °C');
    expect(text).not.toContain('23 °C');
    // A counter's title made from its key, and its start at nought, go unsaid.
    expect(text).toContain('      dryerRuns:\n        kind: counter\n        max: 3\n');
    const changed = text.replace('max: 25 °C', 'max: 22 °C').replace('      dryerRuns:\n        kind: counter\n        max: 3\n', '      dryerRuns:\n        kind: counter\n        max: 3\n      note:\n        kind: text\n');
    const plan = await t.home.configuration.plan({ text: changed });
    expect(plan.homes[0]?.changes).toEqual(['variables added: Note', 'variables changed: Target']);
    await t.home.configuration.apply({ plan: plan.id! });
    const after = await t.home.variables.list(home);
    expect(after.map((variable) => variable.key)).toEqual(['target', 'dryerRuns', 'note']);
    // What it held, 23, no longer fits: back to what it starts as.
    expect(after[0]!.value).toBe(21);
  });
});
