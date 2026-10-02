import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { apiOver, hear, serveApi, transportOver, type MessageEnd } from '@kraftverk/message-port';
import { fromSqliteWasm, schemaFingerprint, type SqliteWasmDatabase } from '@kraftverk/store';

import { sealedWithKey } from '../cipher';
import { appHolding, appHub, readyDatabase } from './hub';
import { databaseFile, OWNER } from './home';
import type { ToPage, ToWorker } from './worker-messages';

/*
  A browser's home, in its worker (docs/PLAN-SHARED-CORE.md, "SQLite in the
  app" and phase 6): without a server, the hub on SQLite's own WebAssembly
  build; with one, what this browser holds for it — the server's interface
  served by the page, this browser's own ways wrapped in. Its file is in
  the origin's private file system; it is served to the page over
  `@kraftverk/message-port` — the screens ask it as `KraftverkApi` — and it
  reaches the transports the page runs as if they were its own. One worker
  for both, so this browser's radio has one owner.

  Bundled on its own, beside `sqlite3.wasm` (scripts/build-home-worker.mjs):
  nothing here is the page's, and nothing of the page is here.

  One tab holds a home at a time: the holder has the Web Lock, and lets go
  only when another tab asks for it (a BroadcastChannel), closing its
  database first. The pool is never opened while another may hold it —
  `opfs-sahpool` deletes a pool it fails to open — and every one of its
  files is found free before it is.
*/

const LOCK = 'kraftverk.home';
const HAND_OVER = 'kraftverk.home';
const POOL = { name: 'kraftverk-home', directory: '.kraftverk-home' } as const;
/** How long a home being let go of by another tab is waited for. */
const FREE_WITHIN_MS = 15_000;

const scope = globalThis as unknown as MessageEnd;
const say = (message: ToPage) => scope.postMessage(message);

/** A directory of the origin's private file system, as far as it is used here. */
type Directory = {
  getDirectoryHandle(name: string): Promise<Directory>;
  values(): AsyncIterable<{ kind: 'file' | 'directory'; createSyncAccessHandle?: () => Promise<{ close(): void }> }>;
};

/** Whether no other tab holds a file of the pool: each is opened for a moment, and let go. */
async function poolIsFree(): Promise<boolean> {
  let files: Directory;
  try {
    const root = (await navigator.storage.getDirectory()) as unknown as Directory;
    files = await (await root.getDirectoryHandle(POOL.directory)).getDirectoryHandle('.opaque');
  } catch {
    return true; // no pool yet
  }
  for await (const entry of files.values()) {
    if (entry.kind !== 'file' || !entry.createSyncAccessHandle) continue;
    try {
      (await entry.createSyncAccessHandle()).close();
    } catch {
      return false;
    }
  }
  return true;
}

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * The key this browser's secrets are sealed with: made once, kept sealed by
 * a key the browser made and will not let anything read out, in IndexedDB.
 * What the database holds is sealed; a copy of the profile read as text
 * opens none of it.
 */
async function secretsKey(): Promise<Uint8Array> {
  const opening = indexedDB.open('kraftverk-home', 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('keys');
  const db = await request(opening);
  const kept = (name: string) => request(db.transaction('keys', 'readonly').objectStore('keys').get(name));
  const keep = (name: string, value: unknown) => request(db.transaction('keys', 'readwrite').objectStore('keys').put(value, name));

  let wrapping = (await kept('wrapping')) as CryptoKey | undefined;
  if (!wrapping) {
    wrapping = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await keep('wrapping', wrapping);
  }
  const sealed = (await kept('secrets')) as { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined;
  if (sealed) {
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, wrapping, sealed.data));
    } catch {
      // Sealed by a key this browser no longer has: a new one, and its secrets are asked for again.
    }
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  await keep('secrets', { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapping, key) });
  return key;
}

