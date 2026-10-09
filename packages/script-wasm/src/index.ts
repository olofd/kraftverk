import variant from '@jitl/quickjs-ng-wasmfile-release-sync';
import { ScriptFault, type HostFunctions, type Sandbox, type SandboxLimits, type ScriptEngine } from '@kraftverk/script';
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten-core';

/*
  A script sandbox over QuickJS-NG as WebAssembly (docs/PLAN-SCRIPTS.md
  §8.2): what runs scripts on a server and in a browser's home worker. One
  WebAssembly module per place; a runtime and a context per sandbox, its
  stack held to its limit, and an interrupt handler that stops a slice at
  its deadline.

  Memory is held twice over, because QuickJS built for WebAssembly cannot
  count what it holds (it has no malloc_usable_size there: a runtime's own
  limit stops one allocation larger than it, and nothing else):
  - the engine's whole memory is ours, made with a maximum, so an
    allocation past it fails inside, as "out of memory";
  - a sandbox is charged with whatever the engine's memory has to grow
    while it runs, and stopped when that passes its own limit.
  What others let go of is used again before the memory grows, so a sandbox
  may hold what is free besides: the engine's maximum bounds them all.

  The place gives it the .wasm: a server reads it from disk, a browser's
  worker names where it is served. Its memory never shrinks.
*/

/** Where the engine's WebAssembly is: served at a URL, or its bytes. */
export type WasmSource = { location: string } | { binary: ArrayBuffer };

/**
 * WebAssembly's memory, as far as it is used here. Not one of the globals
 * every place has — Hermes has none — so it is reached as this engine's own:
 * it runs only where WebAssembly does.
 */
type WasmMemory = { readonly buffer: ArrayBuffer };
const { WebAssembly: Wasm } = globalThis as unknown as { WebAssembly: { Memory: new (descriptor: { initial: number; maximum: number }) => WasmMemory } };

const PAGE = 65_536;
/** What the WebAssembly build starts with: 16 MB. */
const INITIAL_BYTES = 16 * 1024 * 1024;
/** The most the engine holds, every sandbox together, unless the place says less. */
const MOST_BYTES = 320 * 1024 * 1024;

/** The engine, its WebAssembly compiled: made once per place. `mostBytes`: all its sandboxes may hold together. */
export async function wasmScriptEngine(wasm: WasmSource, options: { mostBytes?: number } = {}): Promise<ScriptEngine> {
  const most = Math.max(INITIAL_BYTES, options.mostBytes ?? MOST_BYTES);
  const memory = new Wasm.Memory({ initial: INITIAL_BYTES / PAGE, maximum: Math.floor(most / PAGE) });
  const where = 'location' in wasm ? { wasmLocation: wasm.location } : { wasmBinary: wasm.binary };
  const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { ...where, wasmMemory: memory as Parameters<typeof newVariant>[1]['wasmMemory'] }));
  return { open: (limits, host) => new WasmSandbox(module, memory, limits, host) };
}

/** A clock that only goes forward, where there is one; the wall's otherwise. */
const monotonic = (globalThis as { performance?: { now(): number } }).performance;
const now = monotonic ? () => monotonic.now() : () => Date.now();

/** What a thrown value inside says of itself: its name, its words, where. */
type Thrown = { name?: unknown; message?: unknown; stack?: unknown };

