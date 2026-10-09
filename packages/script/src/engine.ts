/*
  The port a script runs through (docs/PLAN-SCRIPTS.md §8.1): a sandbox of
  JavaScript with its own heap, run one slice at a time on the caller's own
  thread — the top level, or a call up to its first wait on the host, then
  each time something the host promised comes, up to the next. Between
  slices nothing of it runs, so stopping it is refusing what it waits for.

  The place supplies it, as it supplies storage: QuickJS-NG as WebAssembly
  on a server and in a browser (`@kraftverk/script-wasm`), the phone's own
  module there. Nothing crosses but text — JSON, by the conventions of the
  guest SDK — so nothing of the host can be reached from inside.
*/

/** How much a sandbox may hold, and how long it may run without coming back. */
export type SandboxLimits = {
  memoryBytes: number;
  stackBytes: number;
  /** The longest one slice may run. */
  sliceMs: number;
};

/**
 * What a sandbox may ask of the host, as global functions of one text
 * argument: answered at once (`sync`), or later (`async`, a promise inside).
 */
export type HostFunctions = {
  sync: Readonly<Record<string, (text: string) => string>>;
  async: Readonly<Record<string, (text: string) => Promise<string>>>;
};

/** Why a script stopped, in its own kind, said as it is. */
export type FaultKind = 'threw' | 'time' | 'memory' | 'stack' | 'stopped' | 'syntax' | 'busy';

/** A script that stopped: what it threw, or which limit it reached, and where, when it is known. */
export class ScriptFault extends Error {
  readonly kind: FaultKind;
  readonly line: number | null;
  readonly column: number | null;

  constructor(kind: FaultKind, message: string, at: { line?: number | null; column?: number | null } = {}) {
    super(message);
    this.name = 'ScriptFault';
    this.kind = kind;
    this.line = at.line ?? null;
    this.column = at.column ?? null;
  }
}

/** One sandbox: one heap, its own globals, disposed when its run or its look ends. */
export interface Sandbox {
  /** Runs `code` at the top level, within one slice: its last value, as JSON text (`null` when it has none). */
  evaluate(code: string, filename: string): string;
  /**
   * Calls a global function by name with `text` as its one argument, within one slice: what it returns, which must be text.
   * `sliceMs`: this call's own limit, in place of the sandbox's — a function loaded under one, and held to a shorter.
   */
  call(name: string, text: string, sliceMs?: number): string;
  /**
   * The same, for a function that may wait on the host: what its promise
   * comes to. Each thing the host promised that comes is one more slice.
   * Aborted, what it waits for is refused and it is stopped.
   */
  callAsync(name: string, text: string, signal?: AbortSignal): Promise<string>;
  /** The work it has done, every slice counted, in milliseconds. */
  readonly cpuMs: number;
  /** Lets go of its heap. Anything still waiting is stopped. */
  dispose(): void;
}

/**
 * An engine that opens at most `most` sandboxes at once: one more is
 * refused (`busy`) until one is let go — every sandbox shares the engine's
 * memory, so too many at once would make each other fail.
 */
export function limitedEngine(engine: ScriptEngine, most: number): ScriptEngine {
  let open = 0;
  return {
    open(limits, host) {
      if (open >= most) throw new ScriptFault('busy', `More than ${most} scripts are running at once: try again when one has ended`);
      const sandbox = engine.open(limits, host);
      open++;
      let gone = false;
      const dispose = sandbox.dispose.bind(sandbox);
      return Object.assign(sandbox, {
        dispose() {
          if (!gone) (gone = true), open--;
          dispose();
        },
      });
    },
  };
}

/** What opens sandboxes: one per place, made once. */
export interface ScriptEngine {
  open(limits: SandboxLimits, host: HostFunctions): Sandbox;
}
