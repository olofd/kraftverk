/**
 * The contract between kraftverk and its device types, protocols and
 * transports.
 *
 * Types, validation and a few pure helpers — no runtime, no dependencies — so it
 * costs a package nothing to depend on, and the server, the app and every
 * package agree on one definition of what a device is, how it is reached, what
 * it measures and what it can do. The design is docs/ARCHITECTURE.md §4 and
 * docs/DATA-MODEL.md §2.
 *
 * The contract suite and the fake channels are a separate entry,
 * `@kraftverk/device-sdk/testing`, so nothing that ships loads them.
 */

export * from './identity.ts';
export * from './schema.ts';
export * from './telemetry.ts';
export * from './capabilities.ts';
export * from './categories.ts';
export * from './links.ts';
export * from './connection.ts';
export * from './device-type.ts';
export * from './setup.ts';
export * from './validate.ts';
