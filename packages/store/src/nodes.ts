import { nodeId, type NodeId, type NodeTraits, type Platform } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * Every kraftverk node of the home (docs/DATA-MODEL.md §3): the hub running
 * somewhere — an always-on machine on the network, a phone, a browser —
 * holding the connections it can reach. The one this database belongs to
 * (`self`), and the others it shares the home with. A node is known by the
 * same id in every database that knows it: made by the node itself, once,
 * and handed in by the place it runs. What it is, it declares (`NodeTraits`).
 */

/** A node as it says who it is: to its own database, or to the home it joins. */
export type NodeDeclaration = NodeTraits & {
  id: NodeId;
  /** "Garage NAS", "Chrome on Windows", "This iPhone". */
  name: string;
  /** What its transports' entries are for: a system process, a browser's page, a phone. */
  platform: Platform;
  /** What it reaches devices over, where it runs. */
  transports: readonly string[];
};

export type NodeRecord = NodeTraits & {
  id: NodeId;
  name: string;
  platform: Platform;
  transports: string[];
  /** The person it joined for, from their account; null for the home's own. */
  accountId: string | null;
  /** The node this database belongs to. */
  self: boolean;
  createdAt: string;
  lastSeenAt: string;
};

type Row = {
  id: string;
  name: string;
  platform: Platform;
  always_on: number;
  reachable: number;
  trusted: number;
  transports: string;
  account_id: string | null;
  self: number;
  created_at: string;
  last_seen_at: string;
};

const toRecord = (row: Row): NodeRecord => ({
  id: nodeId(row.id),
  name: row.name,
  platform: row.platform,
  alwaysOn: row.always_on === 1,
  reachable: row.reachable === 1,
  trusted: row.trusted === 1,
  transports: JSON.parse(row.transports) as string[],
  accountId: row.account_id,
  self: row.self === 1,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

const bit = (value: boolean) => (value ? 1 : 0);

export class NodeStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  all(): NodeRecord[] {
    return this.#db.query<Row, []>('SELECT * FROM node ORDER BY self DESC, created_at').all().map(toRecord);
  }

  get(id: string): NodeRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM node WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  /** The node this database belongs to; null until it has said who it is. */
  self(): NodeRecord | null {
    const row = this.#db.query<Row, []>('SELECT * FROM node WHERE self = 1').get();
    return row ? toRecord(row) : null;
  }

  /**
   * The node this database belongs to, as it declares itself at every start:
   * made the first time, brought up to date after. A database is one node's,
   * for good: another id is refused.
   */
  declareSelf(node: NodeDeclaration): NodeRecord {
    const had = this.self();
    if (had && had.id !== node.id) throw new Error(`This database is ${had.name}'s (${had.id}), not ${node.name}'s`);
    return this.#write(node, { accountId: null, self: true });
  }

  /**
   * A node joining the home — to follow it, and hold for it the ways it
   * reaches — by its own id, for the person whose account it joins from;
   * or one it already knows, saying what it is now. A node another person
   * joined is not theirs to speak for.
   */
  join(node: NodeDeclaration, accountId: string | null): NodeRecord {
    const had = this.get(node.id);
    if (had?.self) throw new Error('That is this home’s own node');
    if (had && had.accountId !== accountId) throw new Error('That node joined this home for someone else');
    return this.#write(node, { accountId, self: false });
  }

  /** A node of the home as its master's database knows it, kept in a node that follows it: as it is there. */
  mirror(record: Omit<NodeRecord, 'self' | 'accountId'>): void {
    if (this.get(record.id)?.self) return;
    this.#write(record, { accountId: null, self: false, at: { created: record.createdAt, seen: record.lastSeenAt } });
  }

  /** A node of the home was heard from — readings, its timeline, its store — now. */
  seen(id: string): void {
    this.#db.query('UPDATE node SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * Forgets every node joined from an account, and every connection each
   * held: the account is gone, and no other may speak for them. Never this
   * database's own.
   */
  forgetJoinedFrom(accountId: string): void {
    this.#db.query('DELETE FROM node WHERE account_id = ? AND self = 0').run(accountId);
  }

  /** Forgets a node, and every connection it held. Never this database's own, nor the home's master. */
  remove(id: string): void {
    this.#db.query('DELETE FROM node WHERE id = ? AND self = 0 AND id NOT IN (SELECT master_id FROM family)').run(id);
  }

  #write(node: NodeDeclaration | Omit<NodeRecord, 'self' | 'accountId'>, how: { accountId: string | null; self: boolean; at?: { created: string; seen: string } }): NodeRecord {
    const now = new Date().toISOString();
    const created = how.at?.created ?? now;
    const seen = how.at?.seen ?? now;
    this.#db
      .query(
        `INSERT INTO node (id, name, platform, always_on, reachable, trusted, transports, account_id, self, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, platform = excluded.platform, always_on = excluded.always_on,
           reachable = excluded.reachable, trusted = excluded.trusted, transports = excluded.transports,
           account_id = excluded.account_id, last_seen_at = excluded.last_seen_at`
      )
      .run(
        node.id,
        node.name,
        node.platform,
        bit(node.alwaysOn),
        bit(node.reachable),
        bit(node.trusted),
        JSON.stringify(node.transports),
        how.accountId,
        bit(how.self),
        created,
        seen
      );
    return this.get(node.id)!;
  }
}
