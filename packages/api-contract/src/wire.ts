/**
 * What the HTTP API carries beside its shapes, said once for the server that
 * checks it and the app that sends it.
 */

/**
 * Every request that changes anything carries this header. A page on another
 * site cannot add it to a cross-origin request without asking the server
 * first, and the server says no: what stops a forged request.
 */
export const CLIENT_HEADER = 'x-kraftverk-client';

/** The live socket's close code when the session it was opened with has ended. */
export const SIGNED_OUT = 4401;

/** An account's password is at least this long: this login may be all that stands between the internet and the devices. */
export const PASSWORD_MIN = 12;

/**
 * The most a node following a master sends it in one call: readings and
 * events for one device, entries of its timeline. The master refuses more,
 * and the node sends no more — what is left waits for the next call.
 */
export const HELD_LIMITS = { readings: 2000, events: 500, audit: 500 } as const;

/** Where, under the API, the configuration's JSON Schema is — open, as an editor cannot log in. */
export const CONFIG_SCHEMA_PATH = '/config/schema.json';
