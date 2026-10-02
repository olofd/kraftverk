/**
 * kraftverk over a message port (README.md): a home's `KraftverkApi` and a
 * `Transport`, each served on one side of a port and the same interface on
 * the other — so a hub in a browser's worker is asked as one in the
 * process is, and reaches the transports a page runs as if they were its
 * own (docs/PLAN-SHARED-CORE.md, phase 6). Pure: any end that posts
 * messages and hears them will do.
 */

export * from './end.ts';
export * from './api.ts';
export * from './transport.ts';
