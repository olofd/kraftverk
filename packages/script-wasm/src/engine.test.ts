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

const TIDY = `import { step, fn, t, log } from 'kraftverk';

/** Turns off what was left on. */
export const tidyUp = step(
  {
    inputs: { after: t.duration({ title: 'Empty for at least', min: 60 }) },
    answer: t.text(),
    memory: { times: t.count() },
  },
  async ({ after }: { after: number }, { memory }: { memory: { times: number } }) => {
    memory.times += 1;
    log('after', after);
    return 'Nothing was left on';
  }
);

export const feelsLike = fn({ args: [t.number({ unit: '°C' }), t.number({ unit: '%' })], returns: t.number({ unit: '°C' }) }, (temp: number, humidity: number) => temp - (100 - humidity) / 5);
`;

describe('reading a script', () => {
  test('its steps and functions, in the language’s own fields, named in words where it said nothing', () => {
    const read = readScript(TIDY, engine);
    expect(read.problems).toEqual([]);
    expect(read.compiled?.imports).toEqual(['kraftverk']);
    expect(read.shape).toEqual({
      steps: {
        tidyUp: {
          inputs: { fields: { after: { type: 'number', title: 'Empty for at least', unit: 's', min: 60 } } },
          answer: { type: 'string', title: 'Answer' },
          memory: { fields: { times: { type: 'number', title: 'Times', min: 0, integer: true } } },
        },
      },
      functions: {
        feelsLike: {
          args: [
            { type: 'number', title: 'Argument 1', unit: '°C' },
            { type: 'number', title: 'Argument 2', unit: '%' },
          ],
          returns: { type: 'number', title: 'Answer', unit: '°C' },
        },
      },
    });
  });

  test('what does not compile, at its line and column', () => {
    expect(readScript('const a = 1;\nconst b: = 2;\n', engine).problems).toEqual([{ message: expect.any(String), line: 2, column: 10 }]);
  });

  test('an import of anything but the SDK, before anything runs — one only typed is no import at all', () => {
    expect(readScript("import type { Stats } from 'node:fs';\nimport { step } from 'kraftverk';\nexport const go = step({}, async (): Promise<Stats | null> => null);\n", engine).problems).toEqual([]);
    expect(readScript("import fs from 'node:fs';\nexport const x = fs;\n", engine).problems.map((each) => each.message)).toEqual(['A script imports only "kraftverk" and "kraftverk/api", not "node:fs"']);
  });

  test('what its top level throws, at its line; a top level that will not end; and exports that are neither', () => {
    expect(readScript("import { t } from 'kraftverk';\n\nthrow new Error('Not yet');\n", engine).problems).toEqual([{ message: 'Not yet', line: 3, column: expect.any(Number) }]);
    expect(readScript('for (;;) {}\n', engine).problems[0]?.message).toStartWith('Its top level ran for more than 50 ms');
    expect(readScript('export const answer = 42;\n', engine).problems.map((each) => each.message)).toEqual(['"answer" is neither a step nor a function: export only step(...) and fn(...)']);
    expect(readScript('const quiet = 1;\n', engine).problems.map((each) => each.message)).toEqual(['It declares nothing: export a step(...) or a fn(...)']);
  });

  test('fields it cannot be: a unit kraftverk does not know, a choice without options, a name not in camelCase', () => {
    const read = readScript("import { step, t } from 'kraftverk';\nexport const go = step({ inputs: { 'how-far': t.number(), speed: t.number({ unit: 'furlongs' }), mood: t.choice([]) } }, async () => null);\n", engine);
    expect(read.shape).toBeNull();
    expect(read.problems.map((each) => each.message)).toEqual([
      'The step "go", its input "how-far": a name is a word in camelCase, as "emptyFor"',
      'The step "go", its input "speed": "furlongs" is not a unit kraftverk knows',
      'The step "go", its input "mood": a choice has its options, each a value and its words',
    ]);
  });

  test('a script longer than a script may be', () => {
    expect(readScript(`// ${'x'.repeat(70_000)}\n`, engine).problems.map((each) => each.message)).toEqual(['A script is at most 64 KB']);
  });
});
