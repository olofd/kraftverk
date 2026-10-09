import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { personalApi, type DeviceKeys } from '@kraftverk/hub';
import { keyId, newWebCryptoPair, webCryptoKey, type WebCryptoPair } from '@kraftverk/identity';
import { apiOver, hear, serveApi, transportOver, type MessageEnd } from '@kraftverk/message-port';
import { wasmScriptEngine } from '@kraftverk/script-wasm';
import { fromSqliteWasm, PERSONAL_SCHEMA, PersonalStore, schemaFingerprint, sealedWithKey, type SqlDatabase, type SqliteWasmDatabase } from '@kraftverk/store';

import { appFollower, appHub, readyDatabase } from './hub';
import { callerOf, databaseFile, oneAtATime, personalFile } from './home';
import type { ToPage, ToWorker } from './worker-messages';

/*
  A browser's kraftverk, in its worker (docs/PLAN-SHARED-CORE.md, "SQLite in
  the app" and phase 6). The device first: this browser's files, its
  accounts and their keys (docs/PLAN-WORLD-MODEL.md §10.6). Then a family
  inside it, as one of those accounts: its own, the hub on SQLite's own
  WebAssembly build; or a server's, with what this browser holds for it —
  the server's interface served by the page, this browser's own ways
  wrapped in. Its files are in the origin's private file system; it is
  served to the page over `@kraftverk/message-port` — the accounts as
  `personal`, the family as `api` — and it reaches the transports the page
  runs as if they were its own. One worker for all of it, so this
  browser's radio has one owner.

  Bundled on its own, beside `sqlite3.wasm` (scripts/build-home-worker.mjs):
  nothing here is the page's, and nothing of the page is here.

  One tab holds this browser's files at a time: the holder has the Web
  Lock, and lets go only when another tab asks for it (a BroadcastChannel),
  closing its databases first. The pool is never opened while another may
  hold it — `opfs-sahpool` deletes a pool it fails to open — and every one
  of its files is found free before it is.
*/

const LOCK = 'kraftverk.home';
const HAND_OVER = 'kraftverk.home';
const POOL = { name: 'kraftverk-home', directory: '.kraftverk-home' } as const;
/** How long a device being let go of by another tab is waited for. */
const FREE_WITHIN_MS = 15_000;

const scope = globalThis as unknown as MessageEnd;

/**
 * What runs this browser's scripts: QuickJS as WebAssembly, its .wasm
 * served beside this worker (scripts/build-home-worker.mjs). Made once, the
 * first time a home of its own is opened; none, said once, when it cannot be.
 */
