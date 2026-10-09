/**
 * Scripts in TypeScript, for automations (README.md, docs/PLAN-SCRIPTS.md):
 * compiled to JavaScript, their shape read in a sandbox, the guest SDK they
 * import, and the port a sandbox is reached through. Pure — no platform and
 * no engine: the place gives the engine (`@kraftverk/script-wasm`, the
 * phone's own module).
 */

export * from './engine.ts';
export * from './compile.ts';
export * from './read.ts';
export * from './types.ts';
