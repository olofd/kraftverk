import Constants from 'expo-constants';
import { getRandomValues } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { openDatabaseSync } from 'expo-sqlite';

import { fromExpoSqlite, schemaFingerprint } from '@kraftverk/store';

import { TRANSPORT_ENTRIES } from '../../generated/transports';
import { sealedWithKey } from '../cipher';
import { appHolding, appHub, readyDatabase } from './hub';
import { databaseFile, OWNER, type OpenHome, type OpenOptions } from './home';

/*
  A phone's home (docs/PLAN-SHARED-CORE.md, phase 6): in the app's own
  process, beside its screens, as the server runs one beside its routes —
  no worker, no messages, nothing a browser needs. Without a server, the
  hub on expo-sqlite; with one, what this app holds for it, kept in a file
  of its own for that server. Either way its transports are the phone's
  own (`transports.ts`), and the key its secrets are sealed with is kept in
  the phone's secure storage. A browser's is `open.web.ts`.
*/

// A phone has no `crypto.getRandomValues` of its own: expo-crypto's, for ids and the cipher.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: { ...globalThis.crypto, getRandomValues }, configurable: true });
}

const SECRETS_KEY = 'kraftverk.secrets-key';

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

/** Opens the phone's home — its own, or what it holds for a server — and starts it. */
export async function openHome(options: OpenOptions): Promise<OpenHome> {
  // A new schema is a new file: the one before is left as it was (strict version 1).
  const database = readyDatabase(fromExpoSqlite(openDatabaseSync(databaseFile(schemaFingerprint(), options.server?.key))), Constants.expoConfig?.version ?? 'app');
  let writes = false;
  const place = {
    database,
    secrets: sealedWithKey(await secretsKey()),
    platform: 'native' as const,
    transport: (definition: { id: string }) => TRANSPORT_ENTRIES[definition.id] ?? null,
    readOnly: () => !writes,
  };
  // One app, one home: nothing on a phone asks for it.
  const ended = new Promise<'handed-over'>(() => {});

  /** Another file this app keeps, opened only if it is there and of this schema: a home brought in from it is offered, never written over. */
  const beside = (file: string) => {
    const opened = fromExpoSqlite(openDatabaseSync(file));
    try {
      return readyDatabase(opened, Constants.expoConfig?.version ?? 'app');
    } catch {
      opened.close();
      return null;
    }
  };

  if (options.server) {
    // The home this app kept itself before it had a server: offered to it.
    const own = beside(databaseFile(schemaFingerprint()));
    const holding = appHolding({ ...place, home: options.server.api, name: options.name, ...(own ? { own } : {}) });
    await holding.start();
    return {
      api: holding.api,
      appId: holding.appId,
      allowWrites: async (allowed) => {
        writes = allowed;
        await holding.reopen();
      },
      close: async () => {
        await holding.stop();
        database.close();
        own?.close();
      },
      ended,
    };
  }

  // The copy this app kept of the server it used last: offered to keep.
  const copy = options.copyOf ? beside(databaseFile(schemaFingerprint(), options.copyOf)) : null;
  const hub = appHub({ ...place, ...(copy ? { copy } : {}) });
  await hub.start();
  return {
    api: hub.as(OWNER),
    appId: null,
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
    ended,
  };
}
