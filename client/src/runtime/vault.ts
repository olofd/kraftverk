import { clearPreference, readPreference, writePreference } from '../lib/preferences';

/**
 * Where this app keeps the secrets of connections it holds — a Tuya local
 * key — never in plaintext (docs/ARCHITECTURE.md step 21).
 *
 * On the web they are sealed with AES-GCM under a key the browser generated
 * as non-extractable and keeps in IndexedDB: script can use it, but nothing —
 * not this app, not a copy of the profile's storage read as text — can read
 * it out. What `localStorage` holds is ciphertext. Where there is no such key
 * — the browser's crypto exists only on a secure origin, and so does Web
 * Bluetooth, the one way a browser holds a device with secrets — they are
 * kept in memory only, never written down. A phone keeps nothing across a
 * restart yet: its preferences are memory too.
 *
 * Reads are synchronous, from what `ready()` loaded; writes update that at once
 * and are sealed and stored behind it.
 */

type Secrets = Record<string, Record<string, string>>;

/** Supplies the sealing key, or null where there is none. Tests bring their own. */
export type KeyProvider = () => Promise<CryptoKey | null>;

const DATABASE = 'kraftverk-vault';
const STORE = 'keys';

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** The browser's own key for `name`, made on first use: non-extractable, kept in IndexedDB. */
export const browserKey =
  (name: string): KeyProvider =>
  async () => {
    if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) return null;
    try {
      const opening = indexedDB.open(DATABASE, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
      const db = await request(opening);
      const existing = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(name) as IDBRequest<CryptoKey | undefined>);
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(key, name));
      return key;
    } catch {
      return null;
    }
  };

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export class SecretVault {
  #secrets: Secrets = {};
  #key: CryptoKey | null = null;
  #ready: Promise<void>;
  #saving: Promise<void> = Promise.resolve();

  constructor(
    private options: {
      /** Where the sealed secrets are stored. */
      storageKey: string;
      keys?: KeyProvider;
      /** Plaintext left by an older version, moved in and then cleared. */
      legacy?: () => Secrets | null;
      clearLegacy?: () => void;
    }
  ) {
    this.#ready = this.#load();
  }

  /** Resolves once the stored secrets have been opened. Reads before then see none. */
  ready(): Promise<void> {
    return this.#ready;
  }

  get(connectionId: string): Record<string, string> {
    return this.#secrets[connectionId] ?? {};
  }

  /** Adds to, or changes, a connection's secrets. */
  set(connectionId: string, secrets: Record<string, string>): void {
    this.#secrets = { ...this.#secrets, [connectionId]: { ...this.get(connectionId), ...secrets } };
    this.#save();
  }

  delete(connectionId: string): void {
    const { [connectionId]: _gone, ...rest } = this.#secrets;
    this.#secrets = rest;
    this.#save();
  }

  /** Waits for what has been written to be stored. */
  flushed(): Promise<void> {
    return this.#saving;
  }

  async #load(): Promise<void> {
    this.#key = await (this.options.keys ?? browserKey(this.options.storageKey))().catch(() => null);
    const sealed = readPreference(this.options.storageKey);
    if (sealed && this.#key) {
      try {
        const { iv, data } = JSON.parse(sealed) as { iv: string; data: string };
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, this.#key, fromBase64(data));
        this.#secrets = { ...(JSON.parse(new TextDecoder().decode(plain)) as Secrets), ...this.#secrets };
      } catch {
        // Sealed under a key this browser no longer has: those secrets are gone, and are asked for again.
      }
    }
    const legacy = this.options.legacy?.();
    if (legacy && Object.keys(legacy).length) {
      for (const [connectionId, secrets] of Object.entries(legacy)) this.#secrets[connectionId] = { ...secrets, ...this.#secrets[connectionId] };
      await this.#write(this.#secrets);
    }
    this.options.clearLegacy?.();
  }

  /** Stores what is held now, sealed, after whatever was being stored before it. */
  #save(): void {
    const snapshot = this.#secrets;
    this.#saving = this.#saving
      .then(() => this.#ready)
      .then(() => this.#write(snapshot))
      .catch(() => undefined);
  }

  async #write(snapshot: Secrets): Promise<void> {
    if (!this.#key) return; // nowhere safe to put them: memory only
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.#key, new TextEncoder().encode(JSON.stringify(snapshot)));
    writePreference(this.options.storageKey, JSON.stringify({ iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }));
  }
}

/** The plaintext an older version kept under `key`, as secrets by connection. */
export function legacySecrets(key: string, pick: (stored: unknown) => Secrets | null = (stored) => stored as Secrets): { legacy: () => Secrets | null; clearLegacy: () => void } {
  return {
    legacy: () => {
      try {
        const raw = readPreference(key);
        return raw ? pick(JSON.parse(raw)) : null;
      } catch {
        return null;
      }
    },
    clearLegacy: () => clearPreference(key),
  };
}
