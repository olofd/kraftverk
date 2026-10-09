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

  test('is not read where no engine runs scripts, and the home says so', async () => {
    await t.stop();
    t = await aHome({ noScripts: true });
    const refused = await refusal(t.home.scripts.check(FEELS));
    expect(refused).toMatchObject({ kind: 'unavailable', message: 'Scripts cannot run here: this place has no engine for them' });
    expect((await refusal(t.home.scripts.create({ name: 'Feels like', source: FEELS }))).kind).toBe('unavailable');
  });
});
