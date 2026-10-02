/**
 * The server's HTTP surface, as shapes: declared once in
 * `@kraftverk/api-contract`, which the server imports too. Re-exported here so
 * the app has one place to import from, with the few values that go with them.
 */

export type * from '@kraftverk/api-contract';
export { CATEGORIES, isOnline, LINK_KINDS, savedDeviceId } from '@kraftverk/device-sdk';
export { CONFIG_SCHEMA_PATH, PASSWORD_MIN } from '@kraftverk/api-contract';
