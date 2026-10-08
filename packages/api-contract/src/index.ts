/**
 * What a home answers, as shapes — declared once, here (README.md).
 *
 * `KraftverkApi` (`api.ts`) is the one interface every home answers, however
 * it is reached: a server over HTTP, a home in the app's own worker, a node
 * following a master. Every answer and input it names is declared beside it,
 * one file to an area — devices, setup, live, nodes, automations,
 * configuration, the assistant, accounts — so a field changed on one side
 * fails the typecheck on the other instead of failing on a phone. Types,
 * `ApiError` — a refusal in words, whichever way a home is reached
 * (`error.ts`) — and the few words of the wire (`wire.ts`).
 *
 * What a device *is* — its type, its description (parts, attributes, events),
 * its setup steps — is declared in `@kraftverk/device-sdk`, and imported from
 * there; a rule from `@kraftverk/automation`. What is declared here is only
 * the envelope a home wraps around it: a saved device with its connections
 * and links, a setup draft, a transport as a node runs it. No device type is
 * named.
 */

export { ApiError, API_ERROR_STATUS, isApiErrorKind, type ApiErrorKind, type ApiErrorWire } from './error.ts';
export { CLIENT_HEADER, CONFIG_SCHEMA_PATH, HELD_LIMITS, PASSWORD_MIN, SIGNED_OUT } from './wire.ts';

// Each area of a home, as it answers; the interface itself last.
export type * from './devices.ts';
export type * from './setup.ts';
export type * from './live.ts';
export type * from './nodes.ts';
export type * from './homes.ts';
export type * from './media.ts';
export type * from './automations.ts';
export type * from './configuration.ts';
export type * from './assistant.ts';
export type * from './accounts.ts';
export type * from './map.ts';
export type * from './api.ts';
