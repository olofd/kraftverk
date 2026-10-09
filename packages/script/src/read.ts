import { SCRIPT_LIMITS, type ScriptCheck, type ScriptProblem } from '@kraftverk/automation';

import { compileScript, type Compiled } from './compile.ts';
import { ScriptFault, type Sandbox, type ScriptEngine } from './engine.ts';
import { GUEST_SDK } from './generated/guest.ts';
import { readSignatures, type ScriptCall } from './signature.ts';

/*
  Reading a script (docs/PLAN-SCRIPTS.md §8.4): how long it is, whether it
  compiles, what it imports, and what it declares — its exported functions'
  signatures, as written (signature.ts) — and then its top level run once,
  in a sandbox that reaches nothing, so what fails as it loads is said now
  and not when an automation first runs it. No compiler of types is needed,
  so a hub reads a script wherever it runs; the editor checks its types
  besides.
*/

/** What a script imports: the SDK, and the home's API. */
const IMPORTS: readonly string[] = ['kraftverk', 'kraftverk/api'];

/** A script read: its JavaScript, its shape and how each export is called — or what is wrong with it. */
export type ReadScript = ScriptCheck & { compiled: Compiled | null; calls: Record<string, ScriptCall> };

const problem = (message: string, at: { line?: number | null; column?: number | null } = {}): ScriptProblem => ({ message, line: at.line ?? null, column: at.column ?? null });

/**
 * The SDK and then the script, run into a sandbox: what every sandbox a
 * script runs in starts from. The script's lines are its own, as written —
 * the line it is wrapped in begins on its first.
 */
export function loadScript(sandbox: Sandbox, compiled: Compiled): void {
  sandbox.evaluate(GUEST_SDK, 'kraftverk.js');
  sandbox.evaluate(`__kraftverk.load(function (exports, require) {${compiled.code}\n});`, 'script.ts');
}

/**
 * A script read on `engine`: compiled, its imports looked at, its shape read
 * from its signatures, and its top level run once, with nothing of the home
 * in reach.
 */
export function readScript(source: string, engine: ScriptEngine): ReadScript {
  if (new TextEncoder().encode(source).length > SCRIPT_LIMITS.sourceBytes) return { compiled: null, shape: null, calls: {}, problems: [problem(`A script is at most ${SCRIPT_LIMITS.sourceBytes / 1024} KB`)] };
  const compiledOr = compileScript(source);
  if ('problem' in compiledOr) return { compiled: null, shape: null, calls: {}, problems: [compiledOr.problem] };
  const { compiled } = compiledOr;
  const problems: ScriptProblem[] = compiled.imports.filter((name) => !IMPORTS.includes(name)).map((name) => problem(`A script imports only "kraftverk" and "kraftverk/api", not "${name}"`));
  if (problems.length) return { compiled, shape: null, calls: {}, problems };
  const { shape, calls, problems: declared } = readSignatures(source);
  if (declared.length) return { compiled, shape: null, calls: {}, problems: declared };

  const sandbox = engine.open({ memoryBytes: SCRIPT_LIMITS.functionMemoryBytes, stackBytes: 256 * 1024, sliceMs: SCRIPT_LIMITS.describeMs }, { sync: {}, async: {} });
  try {
    loadScript(sandbox, compiled);
    // Each export it declares is a function as it runs, too.
    const exported = JSON.parse(sandbox.call('__describe', '')) as Record<string, string>;
    for (const name of Object.keys(calls)) if (exported[name] !== 'function') problems.push(problem(`${name} is not a function as it runs`));
    return problems.length ? { compiled, shape: null, calls: {}, problems } : { compiled, shape, calls, problems };
  } catch (error) {
    if (!(error instanceof ScriptFault)) throw error;
    return { compiled, shape: null, calls: {}, problems: [problem(error.kind === 'time' ? `Its top level ran for more than ${SCRIPT_LIMITS.describeMs} ms: keep the work inside its steps and functions` : error.message, error)] };
  } finally {
    sandbox.dispose();
  }
}
