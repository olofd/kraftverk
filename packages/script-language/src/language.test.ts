import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { typesOf } from '@kraftverk/script';

import { createScriptLanguage, type ScriptLanguage } from './index.ts';

/*
  The editor's language service, as the editor asks it: a script checked
  against the SDK and a family's world — a mistake marked where it is, a
  device's and a person's name completed, a command explained on hover. The library
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
      people: [{ name: 'Maria' }, { name: 'Olof' }],
      homes: [
        {
          key: 'cabin',
          name: 'The cabin',
          rooms: [{ key: 'kitchen', name: 'Kitchen' }],
          variables: [
            { key: 'guests', kind: 'toggle', field: { type: 'boolean', title: 'Guests staying' } },
            { key: 'dryerRuns', kind: 'counter', field: { type: 'number', title: 'Dryer runs', integer: true, min: 0 } },
            { key: 'wake', kind: 'time', field: { type: 'string', title: 'Wake at' } },
          ],
        },
      ],
      modes: [
        { key: 'home', axis: 'presence', name: 'Home' },
        { key: 'away', axis: 'presence', name: 'Away' },
        { key: 'night', axis: 'day', name: 'Night' },
      ],
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

const GOOD = `import { devices, family, home, log, type Celsius, type Duration, type Kept, type Percent } from 'kraftverk';

export async function off(after: Duration, memory: Kept<{ times: number }>): Promise<string> {
  const plug = devices.deskPlug;
  const power: number | null = plug.reading('power');
  if (power !== null && power > 10) await plug.switch.set({ on: false });
  if (!family.maria.isHome && home.rooms.kitchen.occupied === false) await plug.turnOff();
  if (home.presence === 'away') await home.setMode('night');
  if (home.vars.guests && home.vars.wake !== null) await home.count('dryerRuns');
  memory.times += 1;
  log('after', after);
  return plug.name;
}

export function feelsLike(temp: Celsius, humidity: Percent): Celsius {
  return temp - (100 - humidity) / 5;
}
`;

describe('the language service', () => {
  test('finds nothing wrong with a script written against the SDK and the home', async () => {
    expect(await language.problems(GOOD)).toEqual([]);
  });

  test('marks a device the home does not have, a command given the wrong argument, and a reading it does not report — where each is', async () => {
    const missing = await language.problems(GOOD.replace('devices.deskPlug', 'devices.deskPlugg'));
    expect(missing.map((each) => [each.line, each.message])).toEqual([[4, expect.stringContaining('deskPlugg')]]);
    const nobody = await language.problems(GOOD.replace('family.maria', 'family.mario'));
    expect(nobody.map((each) => each.line)).toEqual([7]);
    const noMode = await language.problems(GOOD.replace("setMode('night')", "setMode('nigth')"));
    expect(noMode.map((each) => each.line)).toEqual([8]);
    const noCounter = await language.problems(GOOD.replace("home.count('dryerRuns')", "home.count('guests')"));
    expect(noCounter.map((each) => each.line)).toEqual([9]);
    const noVariable = await language.problems(GOOD.replace('home.vars.guests', 'home.vars.guest'));
    expect(noVariable.map((each) => each.line)).toEqual([9]);
    const told = await language.problems(GOOD.replace('{ on: false }', '{ on: "no" }'));
    expect(told.map((each) => [each.line, each.message])).toEqual([[6, expect.stringContaining("Type 'string' is not assignable to type 'boolean'")]]);
    const unknown = await language.problems(GOOD.replace("plug.reading('power')", "plug.reading('voltage')"));
    expect(unknown.some((each) => each.line === 5 && each.message.includes('"voltage"'))).toBe(true);
  });

  test('completes a device’s and a person’s name, and a capability’s commands', async () => {
    const keys = await language.complete(GOOD, GOOD.indexOf('devices.deskPlug') + 'devices.'.length);
    expect(keys?.options.map((each) => each.label)).toContain('deskPlug');
    const people = await language.complete(GOOD, GOOD.indexOf('family.maria') + 'family.'.length);
    expect(people?.options.map((each) => each.label)).toEqual(expect.arrayContaining(['maria', 'olof']));
    const dot = GOOD.indexOf('.switch.set') + '.switch.'.length;
    expect((await language.complete(GOOD, dot))?.options.map((each) => each.label)).toEqual(['set']);
  });

  test('formats as TypeScript does: changes in order, each against the text as it was — none when it is formatted already', async () => {
    const messy = "export function half(x:number):number{\nreturn x/2\n}\n";
    const edits = await language.format(messy);
    let formatted = messy;
    for (const edit of [...edits].reverse()) formatted = formatted.slice(0, edit.from) + edit.insert + formatted.slice(edit.to);
    expect(formatted).toBe('export function half(x: number): number {\n  return x / 2\n}\n');
    expect(await language.format(formatted)).toEqual([]);
    expect(await language.format(GOOD)).toEqual([]);
  });

  test('explains a command on hover, in its capability’s words', async () => {
    const at = GOOD.indexOf('.set(') + 2;
    expect((await language.hover(GOOD, at))?.text).toContain('Turn it on or off');
  });
});
