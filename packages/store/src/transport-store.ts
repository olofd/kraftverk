import type { TransportStore } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/** One transport's own store, in `transport_kv`: what it keeps between runs, and no other transport can reach. */
export function transportStore(db: SqlDatabase, transport: string): TransportStore {
  return {
    get: (key) => db.query<{ value: string }, [string, string]>('SELECT value FROM transport_kv WHERE transport = ? AND key = ?').get(transport, key)?.value ?? null,
    set: (key, value) => {
      db
        .query('INSERT INTO transport_kv (transport, key, value) VALUES (?, ?, ?) ON CONFLICT (transport, key) DO UPDATE SET value = excluded.value')
        .run(transport, key, value);
    },
    delete: (key) => {
      db.query('DELETE FROM transport_kv WHERE transport = ? AND key = ?').run(transport, key);
    },
  };
}
