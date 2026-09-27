/**
 * The contract between kraftverk and its device types.
 *
 * Types and validation only — no runtime, no dependencies — so it costs a
 * device type nothing to depend on, and the server, the app and every device
 * type agree on one definition of what a device is, what it measures and what
 * it can do. The design is docs/ARCHITECTURE.md §4.
 *
 * The contract suite is a separate entry, `@kraftverk/device-sdk/testing`, so
 * nothing that ships loads it.
 */

export * from './identity.ts';
export * from './schema.ts';
export * from './telemetry.ts';
export * from './capabilities.ts';
export * from './device-type.ts';
export * from './setup.ts';
export * from './validate.ts';

// The v1 extension contract, until the last plugin is a device type (step 5).
export * from './v1/descriptor.ts';
export * from './v1/grid-relay.ts';
export * from './v1/plugin.ts';
export * from './v1/panel.ts';
