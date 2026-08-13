/**
 * The contract between kraftverk and its extensions.
 *
 * Types and validation only — no runtime, no dependencies — so it costs a
 * plugin nothing to depend on, and the host and every plugin agree on one
 * definition of what a capability is and who may invoke it.
 *
 * The design is in docs/PLUGIN-ARCHITECTURE.md.
 */

export * from './capabilities.ts';
export * from './device.ts';
export * from './schema.ts';
export * from './plugin.ts';
export * from './panel.ts';
