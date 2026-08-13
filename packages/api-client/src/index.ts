/**
 * Talking to the kraftverk server.
 *
 * This moved out of the app for the same reason the interface primitives did: a
 * device package draws its own screens, and one of those screens reads register
 * dumps. It cannot import the app's HTTP client to do that, so the client is a
 * package and the app is simply its first consumer.
 *
 * Where the server *is* remains the app's problem — Expo resolves that from the
 * dev host, which is not knowledge an API client should carry.
 */

export * from './types';
export * from './api';