let scripts: Promise<Awaited<ReturnType<typeof wasmScriptEngine>> | undefined> | null = null;
const scriptEngine = () =>
  (scripts ??= wasmScriptEngine({ location: new URL('./quickjs.wasm', import.meta.url).href }).catch((error: unknown) => {
    console.warn(`Scripts cannot run in this browser: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }));
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

/** This browser's keys, in IndexedDB: the secrets' sealing key, and each account's — Web Crypto keys whose private halves can never be read out. */
async function keyring() {
  const opening = indexedDB.open('kraftverk-home', 2);
  opening.onupgradeneeded = () => {
    for (const store of ['keys', 'person-keys']) if (!opening.result.objectStoreNames.contains(store)) opening.result.createObjectStore(store);
  };
  const db = await request(opening);
  return {
    get: (store: string, name: string) => request(db.transaction(store, 'readonly').objectStore(store).get(name)) as Promise<unknown>,
    put: (store: string, name: string, value: unknown) => request(db.transaction(store, 'readwrite').objectStore(store).put(value, name)),
    delete: (store: string, name: string) => request(db.transaction(store, 'readwrite').objectStore(store).delete(name)),
  };
}
type Keyring = Awaited<ReturnType<typeof keyring>>;

/**
 * The key this browser's secrets are sealed with: made once, kept sealed by
 * a key the browser made and will not let anything read out, in IndexedDB.
 * What the database holds is sealed; a copy of the profile read as text
 * opens none of it.
 */
async function secretsKey(keys: Keyring): Promise<Uint8Array> {
  let wrapping = (await keys.get('keys', 'wrapping')) as CryptoKey | undefined;
  if (!wrapping) {
    wrapping = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await keys.put('keys', 'wrapping', wrapping);
  }
  const sealed = (await keys.get('keys', 'secrets')) as { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined;
  if (sealed) {
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, wrapping, sealed.data));
    } catch {
      // Sealed by a key this browser no longer has: a new one, and its secrets are asked for again.
    }
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  await keys.put('keys', 'secrets', { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapping, key) });
  return key;
}

/** The accounts' keys: a Web Crypto pair each, not extractable, kept in IndexedDB as the objects they are — each by its own id. */
const accountKeys = (keys: Keyring): DeviceKeys => ({
  make: async () => {
    const pair = await newWebCryptoPair();
    const key = await webCryptoKey(pair);
    const id = keyId(key.publicJwk);
    await keys.put('person-keys', id, pair);
    return { id, key };
  },
  get: async (id) => {
    const pair = (await keys.get('person-keys', id)) as WebCryptoPair | undefined;
    return pair ? webCryptoKey(pair) : null;
  },
  forget: async (id) => void (await keys.delete('person-keys', id)),
});

type Pool = Awaited<ReturnType<Awaited<ReturnType<typeof sqlite3InitModule>>['installOpfsSAHPoolVfs']>>;
type Family = { nodeId: string; allowWrites(allowed: boolean): Promise<void>; stop(): Promise<void> };

/** The device, held: its pool, its accounts served, and the family open in it, if any. */
let device: { pool: Pool; keys: Keyring; family: Family | null; letGo(): Promise<void> } | null = null;

/** This browser's files, opened under the lock: the pool, the accounts, served. */
async function startDevice() {
  const since = Date.now();
  while (!(await poolIsFree())) {
    if (Date.now() - since > FREE_WITHIN_MS) throw new Error('Another tab is still letting go of kraftverk: try again in a moment');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs(POOL);
  // Room for the accounts', a family's and a server's files, and their journals, beside any an older schema left.
  if (Number(pool.getCapacity()) - pool.getFileCount() < 8) await pool.addCapacity(8);
  const keys = await keyring();
  const personal = readyDatabase(fromSqliteWasm(new pool.OpfsSAHPoolDb(`/${personalFile(schemaFingerprint(PERSONAL_SCHEMA))}`) as unknown as SqliteWasmDatabase), 'web', PERSONAL_SCHEMA);
  const stopServing = serveApi(personalApi({ store: new PersonalStore(personal), keys: accountKeys(keys) }), scope, 'personal');
  device = {
    pool,
    keys,
    family: null,
    letGo: async () => {
      await closeFamily();
      stopServing();
      personal.close();
      pool.pauseVfs();
    },
  };
}

/** The family open now, let go of. */
async function closeFamily() {
  const family = device?.family;
  if (!family || !device) return;
  device.family = null;
  await family.stop();
}

/** A family, opened in this device as one of its accounts: its database, its hub or its follower, served. */
async function openFamily(open: Extract<ToWorker, { kind: 'open' }>): Promise<Family> {
  if (!device) throw new Error('This browser’s kraftverk is not open');
  await closeFamily();
  const { pool, keys } = device;
  const opened = (file: string) => readyDatabase(fromSqliteWasm(new pool.OpfsSAHPoolDb(`/${file}`) as unknown as SqliteWasmDatabase), 'web');
  const fingerprint = schemaFingerprint();
  // A new schema is a new file: the one before is left as it was (strict version 1). One per family, and one per server.
  const database = opened(databaseFile(fingerprint, open.server?.key ?? open.family!.id));
  /** Another file this browser keeps, opened only if it is there and of this schema: a family brought in from it is offered, never written over. */
  const beside = (file: string): SqlDatabase | null => {
    if (!pool.getFileNames().includes(`/${file}`)) return null;
    try {
      return opened(file);
    } catch {
      return null;
    }
  };
  // With a server, the account's own family, offered to it; without, the copy it kept of the server it used last.
  const other = open.server ? (open.own ? beside(databaseFile(fingerprint, open.own.id)) : null) : open.copyOf ? beside(databaseFile(fingerprint, open.copyOf)) : null;

  let writes = open.writes;
  const served = new Set(open.serves);
  const place = {
    node: open.node,
    database,
    secrets: sealedWithKey(await secretsKey(keys)),
    platform: 'web' as const,
    // Every transport runs on the page, where the browser's own are; here, each is reached over the port.
    transport: (definition: Parameters<typeof transportOver>[0]) => (served.has(definition.id) ? transportOver(definition, scope, `transport:${definition.id}`) : null),
    readOnly: () => !writes,
  };
  const closeFiles = () => {
    database.close();
    other?.close();
  };

  if (open.server) {
    // The server's interface, as the page asks it: the page signs in, and its address is the page's to know.
    const follower = appFollower({ ...place, home: apiOver(scope, 'server'), ...(other ? { own: other } : {}) });
    await follower.start();
    const stopServing = serveApi(follower.api, scope, 'api');
    return {
      nodeId: follower.nodeId,
      allowWrites: async (allowed) => {
        writes = allowed;
        await follower.reopen();
      },
      stop: async () => {
        stopServing();
        await follower.stop();
        closeFiles();
      },
    };
  }

  const engine = await scriptEngine();
  const hub = appHub({ ...place, familyId: open.family!.id, ...(other ? { copy: other } : {}), ...(engine ? { scripts: engine } : {}) });
  await hub.start();
  const stopServing = serveApi(hub.as(callerOf(open.person)), scope, 'api');
  return {
    nodeId: hub.self.id,
    allowWrites: async (allowed) => {
      writes = allowed;
      await hub.sessions.sync(hub.catalog.list());
    },
    stop: async () => {
      stopServing();
      await hub.stop();
      closeFiles();
    },
  };
}

/** How long the device asks again for its lock before it says another tab has it. */
const LOCK_PATIENCE_MS = 3_000;

async function start(message: Extract<ToWorker, { kind: 'start' }>) {
  if (!navigator.locks || !navigator.storage?.getDirectory || !globalThis.crypto?.subtle) {
    say({ via: 'home', kind: 'failed', message: 'This browser cannot keep kraftverk here: it needs a secure page — HTTPS, or this computer itself — and a recent browser' });
    return;
  }
  const handOver = new BroadcastChannel(HAND_OVER);
  if (message.takeOver) handOver.postMessage({ ask: 'hand-over' });
  // Held already: maybe by another tab, which lets go within a moment when asked. Asked again for a while before it is said to be another tab's.
  const deadline = Date.now() + LOCK_PATIENCE_MS;
  while ((await holdDevice(message, handOver)) === 'busy') {
    if (Date.now() >= deadline) {
      say({ via: 'home', kind: 'busy' });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  handOver.close();
}

/** Holds the lock, and the device, until another tab asks for it; 'busy' when another holds the lock. */
function holdDevice(message: Extract<ToWorker, { kind: 'start' }>, handOver: BroadcastChannel): Promise<'busy' | 'held'> {
  return navigator.locks.request(LOCK, message.takeOver ? {} : { ifAvailable: true }, async (lock): Promise<'busy' | 'held'> => {
    if (!lock) return 'busy';
    const released = new Promise<void>((resolve) => {
      handOver.onmessage = (event) => {
        if ((event.data as { ask?: string } | null)?.ask === 'hand-over') resolve();
      };
    });
    try {
      await startDevice();
    } catch (error) {
      say({ via: 'home', kind: 'failed', message: (error as Error).message });
      return 'held';
    }
    say({ via: 'home', kind: 'started' });
    await released;
    await device?.letGo();
    device = null;
    say({ via: 'home', kind: 'ended' });
    return 'held';
  });
}

/** Opening and closing a family, one after another: one asked while another opens waits for it, never runs beside it. */
const inTurn = oneAtATime();

hear<ToWorker>(scope, 'home', (message) => {
  if (message.kind === 'start') void start(message);
  else if (message.kind === 'open')
    void inTurn(() =>
      openFamily(message).then(
        (family) => {
          if (device) device.family = family;
          say({ via: 'home', kind: 'ready', nodeId: family.nodeId as never });
        },
        (error: unknown) => say({ via: 'home', kind: 'failed', message: (error as Error).message })
      )
    );
  else if (message.kind === 'writes') void device?.family?.allowWrites(message.allowed);
  else if (message.kind === 'close') void inTurn(() => closeFamily().then(() => say({ via: 'home', kind: 'closed' })));
});