/** The home, opened under the lock: its database, its hub, served. */
async function start(open: Extract<ToWorker, { kind: 'open' }>) {
  const since = Date.now();
  while (!(await poolIsFree())) {
    if (Date.now() - since > FREE_WITHIN_MS) throw new Error('Another tab is still letting go of this home: try again in a moment');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs(POOL);
  // Room for this schema's file and its journal, beside any an older schema left.
  if (Number(pool.getCapacity()) - pool.getFileCount() < 4) await pool.addCapacity(4);
  // A new schema is a new file: the one before is left as it was (strict version 1). With a server, one of its own.
  const database = readyDatabase(fromSqliteWasm(new pool.OpfsSAHPoolDb(`/${databaseFile(schemaFingerprint(), open.server?.key)}`) as unknown as SqliteWasmDatabase), 'web');

  let writes = open.writes;
  const served = new Set(open.serves);
  const place = {
    database,
    secrets: sealedWithKey(await secretsKey()),
    platform: 'web' as const,
    // Every transport runs on the page, where the browser's own are; here, each is reached over the port.
    transport: (definition: Parameters<typeof transportOver>[0]) => (served.has(definition.id) ? transportOver(definition, scope, `transport:${definition.id}`) : null),
    readOnly: () => !writes,
  };
  /** Everything let go, in order: nothing served, the home stopped, the database closed, the pool's files released. */
  const letGo = async (stopServing: () => void, stopHome: () => Promise<void>) => {
    stopServing();
    await stopHome();
    database.close();
    pool.pauseVfs();
  };

  if (open.server) {
    // The server's interface, as the page asks it: the page signs in, and its address is the page's to know.
    const holding = appHolding({ ...place, home: apiOver(scope, 'server'), name: open.server.name });
    await holding.start();
    const stopServing = serveApi(holding.api, scope, 'api');
    return {
      appId: holding.appId,
      allowWrites: async (allowed: boolean) => {
        writes = allowed;
        await holding.reopen();
      },
      stop: () => letGo(stopServing, () => holding.stop()),
    };
  }

  const hub = appHub(place);
  await hub.start();
  const stopServing = serveApi(hub.as(OWNER), scope, 'api');
  return {
    appId: null,
    allowWrites: async (allowed: boolean) => {
      writes = allowed;
      await hub.sessions.sync(hub.catalog.list());
    },
    stop: () => letGo(stopServing, () => hub.stop()),
  };
}

let home: Awaited<ReturnType<typeof start>> | null = null;
let closing: ((why: 'asked') => void) | null = null;

async function open(message: Extract<ToWorker, { kind: 'open' }>) {
  if (!navigator.locks || !navigator.storage?.getDirectory || !globalThis.crypto?.subtle) {
    say({ via: 'home', kind: 'failed', message: 'This browser cannot keep a home of its own here: it needs a secure page — HTTPS, or this computer itself — and a recent browser' });
    return;
  }
  const handOver = new BroadcastChannel(HAND_OVER);
  if (message.takeOver) handOver.postMessage({ ask: 'hand-over' });
  await navigator.locks.request(LOCK, message.takeOver ? {} : { ifAvailable: true }, async (lock) => {
    if (!lock) return say({ via: 'home', kind: 'busy' });
    const released = new Promise<'handed-over' | 'asked'>((resolve) => {
      handOver.onmessage = (event) => {
        if ((event.data as { ask?: string } | null)?.ask === 'hand-over') resolve('handed-over');
      };
      closing = resolve;
    });
    try {
      home = await start(message);
    } catch (error) {
      say({ via: 'home', kind: 'failed', message: (error as Error).message });
      return;
    }
    say({ via: 'home', kind: 'ready', appId: home.appId });
    const why = await released;
    await home.stop();
    home = null;
    say({ via: 'home', kind: 'closed', why });
  });
  handOver.close();
}

hear<ToWorker>(scope, 'home', (message) => {
  if (message.kind === 'open') void open(message);
  else if (message.kind === 'writes') void home?.allowWrites(message.allowed);
  else if (message.kind === 'close') closing?.('asked');
});
