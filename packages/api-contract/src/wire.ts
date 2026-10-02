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

/** Where, under the API, the configuration's JSON Schema is — open, as an editor cannot log in. */
export const CONFIG_SCHEMA_PATH = '/config/schema.json';
