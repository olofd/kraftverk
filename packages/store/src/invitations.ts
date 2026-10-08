import type { InvitationView, MemberRole } from '@kraftverk/api-contract';
import { hexOf, newId, sha256 } from '@kraftverk/device-sdk';
import { base64url } from '@kraftverk/identity';

import type { SqlDatabase } from './database.ts';

/**
 * A family's invitations (docs/PLAN-WORLD-MODEL.md §8.3): each a one-time
 * secret, kept only as its hash; taken once, by someone who then joins in
 * its role — or waits for an admin — until it expires or is taken back.
 */

type Row = {
  id: string;
  role: MemberRole;
  for_name: string | null;
  secret_hash: string;
  needs_approval: number;
  made_by: string;
  made_at: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  revoked_at: string | null;
};

const hashOf = (secret: string) => hexOf(sha256(secret));

/** 256 random bits, as base64url: a secret no one guesses. */
const randomSecret = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export class InvitationStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  #view(row: Row, now: number): InvitationView {
    const status: InvitationView['status'] = row.revoked_at
      ? 'revoked'
      : row.used_by && (row.approved_by || !row.needs_approval)
        ? 'used'
        : row.used_by
          ? 'waiting'
          : Date.parse(row.expires_at) <= now
            ? 'expired'
            : 'open';
    return { id: row.id, role: row.role, forName: row.for_name, needsApproval: row.needs_approval === 1, madeBy: row.made_by, madeAt: row.made_at, expiresAt: row.expires_at, usedBy: row.used_by, usedAt: row.used_at, status };
  }

  get(id: string, now = Date.now()): InvitationView | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM invitation WHERE id = ?').get(id);
    return row ? this.#view(row, now) : null;
  }

  /** The invitations made, newest first. */
  list(now = Date.now()): InvitationView[] {
    return this.#db.query<Row, []>('SELECT * FROM invitation ORDER BY made_at DESC, id').all().map((row) => this.#view(row, now));
  }

  /** An invitation made: the view, and its secret — answered this once, and kept nowhere. */
  make(input: { role: MemberRole; forName: string | null; needsApproval: boolean; madeBy: string; at: string; expiresAt: string }): { invitation: InvitationView; secret: string } {
    const id = newId('i');
    const secret = randomSecret();
    this.#db
      .query('INSERT INTO invitation (id, role, for_name, secret_hash, needs_approval, made_by, made_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.role, input.forName, hashOf(secret), input.needsApproval ? 1 : 0, input.madeBy, input.at, input.expiresAt);
    return { invitation: this.get(id)!, secret };
  }

  /**
   * An invitation taken, if its secret is its own and it is open: by whom,
   * once. Null for anything else — wrong, used, expired or taken back are
   * one answer, so a guess learns nothing.
   */
  take(id: string, secret: string, personId: string, at: string): InvitationView | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM invitation WHERE id = ?').get(id);
    if (!row || row.secret_hash !== hashOf(secret) || row.revoked_at || row.used_by || Date.parse(row.expires_at) <= Date.parse(at)) return null;
    const taken = this.#db.query('UPDATE invitation SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL').run(personId, at, id).changes;
    return taken ? this.get(id) : null;
  }

  /** One waiting, let in by an admin. */
  approve(id: string, by: string, at: string): InvitationView | null {
    this.#db.query('UPDATE invitation SET approved_by = ?, approved_at = ? WHERE id = ? AND used_by IS NOT NULL AND approved_by IS NULL AND revoked_at IS NULL').run(by, at, id);
    return this.get(id);
  }

  /** Taken back: open, it can no longer be taken; waiting, its person is not let in. */
  revoke(id: string, at: string): InvitationView | null {
    this.#db.query('UPDATE invitation SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id);
    return this.get(id);
  }
}
