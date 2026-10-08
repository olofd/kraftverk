import type { PersonalApi } from '@kraftverk/api-contract';
import { apiOver, hear, serveApi, serveTransport, type MessageEnd } from '@kraftverk/message-port';

import { TRANSPORT_ENTRIES } from '../../generated/transports';
import { clearPreference, readPreference, writePreference } from '../preferences';
import { HomeOpenElsewhere, oneAtATime, type OpenDevice, type OpenHome, type OpenOptions } from './home';
import type { ToPage, ToWorker } from './worker-messages';

/*
  A browser's kraftverk (docs/PLAN-SHARED-CORE.md, phase 6): it runs in a
  worker of its own (`worker.ts`, bundled apart, beside SQLite's
  WebAssembly), because a lasting SQLite in a browser needs one — this
  browser's accounts first, then a family inside it, the account's own or,
  with a server, what this browser holds for it. The page keeps the
  screens and the transports — Web Bluetooth and its chooser are the
  window's — and serves each to the worker, and with a server, the
  server's interface too: the page is signed in, and knows its address.
  The screens ask the accounts as `PersonalApi` and the family as
  `KraftverkApi`, over the worker's port. A phone's is `open.ts`, and has
  none of this.
*/

/** Where the worker is served: built beside the app (`npm run build:home-worker`), with `sqlite3.wasm` next to it. */
const WORKER = '/home/worker.js';

/** What a transport the page runs keeps between runs: this browser's own storage. */
const storeOf = (transport: string) => {
  const key = (name: string) => `kraftverk.transport.${transport}.${name}`;
  return { get: (name: string) => readPreference(key(name)), set: (name: string, value: string) => writePreference(key(name), value), delete: (name: string) => clearPreference(key(name)) };
};

/** Opens this browser's kraftverk in its worker — its accounts, served — or says another tab holds it. */
export async function openDevice(options: { takeOver?: boolean } = {}): Promise<OpenDevice> {
  const worker = new Worker(WORKER, { type: 'module', name: 'kraftverk' });
  const end = worker as unknown as MessageEnd;
  const transports = Object.entries(TRANSPORT_ENTRIES).map(([id, factory]) => serveTransport(end, factory, { store: storeOf(id) }, `transport:${id}`));
  const send = (message: ToWorker) => worker.postMessage(message);
  let stopServer: (() => void) | null = null;
  const finish = () => {
    for (const stop of transports) stop();
    stopServer?.();
    worker.terminate();
  };

  /** What the worker says next is the answer to what is waited for now: the device starting, a family opening, closing. */
  let waiting: { resolve: (message: ToPage) => void; reject: (error: Error) => void } | null = null;
  const next = () => new Promise<ToPage>((resolve, reject) => (waiting = { resolve, reject }));
  let ended: (why: 'handed-over') => void = () => {};
  hear<ToPage>(end, 'home', (message) => {
    if (message.kind === 'ended') {
      finish();
      ended('handed-over');
      return;
    }
    const answer = waiting;
    waiting = null;
    if (!answer) return;
    if (message.kind === 'busy') answer.reject(new HomeOpenElsewhere());
    else if (message.kind === 'failed') answer.reject(new Error(message.message));
    else answer.resolve(message);
  });
  worker.addEventListener('error', (event) => {
    finish();
    waiting?.reject(new Error(`kraftverk could not start in this browser: ${event.message || 'its worker failed to load'}`));
  });

  const started = next();
  send({ via: 'home', kind: 'start', takeOver: Boolean(options.takeOver) });
  try {
    await started;
  } catch (error) {
    finish();
    throw error;
  }

  /**
   * One request of the worker at a time, each answered before the next is
   * sent: what it says next is the answer to the one waited for. A family
   * opened while another is still opening waits its turn, never takes the
   * other's answer.
   */
  const inTurn = oneAtATime();

  /** The family open now: closed before another opens, and before the device lets go. */
  let current: OpenHome | null = null;
  const closeFamily = async () => {
    if (!current) return;
    current = null;
    const closed = next();
    send({ via: 'home', kind: 'close' });
    await closed.catch(() => undefined);
    stopServer?.();
    stopServer = null;
  };

  return {
    personal: apiOver<PersonalApi>(end, 'personal'),
    openHome: (open: OpenOptions) => inTurn(async () => {
      await closeFamily();
      if (open.server) stopServer = serveApi(open.server.api, end, 'server');
      const ready = next();
      send({
        via: 'home',
        kind: 'open',
        serves: Object.keys(TRANSPORT_ENTRIES),
        writes: false,
        node: open.node,
        person: open.person,
        server: open.server ? { key: open.server.key } : null,
        family: open.server ? null : (open.family ?? null),
        copyOf: open.server ? null : (open.copyOf ?? null),
        own: open.server ? (open.own ?? null) : null,
      });
      const answer = await ready;
      const nodeId = answer.kind === 'ready' ? answer.nodeId : open.node.id;
      const home: OpenHome = {
        api: apiOver(end, 'api'),
        nodeId,
        allowWrites: async (allowed) => send({ via: 'home', kind: 'writes', allowed }),
        close: () => inTurn(async () => {
          if (current === home) await closeFamily();
        }),
      };
      current = home;
      return home;
    }),
    close: () => inTurn(async () => {
      await closeFamily();
      finish();
    }),
    ended: new Promise((resolve) => {
      ended = resolve;
    }),
  };
}
