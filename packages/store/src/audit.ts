import type { AuditEntry } from '@kraftverk/api-contract';
import type { ActorKind, AuditRecord, ResourceKind } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

type AuditRow = { id: number; at: string; kind: string; actor_kind: ActorKind; actor_id: string | null; actor_name: string; resource_kind: ResourceKind | null; resource: string | null; summary: string; detail: string | null };

/** The timeline: every line of what was done, by whom, to what. */
export class AuditLog {
  readonly #db: SqlDatabase;
  readonly #listeners = new Set<(entry: AuditRecord) => void>();

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** Adds a line. What the API returns of it is the contract's `AuditEntry`. Whoever listens hears it after, written or not. */
  record(entry: AuditRecord): void {
    try {
      this.#db
        // Sent again by a node that was not sure it arrived: the entry already kept.
        .query<unknown, (string | null)[]>('INSERT OR IGNORE INTO audit (at, kind, actor_kind, actor_id, actor_name, resource_kind, resource, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          entry.at,
          entry.kind,
          entry.actor.kind,
          entry.actor.id,
          entry.actor.name,
          entry.resource === undefined ? null : entry.resourceKind,
          entry.resource ?? null,
          entry.summary,
          entry.detail === undefined ? null : JSON.stringify(entry.detail)
        );
    } finally {
      for (const listener of this.#listeners) listener(entry);
    }
  }

  /** Hears each line added, after it is added: what follows a change without each caller saying so. Returns what stops it. */
  onRecord(listener: (entry: AuditRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** The timeline, newest first: all of it, or what is about one kind of thing, or one thing. */
  recent(options: { limit?: number; resourceKind?: ResourceKind; resource?: string; before?: number } = {}): AuditEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (options.resourceKind) (where.push('resource_kind = ?'), args.push(options.resourceKind));
    if (options.resource) (where.push('resource = ?'), args.push(options.resource));
    if (options.before) (where.push('id < ?'), args.push(options.before));
    return this.#db
      .query<AuditRow, (string | number)[]>(
        `SELECT id, at, kind, actor_kind, actor_id, actor_name, resource_kind, resource, summary, detail FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
      )
      .all(...args, options.limit ?? 100)
      .map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name },
        resourceKind: row.resource_kind,
        resource: row.resource,
        summary: row.summary,
        detail: row.detail ? (JSON.parse(row.detail) as unknown) : undefined,
      }));
  }

  /** Lets go of what was recorded before a time. */
  prune(beforeIso: string): void {
    this.#db.query('DELETE FROM audit WHERE at < ?').run(beforeIso);
  }
}
