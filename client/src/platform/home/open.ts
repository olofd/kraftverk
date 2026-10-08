import Constants from 'expo-constants';
import { getRandomValues } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { openDatabaseSync } from 'expo-sqlite';

import { personalApi, type DeviceKeys } from '@kraftverk/hub';
import { keyId, newSecret, softwareKey } from '@kraftverk/identity';
import { fromExpoSqlite, PERSONAL_SCHEMA, PersonalStore, schemaFingerprint, sealedWithKey } from '@kraftverk/store';

import { TRANSPORT_ENTRIES } from '../../generated/transports';
import { appFollower, appHub, readyDatabase } from './hub';
import { callerOf, databaseFile, personalFile, type OpenDevice, type OpenHome, type OpenOptions } from './home';

/*
  A phone's kraftverk (docs/PLAN-SHARED-CORE.md, phase 6): in the app's own
  process, beside its screens, as the server runs one beside its routes —
  no worker, no messages, nothing a browser needs. The device first: its
  accounts in the personal store, each one's key in the phone's secure
  storage (docs/PLAN-WORLD-MODEL.md §10.7). Then a family: an account's
  own on expo-sqlite, or what this app holds for a server, in a file of its
  own for that server. Its transports are the phone's own
  (`transports.ts`), and the key its secrets are sealed with is kept in the
  secure storage too. A browser's is `open.web.ts`.
*/

// A phone has no `crypto.getRandomValues` of its own: expo-crypto's, for ids, keys and the cipher.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: { ...globalThis.crypto, getRandomValues }, configurable: true });
}

const SECRETS_KEY = 'kraftverk.secrets-key';
const MADE_BY = Constants.expoConfig?.version ?? 'app';

/** A key's name in the secure store, which takes letters, digits, dots, dashes and underscores. */
const storeName = (id: string) => `kraftverk.key.${id}`;

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const bytesOf = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/** The key a phone seals its secrets with: made once, kept in its secure storage, never in a database. */
async function secretsKey(): Promise<Uint8Array> {
  const kept = await SecureStore.getItemAsync(SECRETS_KEY);
  if (kept?.length === 64) return bytesOf(kept);
  const key = crypto.getRandomValues(new Uint8Array(32));
  await SecureStore.setItemAsync(SECRETS_KEY, hex(key));
  return key;
}

/**
 * The accounts' keys, in the phone's secure storage (the Keychain; Android's
 * Keystore-encrypted storage), each read into memory only to sign. The
 * platform's own keystore module is the upgrade behind this port
 * (docs/PLAN-WORLD-MODEL.md §10.7).
 */
const secureStoreKeys: DeviceKeys = {
  make: async () => {
    const secret = newSecret();
    const key = softwareKey(secret);
    const id = keyId(key.publicJwk);
    await SecureStore.setItemAsync(storeName(id), hex(secret));
    return { id, key };
  },
  get: async (id) => {
    const kept = await SecureStore.getItemAsync(storeName(id));
    return kept?.length === 64 ? softwareKey(bytesOf(kept)) : null;
  },
  forget: async (id) => SecureStore.deleteItemAsync(storeName(id)),
};

/** Another file this app keeps, opened only if it is there and of this schema: a home brought in from it is offered, never written over. */
function beside(file: string) {
  const opened = fromExpoSqlite(openDatabaseSync(file));
  try {
    return readyDatabase(opened, MADE_BY);
  } catch {
    opened.close();
    return null;
  }
}

/** A family, opened as one of this phone's accounts — its own, or what it holds for a server — and started. */
async function openFamily(options: OpenOptions): Promise<OpenHome> {
  // A new schema is a new file: the one before is left as it was (strict version 1).
  const fingerprint = schemaFingerprint();
  const database = readyDatabase(fromExpoSqlite(openDatabaseSync(databaseFile(fingerprint, options.server?.key ?? options.family!.id))), MADE_BY);
  let writes = false;
  const place = {
    node: options.node,
    database,
    secrets: sealedWithKey(await secretsKey()),
    platform: 'native' as const,
    transport: (definition: { id: string }) => TRANSPORT_ENTRIES[definition.id] ?? null,
    readOnly: () => !writes,
  };

  if (options.server) {
    // The account's own family, kept on this phone: offered to the server.
    const own = options.own ? beside(databaseFile(fingerprint, options.own.id)) : null;
    const follower = appFollower({ ...place, home: options.server.api, ...(own ? { own } : {}) });
    await follower.start();
    return {
      api: follower.api,
      nodeId: follower.nodeId,
      allowWrites: async (allowed) => {
        writes = allowed;
        await follower.reopen();
      },
      close: async () => {
        await follower.stop();
        database.close();
        own?.close();
      },
    };
  }

  // The copy this app kept of the server it used last: offered to keep.
  const copy = options.copyOf ? beside(databaseFile(fingerprint, options.copyOf)) : null;
  const hub = appHub({ ...place, familyId: options.family!.id, ...(copy ? { copy } : {}) });
  await hub.start();
  return {
    api: hub.as(callerOf(options.person)),
    nodeId: hub.self.id,
    allowWrites: async (allowed) => {
      writes = allowed;
      // Its sessions open again under the new rule.
      await hub.sessions.sync(hub.catalog.list());
    },
    close: async () => {
      await hub.stop();
      database.close();
      copy?.close();
    },
  };
}

/** Opens this phone: its accounts, and the families it opens for them, one at a time. Nothing else on a phone holds it: there is nothing to take over. */
export async function openDevice(_options: { takeOver?: boolean } = {}): Promise<OpenDevice> {
  const personalDb = readyDatabase(fromExpoSqlite(openDatabaseSync(personalFile(schemaFingerprint(PERSONAL_SCHEMA)))), MADE_BY, PERSONAL_SCHEMA);
  let family: OpenHome | null = null;
  return {
    personal: personalApi({ store: new PersonalStore(personalDb), keys: secureStoreKeys }),
    async openHome(options) {
      await family?.close();
      family = null;
      family = await openFamily(options);
      return family;
    },
    async close() {
      await family?.close();
      family = null;
      personalDb.close();
    },
    // One app, one device: nothing on a phone asks for it.
    ended: new Promise<'handed-over'>(() => {}),
  };
}