/** A line and column of the script's own, from where QuickJS says it was. */
const placeOf = (stack: unknown, filename: string): { line?: number; column?: number } => {
  if (typeof stack !== 'string') return {};
  const at = stack.match(new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)(?::(\\d+))?`));
  return at ? { line: Number(at[1]), ...(at[2] ? { column: Number(at[2]) } : {}) } : {};
};

class WasmSandbox implements Sandbox {
  readonly #runtime: QuickJSRuntime;
  readonly #context: QuickJSContext;
  readonly #limits: SandboxLimits;
  readonly #memory: WasmMemory;
  #cpu = 0;
  #deadline: number | null = null;
  /** What the engine's memory has grown by while this sandbox ran, its slices before this one counted. */
  #grown = 0;
  /** How big the engine's memory was as this slice began. */
  #sliceBytes = 0;
  /** Stopped for what it held, not for its time. */
  #overMemory = false;
  #stopped = false;
  #disposed = false;
  /** The script's file, as the last `evaluate` named it: where a fault is placed. */
  #filename = 'script.js';
  /** What the host promised and has not yet given. */
  readonly #pending = new Set<QuickJSDeferredPromise>();
  /** The one call that waits on the host, and how its answer is given. */
  #waiting: { handle: QuickJSHandle; resolve: (text: string) => void; reject: (fault: ScriptFault) => void } | null = null;

  constructor(module: QuickJSWASMModule, memory: WasmMemory, limits: SandboxLimits, host: HostFunctions) {
    this.#limits = limits;
    this.#memory = memory;
    this.#runtime = module.newRuntime();
    // One allocation larger than the limit: the runtime's own check, all it can make here.
    this.#runtime.setMemoryLimit(limits.memoryBytes);
    this.#runtime.setMaxStackSize(limits.stackBytes);
    this.#runtime.setInterruptHandler(() => {
      if (this.#stopped) return true;
      if (this.#grown + this.#memory.buffer.byteLength - this.#sliceBytes > this.#limits.memoryBytes) return (this.#overMemory = true);
      return this.#deadline !== null && now() > this.#deadline;
    });
    this.#context = this.#runtime.newContext();
    const context = this.#context;

    for (const [name, answer] of Object.entries(host.sync)) {
      const fn = context.newFunction(name, (arg) => {
        try {
          return context.newString(answer(this.#textOf(arg)));
        } catch (error) {
          return { error: context.newError(error instanceof Error ? error.message : String(error)) };
        }
      });
      context.setProp(context.global, name, fn);
      fn.dispose();
    }

    for (const [name, answer] of Object.entries(host.async)) {
      const fn = context.newFunction(name, (arg) => {
        const promised = context.newPromise();
        this.#pending.add(promised);
        answer(this.#textOf(arg)).then(
          (text) =>
            this.#settled(promised, () => {
              const value = context.newString(text);
              promised.resolve(value);
              value.dispose();
            }),
          (error: unknown) =>
            this.#settled(promised, () => {
              const thrown = context.newError(error instanceof Error ? error.message : String(error));
              promised.reject(thrown);
              thrown.dispose();
            })
        );
        return promised.handle;
      });
      context.setProp(context.global, name, fn);
      fn.dispose();
    }
  }

  get cpuMs(): number {
    return this.#cpu;
  }

  evaluate(code: string, filename: string): string {
    this.#filename = filename;
    return this.#slice(() => {
      const result = this.#context.evalCode(code, filename, { type: 'global', strict: true });
      if (result.error) throw this.#faultOf(result.error);
      const value = this.#context.dump(result.value) as unknown;
      result.value.dispose();
      return JSON.stringify(value ?? null);
    });
  }

  call(name: string, text: string): string {
    return this.#slice(() => {
      const handle = this.#invoke(name, text);
      try {
        if (this.#context.typeof(handle) !== 'string') throw new ScriptFault('threw', `${name} answered with something other than text`);
        return this.#context.getString(handle);
      } finally {
        handle.dispose();
      }
    });
  }

  callAsync(name: string, text: string, signal?: AbortSignal): Promise<string> {
    if (this.#waiting) return Promise.reject(new ScriptFault('threw', 'A sandbox answers one call at a time'));
    return new Promise<string>((resolve, reject) => {
      let handle: QuickJSHandle;
      try {
        handle = this.#slice(() => {
          const called = this.#invoke(name, text);
          this.#drain();
          return called;
        });
      } catch (fault) {
        reject(fault);
        return;
      }
      this.#waiting = { handle, resolve, reject };
      if (signal?.aborted) this.#stop();
      else signal?.addEventListener('abort', () => this.#stop(), { once: true });
      this.#look();
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#stop();
    this.#disposed = true;
    this.#context.dispose();
    this.#runtime.dispose();
  }

  /** One slice: run until it comes back, or until its deadline, counting the work. */
  #slice<T>(work: () => T): T {
    if (this.#disposed || this.#stopped) throw new ScriptFault('stopped', 'The script was stopped');
    const started = now();
    this.#deadline = started + this.#limits.sliceMs;
    this.#sliceBytes = this.#memory.buffer.byteLength;
    try {
      return work();
    } finally {
      this.#deadline = null;
      this.#cpu += now() - started;
      this.#grown += this.#memory.buffer.byteLength - this.#sliceBytes;
    }
  }

  /** Calls a global function by name with one text argument: its value, a handle the caller lets go of. */
  #invoke(name: string, text: string): QuickJSHandle {
    const context = this.#context;
    const fn = context.getProp(context.global, name);
    const arg = context.newString(text);
    try {
      if (context.typeof(fn) !== 'function') throw new ScriptFault('threw', `There is no ${name} to call`);
      const result = context.callFunction(fn, context.undefined, arg);
      if (result.error) throw this.#faultOf(result.error);
      return result.value;
    } finally {
      fn.dispose();
      arg.dispose();
    }
  }

  /** Runs what came due inside — each promise's next part — within the slice it is in. */
  #drain(): void {
    const ran = this.#runtime.executePendingJobs();
    if (ran.error) throw this.#faultOf(ran.error);
  }

  /** Something the host promised has come: given inside, then what it lets run, as one more slice. */
  #settled(promised: QuickJSDeferredPromise, give: () => void): void {
    if (!this.#pending.delete(promised)) return;
    if (this.#disposed || this.#stopped) {
      promised.dispose();
      return;
    }
    try {
      this.#slice(() => {
        give();
        this.#drain();
      });
    } catch (fault) {
      this.#fail(fault instanceof ScriptFault ? fault : new ScriptFault('threw', String(fault)));
      return;
    }
    this.#look();
  }

  /** Whether the call that waits has come to something: its answer, its fault, or a wait for nothing. */
  #look(): void {
    const waiting = this.#waiting;
    if (!waiting) return;
    const state = this.#context.getPromiseState(waiting.handle);
    if (state.type === 'pending') {
      if (this.#pending.size === 0) this.#fail(new ScriptFault('threw', 'It waits for something that never comes'));
      return;
    }
    this.#waiting = null;
    if (state.type === 'fulfilled') {
      const isText = this.#context.typeof(state.value) === 'string';
      const text = isText ? this.#context.getString(state.value) : null;
      if (!state.notAPromise) state.value.dispose();
      waiting.handle.dispose();
      if (text === null) waiting.reject(new ScriptFault('threw', 'It answered with something other than text'));
      else waiting.resolve(text);
      return;
    }
    const fault = this.#faultOf(state.error);
    waiting.handle.dispose();
    waiting.reject(fault);
  }

  /** The call that waits ends in a fault. */
  #fail(fault: ScriptFault): void {
    const waiting = this.#waiting;
    if (!waiting) return;
    this.#waiting = null;
    waiting.handle.dispose();
    waiting.reject(fault);
  }

  /** Stopped: what it waits for is refused, and nothing of it runs again. */
  #stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const promised of this.#pending) promised.dispose();
    this.#pending.clear();
    this.#fail(new ScriptFault('stopped', 'The script was stopped'));
  }

  /** A thrown value inside, as the fault it is: a limit reached, or what the script threw. Lets go of it. */
  #faultOf(handle: QuickJSHandle): ScriptFault {
    let thrown: Thrown = {};
    try {
      const dumped = this.#context.dump(handle) as unknown;
      thrown = typeof dumped === 'object' && dumped !== null ? (dumped as Thrown) : { message: String(dumped) };
    } catch {
      thrown = { name: 'InternalError', message: 'out of memory' };
    } finally {
      handle.dispose();
    }
    const name = typeof thrown.name === 'string' ? thrown.name : 'Error';
    const message = typeof thrown.message === 'string' ? thrown.message : String(thrown.message ?? '');
    const at = placeOf(thrown.stack, this.#filename);
    const needed = () => new ScriptFault('memory', `It needed more than ${Math.round(this.#limits.memoryBytes / 1024 / 1024)} MB`, at);
    if (/interrupted/i.test(message)) {
      if (this.#stopped) return new ScriptFault('stopped', 'The script was stopped');
      if (this.#overMemory) return needed();
      return new ScriptFault('time', `It ran for more than ${this.#limits.sliceMs} ms without waiting`, at);
    }
    if (/out of memory/i.test(message)) return needed();
    if (/stack overflow|call stack size/i.test(message)) return new ScriptFault('stack', 'It called itself too deeply', at);
    if (name === 'SyntaxError') return new ScriptFault('syntax', message, at);
    return new ScriptFault('threw', name === 'Error' ? message : `${name}: ${message}`, at);
  }

  /** What crossed in: text, as the host functions take it. */
  #textOf(arg: QuickJSHandle | undefined): string {
    if (!arg) return '';
    return this.#context.typeof(arg) === 'string' ? this.#context.getString(arg) : JSON.stringify(this.#context.dump(arg) ?? null);
  }
}
