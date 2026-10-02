import { nodeId, type NodeId, type Platform } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * Every kraftverk node of the home (docs/DATA-MODEL.md §3): the hub running
 * somewhere — an always-on machine on the network, a phone, a browser —
 * holding the connections it can reach. The one this database belongs to
 * (`self`), and the others it shares the home with. A node is known by the
 * same id in every database that knows it: made by the node itself, once,
 * and handed in by the place it runs. What it is, it declares.
 */

/** What a node declares it is: what tells nodes apart, and how the master is chosen. */
export type NodeTraits = {
  /** It runs while nobody looks: it keeps history and runs automations at night. */
  alwaysOn: boolean;
  /** Others connect to it: it serves the home's interface. */
  reachable: boolean;
  /** What must stay put — a vendor account's password — may be kept on it. */
  trusted: boolean;
};

/** A node as it says who it is: to its own database, or to the home it joins. */
export type NodeDeclaration = NodeTraits & {
  id: NodeId;
  /** "Garage NAS", "Chrome on Windows", "This iPhone". */
  name: string;
  /** What its transports' entries are for: a system process, a browser's page, a phone. */
  platform: Platform;
  /** What it reaches devices over, where it runs. */
  transports: readonly string[];
  /** Where it stands; null: it moves with someone, or has not said. */
  placeId?: string | null;
};

export type NodeRecord = NodeTraits & {
  id: NodeId;
  name: string;
  platform: Platform;
  transports: string[];
  placeId: string | null;
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
  place_id: string | null;
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
  placeId: row.place_id,
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

  /** The nodes a person joined to the home, from their account. */
  forAccount(accountId: string): NodeRecord[] {
    return this.#db.query<Row, [string]>('SELECT * FROM node WHERE account_id = ? ORDER BY last_seen_at DESC').all(accountId).map(toRecord);
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

  /** Forgets a node, and every connection it held. Never this database's own. */
  remove(id: string): void {
    this.#db.query('DELETE FROM node WHERE id = ? AND self = 0').run(id);
  }

  #write(node: NodeDeclaration | Omit<NodeRecord, 'self' | 'accountId'>, how: { accountId: string | null; self: boolean; at?: { created: string; seen: string } }): NodeRecord {
    const now = new Date().toISOString();
    const created = how.at?.created ?? now;
    const seen = how.at?.seen ?? now;
    this.#db
      .query(
        `INSERT INTO node (id, name, platform, always_on, reachable, trusted, transports, place_id, account_id, self, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, platform = excluded.platform, always_on = excluded.always_on,
           reachable = excluded.reachable, trusted = excluded.trusted, transports = excluded.transports, place_id = excluded.place_id,
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
        node.placeId ?? null,
        how.accountId,
        bit(how.self),
        created,
        seen
      );
    return this.get(node.id)!;
  }
}
