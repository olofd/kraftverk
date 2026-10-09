import { ScriptFault, type HostFunctions, type Sandbox, type SandboxLimits, type ScriptEngine } from './engine.ts';

/*
  What every engine does alike (docs/PLAN-SCRIPTS.md §13): the contract
  between the WebAssembly engine and the phone's own, so a script that runs
  on one runs on the other. Each case opens its own sandbox and throws when
  the engine is not as the port says. Run by `bun test` against the
  WebAssembly engine, and on the phone by its own screen.
*/

export type ConformanceCase = { name: string; run(engine: ScriptEngine): Promise<void> };

const LIMITS: SandboxLimits = { memoryBytes: 8 * 1024 * 1024, stackBytes: 256 * 1024, sliceMs: 50 };
const NO_HOST: HostFunctions = { sync: {}, async: {} };

const same = (actual: unknown, expected: unknown, what: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
};

/** The fault `work` stops with; an error when it does not. */
const faultOf = async (work: () => unknown): Promise<ScriptFault> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof ScriptFault) return error;
    throw error;
  }
  throw new Error('It did not stop');
};

/** A sandbox for one case, let go of after it, whatever happens. */
const inSandbox = async (engine: ScriptEngine, work: (sandbox: Sandbox) => Promise<void> | void, host: HostFunctions = NO_HOST, limits: SandboxLimits = LIMITS): Promise<void> => {
  const sandbox = engine.open(limits, host);
  try {
    await work(sandbox);
  } finally {
    sandbox.dispose();
  }
};

