import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { aHome, refusal, type TestHome } from './a-home.ts';

/*
  The family's scripts, asked of a home (docs/PLAN-SCRIPTS.md): kept when
  they read, refused with each problem when they do not, on the timeline,
  carried by the configuration file and brought back by it. Read here by a
  stand-in for a place's engine (script-engine.ts); the engine itself is
  tested in @kraftverk/script-wasm, and end to end in e2e/scripts.e2e.ts.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

const FEELS = "import { fn, t } from 'kraftverk';\nexport const feelsLike = fn({ args: [t.number({ unit: '°C' })], returns: t.number({ unit: '°C' }) }, (temp: number) => temp - 2);\n";
const TIDY = "import { step, t } from 'kraftverk';\nexport const tidyUp = step({ inputs: { after: t.duration() } }, async () => null);\n";

describe('a script', () => {
  test('is kept when it reads: its key from its name, what it declares, who wrote it — and on the timeline', async () => {
    const kept = await t.home.scripts.create({ name: 'Feels like', source: FEELS });
    expect(kept).toMatchObject({ key: 'feels-like', name: 'Feels like', source: FEELS, problems: [], updatedBy: 'olof' });
    expect(Object.keys(kept.shape?.functions ?? {})).toEqual(['feelsLike']);
    expect(await t.home.scripts.list()).toEqual([kept]);
    expect(await t.home.scripts.get(kept.id)).toEqual(kept);
    expect((await t.home.timeline({ resourceKind: 'script' }))[0]).toMatchObject({ kind: 'script.added', summary: 'Wrote the script "Feels like"' });
  });

  test('is refused when it does not read, with each problem; and a key another has, or that is none', async () => {
    const broken = await refusal(t.home.scripts.create({ name: 'Broken', source: 'export const x = 1;\n' }));
    expect(broken).toMatchObject({ kind: 'invalid', problems: ['"x" is neither a step nor a function: export only step(...) and fn(...)'] });
    await t.home.scripts.create({ key: 'mine', name: 'Mine', source: FEELS });
    expect((await refusal(t.home.scripts.create({ key: 'mine', name: 'Another', source: TIDY }))).kind).toBe('conflict');
    expect((await refusal(t.home.scripts.create({ key: 'Not A Key', name: 'Another', source: TIDY }))).kind).toBe('invalid');
    expect((await refusal(t.home.scripts.create({ name: '  ', source: TIDY }))).kind).toBe('invalid');
    expect(await t.home.scripts.list()).toHaveLength(1);
  });

  test('is changed — its name, its key, its source, read again — and removed, each said', async () => {
    const kept = await t.home.scripts.create({ name: 'Feels like', source: FEELS });
    const changed = await t.home.scripts.update(kept.id, { name: 'Tidy up', key: 'tidy-up', source: TIDY });
    expect(changed).toMatchObject({ key: 'tidy-up', name: 'Tidy up', source: TIDY });
    expect(Object.keys(changed.shape?.steps ?? {})).toEqual(['tidyUp']);
    expect((await refusal(t.home.scripts.update(kept.id, { source: 'export const y = 2;\n' }))).kind).toBe('invalid');
    expect((await t.home.scripts.get(kept.id)).source).toBe(TIDY);
    await t.home.scripts.remove(kept.id);
    expect((await refusal(t.home.scripts.get(kept.id))).kind).toBe('not-found');
    expect((await t.home.timeline({ resourceKind: 'script' })).map((entry) => entry.summary)).toEqual([
      'Removed the script "Tidy up"',
      'The script "Feels like": renamed it "Tidy up", its key is "tidy-up", changed what it says',
      'Wrote the script "Feels like"',
    ]);
  });

  test('goes in the configuration file as written, and is brought back from it; replacing, one it does not name goes, with a yes', async () => {
    const kept = await t.home.scripts.create({ name: 'Feels like', source: FEELS });
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    expect(text).toContain('scripts:\n  feels-like:\n    name: Feels like\n    source: |\n');

    await t.home.scripts.remove(kept.id);
    const plan = await t.home.configuration.plan({ text });
    expect(plan.scripts).toEqual([{ key: 'feels-like', name: 'Feels like', action: 'add', changes: [] }]);
    const applied = await t.home.configuration.apply({ plan: plan.id! });
    expect(applied.scripts.added).toEqual(['feels-like']);
    expect((await t.home.scripts.list()).map((script) => [script.key, script.source])).toEqual([['feels-like', FEELS]]);

    // A file without it, replacing what is here: it goes, once a person says yes.
    await t.home.scripts.create({ name: 'Tidy up', source: TIDY });
    const replacing = await t.home.configuration.plan({ text, mode: 'replace' });
    expect(replacing.scripts.find((item) => item.key === 'tidy-up')?.action).toBe('remove');
    expect(replacing.needs.confirm).toContain('The script "Tidy up" is removed');
  });

  test('that does not read is a problem in the file it comes in, at its line', async () => {
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    const plan = await t.home.configuration.plan({ text: `${text}scripts:\n  broken:\n    source: |\n      export const x = 1;\n` });
    expect(plan.id).toBeNull();
    expect(plan.problems.map((each) => each.message)).toContain('The script "broken": "x" is neither a step nor a function: export only step(...) and fn(...)');
  });

  test('runs as a step of an automation: through the gateway as the automation, what it did said beneath it, what it answers remembered', async () => {
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const script = await t.home.scripts.create({
      name: 'Tidy up',
      source: [
        "import { step, t, home, log } from 'kraftverk';",
        'export const off = step({ answer: t.text(), memory: { times: t.count() } }, async (_inputs: unknown, { memory }: { memory: { times: number } }) => {',
        "  const plug = home.devices['heater-plug'];",
        '  await plug.switch.set({ on: false });',
        '  memory.times += 1;',
        "  log('Turned it off');",
        '  return plug.name;',
        '});',
        '',
      ].join('\n'),
    });
    const made = await t.home.automations.create({
      name: 'Evening tidy',
      rule: { roles: { tidy: { script: true, label: 'Tidy' } }, params: { fields: {} }, memory: { fields: { lastTidy: { type: 'string', title: 'Last tidy', default: '' } } }, when: [], then: [{ script: { role: 'tidy', remember: 'lastTidy' } }] },
      roles: {},
      groups: {},
      starts: {},
      scripts: { tidy: script.id },
      timeZone: 'Europe/Stockholm',
    });
    expect(made.problems).toEqual([]);
    await t.home.automations.start(made.id);
    let run = (await t.home.automations.get(made.id)).lastRun;
    for (let waited = 0; !run && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = (await t.home.automations.get(made.id)).lastRun;
    }
    expect(run?.outcome).toBe('acted');
    const steps = run!.steps.map((step) => [step.depth, step.what, step.outcome, step.detail]);
    expect(steps[0]).toEqual([0, 'Run “Tidy up”, remembering what it answers as last tidy', 'done', 'Answered Heater plug']);
    expect(steps.slice(1).map(([depth, what]) => [depth, what])).toEqual([
      [1, 'Heater plug: switch.set on false'],
      [1, 'Turned it off'],
    ]);
    expect((await t.home.devices.get(plug.id)).readings.find((reading) => reading.key === 'on')?.value).toBe(false);
  });

  test('decides a condition with one of its functions: pure, its arguments in order, checked against what it declares', async () => {
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const script = await t.home.scripts.create({ name: 'Maths', source: "import { fn, t } from 'kraftverk';\nexport const double = fn({ args: [t.number()], returns: t.number() }, (n: number) => n * 2);\n" });
    const rule = (n: number) => ({
      roles: { maths: { script: true as const, label: 'Maths' }, plug: { label: 'Plug', capabilities: ['switch' as const] } },
      params: { fields: {} },
      // Looked at on every reading: a function is pure, so it may be.
      when: [{ becomes: { compare: 'gt' as const, left: { script: 'maths', fn: 'double', args: [{ value: n }] }, right: { value: 3 } } }],
      then: [{ command: { role: 'plug', capability: 'switch' as const, command: 'set', args: { on: { value: false } } } }],
    });
    const fills = { roles: { plug: { device: plug.id, part: 'main' } }, groups: {}, starts: {}, scripts: { maths: script.id }, timeZone: 'Europe/Stockholm' };
    // Held to what it declares: one argument, a number.
    const wrong = await t.home.automations.draft({ ...fills, rule: { ...rule(2), when: [{ becomes: { compare: 'gt', left: { script: 'maths', fn: 'double', args: [] }, right: { value: 3 } } }] } } as never);
    expect(wrong.problems.join()).toContain('double takes 1 argument, not 0');
    const view = (await t.home.automations.draft({ ...fills, rule: rule(2) } as never)) as { problems: string[] };
    expect(view.problems).toEqual([]);
    const made = await t.home.automations.create({ name: 'Doubled', ...fills, rule: rule(2) } as never);
    // How what it waits for stands now: decided by the script's function — and, given less, not so.
    expect((await t.home.automations.get(made.id)).now.conditions).toEqual([{ text: 'Double by “Maths” (2) is above 3', holds: true }]);
    const less = await t.home.automations.create({ name: 'Doubled less', ...fills, rule: rule(1) } as never);
    expect((await t.home.automations.get(less.id)).now.conditions[0]?.holds).toBe(false);
  });

  test('is not read where no engine runs scripts, and the home says so', async () => {
    await t.stop();
    t = await aHome({ noScripts: true });
    const refused = await refusal(t.home.scripts.check(FEELS));
    expect(refused).toMatchObject({ kind: 'unavailable', message: 'Scripts cannot run here: this place has no engine for them' });
    expect((await refusal(t.home.scripts.create({ name: 'Feels like', source: FEELS }))).kind).toBe('unavailable');
  });
});
