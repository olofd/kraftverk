import vm from 'node:vm';

import { ScriptFault, type ScriptEngine } from '@kraftverk/script';

/**
 * A stand-in for a place's script engine, in the hub's tests only: the port
 * (`@kraftverk/script`) over `node:vm`, which is no sandbox — a test's own
 * scripts are trusted — so a hub here keeps and reads scripts without
 * QuickJS, which the hub may not import. The engine itself is tested in
 * `@kraftverk/script-wasm`, against the cases every engine keeps.
 */
export const testScriptEngine: ScriptEngine = {
  open(limits, host) {
    const context = vm.createContext({ ...host.sync, ...host.async });
    const faultOf = (error: unknown): ScriptFault => (error instanceof ScriptFault ? error : new ScriptFault(error instanceof Error && error.name === 'SyntaxError' ? 'syntax' : 'threw', error instanceof Error ? error.message : String(error)));
    const fn = (name: string) => {
      const found = (context as Record<string, unknown>)[name];
      if (typeof found !== 'function') throw new ScriptFault('threw', `There is no ${name} to call`);
      return found as (text: string) => unknown;
    };
    return {
      cpuMs: 0,
      evaluate(code, filename) {
        try {
          return JSON.stringify(vm.runInContext(code, context, { filename, timeout: limits.sliceMs }) ?? null);
        } catch (error) {
          throw faultOf(error);
        }
      },
      call(name, text) {
        try {
          return String(fn(name)(text));
        } catch (error) {
          throw faultOf(error);
        }
      },
      async callAsync(name, text) {
        try {
          return String(await fn(name)(text));
        } catch (error) {
          throw faultOf(error);
        }
      },
      dispose() {},
    };
  },
};
