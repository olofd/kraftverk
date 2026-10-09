import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ScriptEngine } from '@kraftverk/script';
import { wasmScriptEngine } from '@kraftverk/script-wasm';

/*
  What runs scripts on a server (docs/PLAN-SCRIPTS.md §8.2): QuickJS-NG as
  WebAssembly, its .wasm read from where npm put it. Made once, as the
  server starts. When it cannot be made the server runs on without
  scripts, and says why: an automation that uses one says so too.
*/

export async function serverScripts(log: (message: string) => void): Promise<ScriptEngine | undefined> {
  try {
    const file = fileURLToPath(import.meta.resolve('@jitl/quickjs-ng-wasmfile-release-sync/wasm'));
    const wasm = readFileSync(file);
    return await wasmScriptEngine({ binary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
  } catch (error) {
    log(`SCRIPTS: none can run here: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
