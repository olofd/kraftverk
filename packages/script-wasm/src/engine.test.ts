import { beforeAll, describe, expect, test } from 'bun:test';

import { readScript, type ScriptEngine } from '@kraftverk/script';
import { CONFORMANCE } from '@kraftverk/script/conformance';

import { wasmScriptEngine } from './index.ts';

/*
  The WebAssembly engine, held to the contract every engine keeps
  (`@kraftverk/script/conformance`), and reading scripts as a hub does: on
  a server, its .wasm read from disk.
*/

let engine: ScriptEngine;
beforeAll(async () => {
  const wasm = await Bun.file(Bun.resolveSync('@jitl/quickjs-ng-wasmfile-release-sync/wasm', import.meta.dir)).arrayBuffer();
  engine = await wasmScriptEngine({ binary: wasm });
});

describe('the WebAssembly engine keeps the contract', () => {
  for (const each of CONFORMANCE) test(each.name, () => each.run(engine));
});

const TIDY = `import { log, type Celsius, type Duration, type Kept, type Percent } from 'kraftverk';

type Mood = 'calm' | 'brisk';

interface Memory {
  /** How often it was asked */
  times: number;
}

/** Turns off what was left on. */
export async function tidyUp(
  /** Empty for at least. @min 1 min */
  after: Duration,
  mood: Mood,
  memory: Kept<Memory>
): Promise<string> {
  memory.times += 1;
  log('after', after, mood);
  return 'Nothing was left on';
}

/** How warm it feels. */
export function feelsLike(temp: Celsius, humidity: Percent): Celsius {
  return temp - (100 - humidity) / 5;
}

/** Not exported: its own to use. */
function helper(): number {
  return 1;
}
`;

describe('reading a script', () => {
  test('its steps and functions, from their signatures: titles and limits from their doc comments, named in words where they say nothing', () => {
    const read = readScript(TIDY, engine);
    expect(read.problems).toEqual([]);
    expect(read.compiled?.imports).toEqual(['kraftverk']);
    expect(read.shape).toEqual({
      steps: {
        tidyUp: {
          about: 'Turns off what was left on.',
          inputs: {
            fields: {
              after: { type: 'number', title: 'Empty for at least', unit: 's', min: 60 },
              mood: { type: 'enum', title: 'Mood', options: [{ value: 'calm', label: 'Calm' }, { value: 'brisk', label: 'Brisk' }] },
            },
          },
          answer: { type: 'string', title: 'Answer' },
          memory: { fields: { times: { type: 'number', title: 'How often it was asked', default: 0 } } },
        },
      },
      functions: {
        feelsLike: {
          about: 'How warm it feels.',
          args: [
            { type: 'number', title: 'Temp', unit: '°C' },
            { type: 'number', title: 'Humidity', unit: '%' },
          ],
          returns: { type: 'number', title: 'Answer', unit: '°C' },
        },
      },
    });
    expect(read.calls).toEqual({ tidyUp: { params: ['after', 'mood', 'memory'], memory: 2 }, feelsLike: { params: ['temp', 'humidity'], memory: null } });
  });

  test('what does not compile, at its line and column', () => {
    expect(readScript('const a = 1;\nconst b: = 2;\n', engine).problems).toEqual([{ message: expect.any(String), line: 2, column: 10 }]);
  });

  test('an import of anything but the SDK, before anything runs — one only typed is no import at all', () => {
    expect(readScript("import type { Stats } from 'node:fs';\nexport async function go(): Promise<void> {}\n", engine).problems).toEqual([]);
    expect(readScript("import fs from 'node:fs';\nexport function x(): number { return fs ? 1 : 0; }\n", engine).problems.map((each) => each.message)).toEqual(['A script imports only "kraftverk" and "kraftverk/api", not "node:fs"']);
  });

  test('what its top level throws, at its line; a top level that will not end; and exports that are not functions', () => {
    expect(readScript("export function one(): number { return 1; }\n\nthrow new Error('Not yet');\n", engine).problems).toEqual([{ message: 'Not yet', line: 3, column: expect.any(Number) }]);
    expect(readScript('export function one(): number { return 1; }\nfor (;;) {}\n', engine).problems[0]?.message).toStartWith('Its top level ran for more than 50 ms');
    expect(readScript('export const answer = 42;\n', engine).problems).toEqual([{ message: 'Export only functions, each by its name: "export async function" for a step, "export function" for a function', line: 1, column: 1 }]);
    expect(readScript('const quiet = 1;\n', engine).problems.map((each) => each.message)).toEqual(['It declares nothing: export an "async function" for a step, or a "function" for a value']);
  });

  test('signatures it cannot read, each where it is: a unit kraftverk does not know, a type it does not have, a name not in camelCase, a function that says not what it gives', () => {
    const read = readScript(
      "import type { Quantity } from 'kraftverk';\nexport async function go(speed: Quantity<'furlongs'>): Promise<void> {}\nexport async function went(when: Date): Promise<void> {}\nexport async function Run(): Promise<void> {}\nexport function half(x: number) { return x / 2; }\n",
      engine
    );
    expect(read.shape).toBeNull();
    expect(read.problems).toEqual([
      { message: expect.stringContaining('go: Quantity<…> is in a unit kraftverk knows'), line: 2, column: 42 },
      { message: expect.stringContaining('went: Date is not a type kraftverk reads here'), line: 3, column: 34 },
      { message: '"Run": a name is a word in camelCase, as "tidyUp"', line: 4, column: 23 },
      { message: 'half: Say what half gives: "function half(…): number"', line: 5, column: 17 },
    ]);
  });

  test('a script longer than a script may be', () => {
    expect(readScript(`// ${'x'.repeat(70_000)}\n`, engine).problems.map((each) => each.message)).toEqual(['A script is at most 64 KB']);
  });
});
