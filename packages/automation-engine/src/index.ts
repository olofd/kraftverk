/**
 * Runs kraftverk's automations (README.md): triggers, steps, runs and their
 * logs, rehearsal of a rule against what devices said, and the library of
 * recipes and functions the installed packages bring.
 *
 * Pure. Where automations are kept is a port it declares (`storage.ts`),
 * the store's to fill; devices it reaches through `EngineDevice`, every
 * action through the gateway. The server and the app run it alike.
 */

export * from './engine.ts';
export * from './storage.ts';
export * from './library.ts';
export * from './rehearse.ts';
export * from './runlog.ts';
export * from './series.ts';
