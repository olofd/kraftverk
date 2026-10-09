import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { typesOf } from '@kraftverk/script';

import { createScriptLanguage, type ScriptLanguage } from './index.ts';

/*
  The editor's language service, as the editor asks it: a script checked
  against the SDK and a home's devices — a mistake marked where it is, a
  device's key completed, a command explained on hover. The library
  declarations read from TypeScript's own package, as the app's build copies
  them.
*/

let language: ScriptLanguage;
beforeAll(async () => {
  const lib = dirname(Bun.resolveSync('typescript/lib/lib.es2022.d.ts', import.meta.dir));
  const libraries = Object.fromEntries(readdirSync(lib).filter((name) => /^lib\.(es|decorators).*\.d\.ts$/.test(name)).map((name) => [name, readFileSync(join(lib, name), 'utf8')]));
  language = createScriptLanguage(libraries);
  await language.types(
    typesOf({
      devices: [
        {
          key: 'desk-plug',
          name: 'Desk plug',
          type: 'tuya.plug',
          parts: [{ id: 'main', label: 'Desk plug', capabilities: ['switch', 'powerMeter'] }],
          readings: [
            { key: 'on', label: 'On', value: { type: 'boolean' } },
            { key: 'power', label: 'Power', value: { type: 'number', unit: 'W' } },
          ],
        },
      ],
    })
  );
});

const GOOD = `import { step, t, home, log } from 'kraftverk';

export const off = step({ inputs: { after: t.duration() }, answer: t.text() }, async ({ after }) => {
  const plug = home.devices['desk-plug'];
  const power: number | null = plug.reading('power');
  if (power !== null && power > 10) await plug.switch.set({ on: false });
  log('after', after);
  return plug.name;
});
`;

describe('the language service', () => {
  test('finds nothing wrong with a script written against the SDK and the home', async () => {
    expect(await language.problems(GOOD)).toEqual([]);
  });

  test('marks a device the home does not have, a command given the wrong argument, and a reading it does not report — where each is', async () => {
    const missing = await language.problems(GOOD.replace("home.devices['desk-plug']", "home.devices['desk-plugg']"));
    expect(missing.map((each) => [each.line, each.message])).toEqual([[4, expect.stringContaining('desk-plugg')]]);
    const told = await language.problems(GOOD.replace('{ on: false }', '{ on: "no" }'));
    expect(told.map((each) => [each.line, each.message])).toEqual([[6, expect.stringContaining("Type 'string' is not assignable to type 'boolean'")]]);
    const unknown = await language.problems(GOOD.replace("plug.reading('power')", "plug.reading('voltage')"));
    expect(unknown.some((each) => each.line === 5 && each.message.includes('"voltage"'))).toBe(true);
  });

  test('completes a device key, and a capability’s commands', async () => {
    const at = GOOD.indexOf("'desk-plug'") + 1;
    const keys = await language.complete(GOOD, at);
    expect(keys?.options.map((each) => each.label)).toContain('desk-plug');
    const dot = GOOD.indexOf('.switch.set') + '.switch.'.length;
    expect((await language.complete(GOOD, dot))?.options.map((each) => each.label)).toEqual(['set']);
  });

  test('explains a command on hover, in its capability’s words', async () => {
    const at = GOOD.indexOf('.set(') + 2;
    expect((await language.hover(GOOD, at))?.text).toContain('Turn it on or off');
  });
});
