import { apiOver, hear, serveApi, serveTransport, type MessageEnd } from '@kraftverk/message-port';

import { TRANSPORT_ENTRIES } from '../../generated/transports';
import { clearPreference, readPreference, writePreference } from '../preferences';
import { HomeOpenElsewhere, type OpenHome, type OpenOptions } from './home';
import type { ToPage, ToWorker } from './worker-messages';

/*
  A browser's home (docs/PLAN-SHARED-CORE.md, phase 6): it runs in a worker
  of its own (`worker.ts`, bundled apart, beside SQLite's WebAssembly),
  because a lasting SQLite in a browser needs one — the browser's own home,
  or, with a server, what this browser holds for it. The page keeps the
  screens and the transports — Web Bluetooth and its chooser are the
  window's — and serves each to the worker, and with a server, the
  server's interface too: the page is signed in, and knows its address.
  The screens ask the home as `KraftverkApi`, over the worker's port. A
  phone's is `open.ts`, and has none of this.
*/

/** Where the worker is served: built beside the app (`npm run build:home-worker`), with `sqlite3.wasm` next to it. */
const WORKER = '/home/worker.js';

/** What a transport the page runs keeps between runs: this browser's own storage. */
const storeOf = (transport: string) => {
  const key = (name: string) => `kraftverk.transport.${transport}.${name}`;
  return { get: (name: string) => readPreference(key(name)), set: (name: string, value: string) => writePreference(key(name), value), delete: (name: string) => clearPreference(key(name)) };
};

/** Opens this browser's home in its worker — its own, or what it holds for a server — and starts it; or says another tab holds it. */
export async function openHome(options: OpenOptions): Promise<OpenHome> {
  const worker = new Worker(WORKER, { type: 'module', name: 'kraftverk home' });
  const end = worker as unknown as MessageEnd;
  const stops = [
    ...Object.entries(TRANSPORT_ENTRIES).map(([id, factory]) => serveTransport(end, factory, { store: storeOf(id) }, `transport:${id}`)),
    ...(options.server ? [serveApi(options.server.api, end, 'server')] : []),
  ];
  const send = (message: ToWorker) => worker.postMessage(message);
  const finish = () => {
    for (const stop of stops) stop();
    worker.terminate();
  };

  let ended: (why: 'handed-over') => void = () => {};
  let appId: string | null = null;
  let closed: () => void = () => {};
  const opened = new Promise<void>((resolve, reject) => {
    hear<ToPage>(end, 'home', (message) => {
      switch (message.kind) {
        case 'ready':
          appId = message.appId;
          return resolve();
        case 'busy':
          finish();
          return reject(new HomeOpenElsewhere());
        case 'failed':
          finish();
          return reject(new Error(message.message));
        case 'closed':
          finish();
          if (message.why === 'handed-over') ended('handed-over');
          return closed();
      }
    });
    worker.addEventListener('error', (event) => {
      finish();
      reject(new Error(`This browser's home could not start: ${event.message || 'its worker failed to load'}`));
    });
  });
  send({
    via: 'home',
    kind: 'open',
    serves: Object.keys(TRANSPORT_ENTRIES),
    takeOver: Boolean(options.takeOver),
    writes: false,
    server: options.server ? { key: options.server.key, name: options.name } : null,
  });
  await opened;

  return {
    api: apiOver(end, 'api'),
    appId,
    allowWrites: async (allowed) => send({ via: 'home', kind: 'writes', allowed }),
    close: () =>
      new Promise<void>((resolve) => {
        closed = resolve;
        send({ via: 'home', kind: 'close' });
      }),
    ended: new Promise((resolve) => {
      ended = resolve;
    }),
  };
}
