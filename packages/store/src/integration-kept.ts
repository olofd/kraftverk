import type { IntegrationKept } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';
import type { SecretsAtRest } from './secrets.ts';

/**
 * One integration's own keeping, in `integration_kv`: what its setups keep
 * between them — an account's listing with its keys, a code given once —
 * sealed as a connection's secrets are, and reached by no other integration.
 */
export function integrationKept(db: SqlDatabase, secrets: SecretsAtRest, integration: string): IntegrationKept {
  return {
    get: (key) => {
      const row = db.query<{ value: string; encrypted: number }, [string, string]>('SELECT value, encrypted FROM integration_kv WHERE integration = ? AND key = ?').get(integration, key);
      return row ? secrets.open(row.value, row.encrypted === 1) : null;
    },
    set: (key, value, label) => {
      if (value === null) {
        forgetKept(db, integration, key);
        return;
      }
      const sealed = secrets.seal(value);
      db.query(
        `INSERT INTO integration_kv (integration, key, value, encrypted, label, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (integration, key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, label = excluded.label, updated_at = excluded.updated_at`
      ).run(integration, key, sealed.value, sealed.encrypted ? 1 : 0, label ?? key, new Date().toISOString());
    },
  };
}

/** What an integration keeps, as its page lists it: what each is, and when it was kept — never its value. */
export function keptItems(db: SqlDatabase, integration: string): { key: string; label: string; at: string }[] {
  return db
    .query<{ key: string; label: string; updated_at: string }, [string]>('SELECT key, label, updated_at FROM integration_kv WHERE integration = ? ORDER BY key')
    .all(integration)
    .map((row) => ({ key: row.key, label: row.label, at: row.updated_at }));
}

export function forgetKept(db: SqlDatabase, integration: string, key: string): void {
  db.query('DELETE FROM integration_kv WHERE integration = ? AND key = ?').run(integration, key);
}