export const CONFORMANCE: readonly ConformanceCase[] = [
  {
    name: 'evaluates at the top level, and answers its last value as JSON',
    run: (engine) =>
      inSandbox(engine, (sandbox) => {
        same(sandbox.evaluate('1 + 2', 'a.js'), '3', 'a sum');
        same(JSON.parse(sandbox.evaluate('({ a: [1, "two", null], b: true })', 'a.js')), { a: [1, 'two', null], b: true }, 'an object');
        same(sandbox.evaluate('undefined', 'a.js'), 'null', 'nothing');
      }),
  },
  {
    name: 'keeps what its top level defines, for the calls after it',
    run: (engine) =>
      inSandbox(engine, (sandbox) => {
        sandbox.evaluate('globalThis.shout = (text) => text.toUpperCase() + "!"; globalThis.counted = 0;', 'a.js');
        same(sandbox.call('shout', 'hej'), 'HEJ!', 'a call');
        same(sandbox.call('shout', 'å ä ö'), 'Å Ä Ö!', 'text beyond ASCII');
      }),
  },
  {
    name: 'calls the host at once, and waits on it',
    run: (engine) =>
      inSandbox(
        engine,
        async (sandbox) => {
          sandbox.evaluate('globalThis.twice = async (text) => { const one = await later(text); const two = await later(one); return now("") + ":" + two; };', 'a.js');
          same(await sandbox.callAsync('twice', 'x'), 'now:x++', 'two waits');
        },
        { sync: { now: () => 'now' }, async: { later: async (text) => `${text}+` } }
      ),
  },
  {
    name: 'catches what the host refuses, and stops with what it does not catch',
    run: (engine) =>
      inSandbox(
        engine,
        async (sandbox) => {
          sandbox.evaluate('globalThis.caught = async () => { try { await no(""); return "no"; } catch (e) { return "caught: " + e.message; } }; globalThis.uncaught = async () => { await no(""); return "no"; };', 'a.js');
          same(await sandbox.callAsync('caught', ''), 'caught: Not that', 'caught');
          const fault = await faultOf(() => sandbox.callAsync('uncaught', ''));
          same([fault.kind, fault.message], ['threw', 'Not that'], 'uncaught');
        },
        { sync: {}, async: { no: () => Promise.reject(new Error('Not that')) } }
      ),
  },
  {
    name: 'stops a slice that runs too long, as time',
    run: (engine) =>
      inSandbox(engine, async (sandbox) => {
        same((await faultOf(() => sandbox.evaluate('for (;;) {}', 'a.js'))).kind, 'time', 'a loop');
      }),
  },
  {
    name: 'stops at its memory, and its stack',
    run: (engine) =>
      inSandbox(
        engine,
        async (sandbox) => {
        same((await faultOf(() => sandbox.evaluate('const all = []; for (;;) all.push(new Array(10000).fill(1));', 'a.js'))).kind, 'memory', 'memory');
        same((await faultOf(() => sandbox.evaluate('const deeper = (n) => deeper(n + 1) + 1; deeper(0);', 'b.js'))).kind, 'stack', 'stack');
        },
        NO_HOST,
        // Room to fill its heap before its slice ends: a small heap, and time.
        { memoryBytes: 2 * 1024 * 1024, stackBytes: 256 * 1024, sliceMs: 5_000 }
      ),
  },
  {
    name: 'says where it threw, and where its words do not parse',
    run: (engine) =>
      inSandbox(engine, async (sandbox) => {
        const thrown = await faultOf(() => sandbox.evaluate('const a = 1;\nconst b = 2;\nthrow new Error("Here");', 'mine.js'));
        same([thrown.kind, thrown.message, thrown.line], ['threw', 'Here', 3], 'thrown');
        const typed = await faultOf(() => sandbox.evaluate('null.x', 'mine.js'));
        same(typed.kind, 'threw', 'a type error');
        same((await faultOf(() => sandbox.evaluate('const = ;', 'mine.js'))).kind, 'syntax', 'a syntax error');
      }),
  },
  {
    name: 'is stopped while it waits, and waits for nothing that never comes',
    run: (engine) =>
      inSandbox(
        engine,
        async (sandbox) => {
          sandbox.evaluate('globalThis.slow = async () => await never(""); globalThis.forever = () => new Promise(() => {});', 'a.js');
          const stop = new AbortController();
          const stopped = faultOf(() => sandbox.callAsync('slow', '', stop.signal));
          stop.abort();
          same((await stopped).kind, 'stopped', 'stopped');
          same((await faultOf(() => sandbox.call('shout', 'x'))).kind, 'stopped', 'nothing runs after');
        },
        { sync: {}, async: { never: () => new Promise<string>(() => {}) } }
      ).then(() =>
        inSandbox(engine, async (sandbox) => {
          sandbox.evaluate('globalThis.forever = () => new Promise(() => {});', 'a.js');
          const fault = await faultOf(() => sandbox.callAsync('forever', ''));
          same([fault.kind, fault.message], ['threw', 'It waits for something that never comes'], 'nothing to wait for');
        })
      ),
  },
  {
    name: 'has the language and nothing of the host: no network, no files, no timers',
    run: (engine) =>
      inSandbox(engine, (sandbox) => {
        const missing = ['fetch', 'XMLHttpRequest', 'WebSocket', 'require', 'process', 'Bun', 'Deno', 'setTimeout', 'setInterval', 'importScripts', 'postMessage'];
        same(JSON.parse(sandbox.evaluate(`[${missing.map((name) => `typeof ${name}`).join(', ')}]`, 'a.js')), missing.map(() => 'undefined'), 'what is missing');
        same(JSON.parse(sandbox.evaluate('[typeof Math.random(), typeof Date.now(), typeof JSON.parse, typeof Promise, typeof Symbol, typeof Map]', 'a.js')), ['number', 'number', 'function', 'function', 'function', 'function'], 'the language');
      }),
  },
  {
    name: 'keeps each sandbox to itself, and counts the work it does',
    run: async (engine) => {
      const one = engine.open(LIMITS, NO_HOST);
      const two = engine.open(LIMITS, NO_HOST);
      try {
        one.evaluate('globalThis.mine = "one"; let n = 0; for (let i = 0; i < 200000; i++) n += i;', 'a.js');
        same(two.evaluate('typeof mine', 'b.js'), '"undefined"', 'the other');
        if (!(one.cpuMs > 0)) throw new Error('Its work was not counted');
      } finally {
        one.dispose();
        two.dispose();
      }
    },
  },
];
