import type { NotificationView } from '@kraftverk/api-contract';
import type { Actor } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * What a person is told (docs/PLAN-WORLD-MODEL.md §8.14), and where each of
 * their apps can be woken with it: their inbox — a record of what was said,
 * by whom, read or not — and each app's push endpoint. Kept 90 days.
 */

type Row = {
  id: string;
  person_id: string;
  home_id: string | null;
  level: NotificationView['level'];
  title: string;
  body: string | null;
  actor_kind: Actor['kind'];
  actor_id: string | null;
  actor_name: string;
  at: string;
  delivered_at: string | null;
  read_at: string | null;
};

const viewOf = (row: Row): NotificationView => ({
  id: row.id,
  homeId: row.home_id,
  level: row.level,
  title: row.title,
  body: row.body,
  from: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name },
  at: row.at,
  deliveredAt: row.delivered_at,
  readAt: row.read_at,
});

/** Where one app is woken: its push subscription, as the platform gave it. */
export type PushEndpoint = { nodeId: string; personId: string; provider: 'webpush' | 'apns' | 'fcm'; token: string; updatedAt: string };

export class NotificationStore {
  readonly #db: SqlDatabase;
  #next = 0;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** Something said to a person: in their inbox, not yet delivered. */
  add(input: { personId: string; homeId: string | null; level: NotificationView['level']; title: string; body: string | null; from: Actor; at: string }): NotificationView {
    const id = `nt-${Date.now().toString(36)}-${(this.#next++).toString(36)}`;
    this.#db
      .query('INSERT INTO notification (id, person_id, home_id, level, title, body, actor_kind, actor_id, actor_name, at, delivered_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
      .run(id, input.personId, input.homeId, input.level, input.title, input.body, input.from.kind, input.from.id ?? null, input.from.name, input.at);
    return this.get(id)!;
  }

  get(id: string): NotificationView | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM notification WHERE id = ?').get(id);
    return row ? viewOf(row) : null;
  }

  /** Whose a notification is. */
  ownerOf(id: string): string | null {
    return this.#db.query<{ person_id: string }, [string]>('SELECT person_id FROM notification WHERE id = ?').get(id)?.person_id ?? null;
  }

  /** A person's inbox, newest first. */
  inbox(personId: string, limit = 100): NotificationView[] {
    return this.#db.query<Row, [string, number]>('SELECT * FROM notification WHERE person_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(personId, limit).map(viewOf);
  }

  delivered(id: string, at: string): void {
    this.#db.query('UPDATE notification SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(at, id);
  }

  /** Read: one, or all of a person's. */
  read(personId: string, id: string | null, at: string): void {
    if (id) this.#db.query('UPDATE notification SET read_at = ? WHERE id = ? AND person_id = ? AND read_at IS NULL').run(at, id, personId);
    else this.#db.query('UPDATE notification SET read_at = ? WHERE person_id = ? AND read_at IS NULL').run(at, personId);
  }

  prune(before: string): void {
    this.#db.query('DELETE FROM notification WHERE at < ?').run(before);
  }

  // --- where each app is woken -------------------------------------------------------

  /** One app's push subscription, replaced as the platform renews it. */
  keepEndpoint(endpoint: Omit<PushEndpoint, 'updatedAt'>, at: string): void {
    this.#db
      .query(
        `INSERT INTO push_endpoint (node_id, person_id, provider, token, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (node_id) DO UPDATE SET person_id = excluded.person_id, provider = excluded.provider, token = excluded.token, updated_at = excluded.updated_at`
      )
      .run(endpoint.nodeId, endpoint.personId, endpoint.provider, endpoint.token, at);
  }

  /** Where a person's apps are woken. */
  endpointsOf(personId: string): PushEndpoint[] {
    return this.#db
      .query<{ node_id: string; person_id: string; provider: PushEndpoint['provider']; token: string; updated_at: string }, [string]>('SELECT * FROM push_endpoint WHERE person_id = ?')
      .all(personId)
      .map((row) => ({ nodeId: row.node_id, personId: row.person_id, provider: row.provider, token: row.token, updatedAt: row.updated_at }));
  }

  /** An app no longer woken: it said so, or its push service said it is gone. */
  forgetEndpoint(nodeId: string): void {
    this.#db.query('DELETE FROM push_endpoint WHERE node_id = ?').run(nodeId);
  }
}
