/**
 * Who a person is, as kraftverk knows them (docs/PLAN-WORLD-MODEL.md §10):
 * a stable id and a chain of signed statements, checked anywhere; the keys
 * that sign them, as a port each platform fills; recovery words; signing in
 * at a node by a challenge; and a sign-in provider's ID token, checked. No
 * storage, no platform, and no provider named.
 */
export { base64url, canonical, fromBase64url, hashOf, type Json } from './bytes.ts';
export * from './chain.ts';
export * from './challenge.ts';
export * from './id-token.ts';
export * from './keys.ts';
export * from './recovery.ts';
export type { WebCryptoKey, WebCryptoPair } from './web-crypto.ts';
