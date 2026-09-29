import type { ClientRecord } from '@kraftverk/api-contract';
import { randomBytes } from 'node:crypto';

import { db } from '../history/db.ts';

/**
 * The phones and browsers running the app, as the server knows them
 * (docs/DATA-MODEL.md §3).
 *
 * "Held by this phone" needs a phone to point at, with a name the app can show:
 * "Bluetooth, from Olof's iPhone". A client registers once, when it is first
 * signed in, and says which transports it has — Web Bluetooth in Chrome, none in
 * Firefox — so the add flow can offer what that client can hold.
 */

export type { ClientRecord };

type Row = { id: string; user_id: string; name: string; platform: string; transports: string; created_at: string; last_seen_at: string };

const toRecord = (row: Row): ClientRecord => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  platform: row.platform === 'native' ? 'native' : 'web',
  transports: JSON.parse(row.transports) as string[],
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

export class ClientStore {
  all(): ClientRecord[] {
    return db().query<Row, []>('SELECT * FROM client').all().map(toRecord);
  }

  get(id: string): ClientRecord | null {
    const row = db().query<Row, [string]>('SELECT * FROM client WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  forUser(userId: string): ClientRecord[] {
    return db().query<Row, [string]>('SELECT * FROM client WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId).map(toRecord);
  }

  /**
   * Registers a client, or brings an existing one up to date. An id the app
   * kept from before is honoured only when it belongs to the same account: a
   * client cannot claim to be somebody else's phone.
   */
  register(input: { id?: string; userId: string; name: string; platform: 'web' | 'native'; transports: string[] }): ClientRecord {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : null;
    if (existing && existing.userId === input.userId) {
      db()
        .query('UPDATE client SET name = ?, platform = ?, transports = ?, last_seen_at = ? WHERE id = ?')
        .run(input.name, input.platform, JSON.stringify(input.transports), now, existing.id);
      return { ...existing, name: input.name, platform: input.platform, transports: input.transports, lastSeenAt: now };
    }
    const record: ClientRecord = {
      id: `k-${randomBytes(6).toString('hex')}`,
      userId: input.userId,
      name: input.name,
      platform: input.platform,
      transports: input.transports,
      createdAt: now,
      lastSeenAt: now,
    };
    db()
      .query('INSERT INTO client (id, user_id, name, platform, transports, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.userId, record.name, record.platform, JSON.stringify(record.transports), now, now);
    return record;
  }

  /** Forgets a client, and every connection it held. */
  remove(id: string): void {
    db().query('DELETE FROM client WHERE id = ?').run(id);
  }
}
