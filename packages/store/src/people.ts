import type { MemberRole, PersonView } from '@kraftverk/api-contract';
import { checkChain, hashOf, keyId, type Json, type Person, type PublicJwk, type Statement } from '@kraftverk/identity';

import type { SqlDatabase } from './database.ts';

/**
 * A family's people (docs/PLAN-WORLD-MODEL.md §8.2, §8.3, §10): each as their
 * own signed chain says — checked, and kept as it was shown — with their
 * keys and the identities they linked, and who is a member, in which role,
 * by which colour. At least one admin, always; one colour each.
 */

/** Colours to tell members apart by, given in turn: each member has one no other has. */
export const MEMBER_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#a855f7'] as const;

type PersonRow = { id: string; name: string; short_name: string | null; picture_id: string | null; managed_by: string | null; chain: string | null; updated_at: string; erased_at: string | null };
type MemberRow = { role: MemberRole; nickname: string | null; color: string; joined_at: string; left_at: string | null };
type KeyRow = { id: string; kind: 'device' | 'recovery'; public_key: string; device_name: string | null; added_at: string; vouched: string | null; revoked_at: string | null };

/** What a person forgotten is called, wherever they were named. */
export const SOMEONE_WHO_LEFT = 'Someone who left';

export class PeopleStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** A person as this family answers them; null for one it does not know. */
  get(id: string): PersonView | null {
    const row = this.#db.query<PersonRow, [string]>('SELECT * FROM person WHERE id = ?').get(id);
    if (!row) return null;
    const member = this.#db.query<MemberRow, [string]>('SELECT * FROM member WHERE person_id = ?').get(id);
    const keys = this.#db.query<KeyRow, [string]>('SELECT * FROM person_key WHERE person_id = ? AND revoked_at IS NULL ORDER BY added_at, id').all(id);
    const linked = this.#db.query<{ provider: string }, [string]>('SELECT provider FROM person_identity WHERE person_id = ? ORDER BY provider').all(id);
    const now = member && member.left_at === null ? member : null;
    return {
      id: row.id,
      name: row.name,
      shownAs: now?.nickname ?? row.short_name ?? row.name,
      shortName: row.short_name,
      pictureId: row.picture_id,
      managedBy: row.managed_by,
      linked: linked.map((each) => each.provider),
      keys: keys.map((key) => ({ id: key.id, kind: key.kind, deviceName: key.device_name, addedAt: key.added_at, vouched: key.vouched })),
      member: now ? { role: now.role, nickname: now.nickname, color: now.color, joinedAt: now.joined_at } : null,
      updatedAt: row.updated_at,
    };
  }

  /** The members now, in the order they joined. */
  members(): PersonView[] {
    return this.#db
      .query<{ person_id: string }, []>('SELECT person_id FROM member WHERE left_at IS NULL ORDER BY joined_at, person_id')
      .all()
      .map((row) => this.get(row.person_id)!);
  }

  /** The chain a person is kept by; empty for one with none. */
  chainOf(id: string): Statement[] {
    const chain = this.#db.query<{ chain: string | null }, [string]>('SELECT chain FROM person WHERE id = ?').get(id)?.chain;
    return chain ? (JSON.parse(chain) as Statement[]) : [];
  }

  /**
   * A person as their chain says, checked and kept: someone new, or a newer
   * copy of someone known — one that goes on from the copy kept, never one
   * that forks from it or stops short of it. Their keys and linked
   * identities follow it. Refused, in words, for a chain that is no one.
   */
  present(chain: readonly Statement[]): PersonView {
    const checked = checkChain(chain);
    if (!checked.ok) throw new Error(`That is not who they say: ${checked.problem}`);
    const person = checked.person;
    const kept = this.chainOf(person.id);
    if (kept.length) {
      if (kept.length > chain.length) throw new Error('That is an older copy of them than this family has');
      if (hashOf(chain[kept.length - 1] as unknown as Json) !== hashOf(kept.at(-1) as unknown as Json)) throw new Error('That copy of them does not go on from the one this family has');
    }
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO person (id, name, short_name, picture_id, locale, chain, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, short_name = excluded.short_name, picture_id = excluded.picture_id, locale = excluded.locale, chain = excluded.chain, updated_at = excluded.updated_at, managed_by = NULL, erased_at = NULL`
        )
        .run(person.id, person.profile.name, person.profile.shortName, this.#picture(person.profile.pictureId), person.profile.locale, JSON.stringify(chain), person.updatedAt);
      this.#keepKeys(person);
      this.#db.query('DELETE FROM person_identity WHERE person_id = ?').run(person.id);
      for (const linked of person.linked) this.#db.query('INSERT INTO person_identity (provider, subject, person_id, email) VALUES (?, ?, ?, ?) ON CONFLICT (provider, subject) DO UPDATE SET person_id = excluded.person_id, email = excluded.email').run(linked.provider, linked.subject, person.id, linked.email);
    })();
    return this.get(person.id)!;
  }

  /**
   * A person with no key yet, by the id a node gave them — made where they
   * signed in with a password — or as they are, if this family knows them
   * already. Their app claims them later (`claim`).
   */
  ensureKeyless(id: string, name: string, at: string): PersonView {
    if (!this.get(id)) this.#db.query('INSERT INTO person (id, name, updated_at) VALUES (?, ?, ?)').run(id, name, at);
    return this.get(id)!;
  }

  /**
   * A keyless person claimed by their own chain (§10.4): in one transaction,
   * the id a node or an admin gave them becomes theirs everywhere it is used —
   * their membership, who they invited, whom they keep, the family they
   * founded — and the keyless record goes. What happened before names the old
   * id, as history does.
   */
  claim(oldId: string, chain: readonly Statement[]): PersonView {
    const was = this.get(oldId);
    if (!was) throw new Error('No such person to claim');
    if (this.chainOf(oldId).length) throw new Error('They are someone already: only a person with no key of their own is claimed');
    const checked = checkChain(chain);
    if (!checked.ok) throw new Error(`That is not who they say: ${checked.problem}`);
    const id = checked.person.id;
    if (id === oldId) return this.present(chain);
    if (this.roleOf(id)) throw new Error('That person is in this family already');
    this.#db.transaction(() => {
      this.#db.exec('PRAGMA defer_foreign_keys = ON');
      this.present(chain);
      const member = this.#db.query<MemberRow & { invited_by: string | null }, [string]>('SELECT * FROM member WHERE person_id = ?').get(oldId);
      this.#db.query('DELETE FROM member WHERE person_id = ?').run(oldId);
      if (member) this.#db.query('INSERT INTO member (person_id, role, nickname, color, joined_at, invited_by, left_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, member.role, member.nickname, member.color, member.joined_at, member.invited_by, member.left_at);
      this.#db.query('UPDATE member SET invited_by = ? WHERE invited_by = ?').run(id, oldId);
      this.#db.query('UPDATE person SET managed_by = ? WHERE managed_by = ?').run(id, oldId);
      this.#db.query('UPDATE family SET created_by = ? WHERE created_by = ?').run(id, oldId);
      this.#db.query('DELETE FROM person WHERE id = ?').run(oldId);
    })();
    return this.get(id)!;
  }

  /** A picture this family keeps, or none: a profile may name one taken on another device, not brought here yet. */
  #picture(id: string | null): string | null {
    return id && this.#db.query<{ id: string }, [string]>('SELECT id FROM media WHERE id = ?').get(id) ? id : null;
  }

  /** The chain's keys: added as it adds them, revoked as it revokes them. One this family vouched for stays as it is. */
  #keepKeys(person: Person): void {
    for (const key of person.keys) {
      this.#db
        .query(
          `INSERT INTO person_key (id, person_id, kind, public_key, device_name, added_at, added_with, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET revoked_at = excluded.revoked_at, device_name = excluded.device_name`
        )
        .run(key.id, person.id, key.kind, JSON.stringify(key.publicJwk), key.deviceName, key.addedAt, key.addedWith, key.revokedAt);
    }
  }

  /** The person a key is, and its public half — while it is not revoked: what a node signs someone in by. */
  keyHolder(id: string): { personId: string; publicJwk: PublicJwk } | null {
    const row = this.#db.query<{ person_id: string; public_key: string }, [string]>('SELECT person_id, public_key FROM person_key WHERE id = ? AND revoked_at IS NULL').get(id);
    return row ? { personId: row.person_id, publicJwk: JSON.parse(row.public_key) as PublicJwk } : null;
  }

  /** The person a sign-in provider's subject is linked to, if any. */
  byIdentity(provider: string, subject: string): string | null {
    return this.#db.query<{ person_id: string }, [string, string]>('SELECT person_id FROM person_identity WHERE provider = ? AND subject = ?').get(provider, subject)?.person_id ?? null;
  }

  /**
   * A key this family takes for a person outside their chain — they came
   * back without one, by a sign-in provider they linked, or an admin said so
   * (§10.3, §10.6). No other family takes it.
   */
  vouch(personId: string, publicJwk: PublicJwk, deviceName: string, vouched: string, at: string): string {
    const id = keyId(publicJwk);
    this.#db.query('INSERT INTO person_key (id, person_id, kind, public_key, device_name, added_at, vouched) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, personId, 'device', JSON.stringify(publicJwk), deviceName, at, vouched);
    return id;
  }

  /** A person who is a member now, in their role — none for one who is not. */
  roleOf(id: string): MemberRole | null {
    return this.#db.query<{ role: MemberRole }, [string]>('SELECT role FROM member WHERE person_id = ? AND left_at IS NULL').get(id)?.role ?? null;
  }

  /** A person made a member — again, if they left — with the first colour no member has. */
  addMember(personId: string, input: { role: MemberRole; invitedBy: string | null; at: string }): PersonView {
    const used = new Set(this.#db.query<{ color: string }, []>('SELECT color FROM member WHERE left_at IS NULL').all().map((row) => row.color));
    const color = MEMBER_COLORS.find((each) => !used.has(each)) ?? `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
    this.#db
      .query(
        `INSERT INTO member (person_id, role, color, joined_at, invited_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (person_id) DO UPDATE SET role = excluded.role, color = excluded.color, joined_at = excluded.joined_at, invited_by = excluded.invited_by, left_at = NULL, nickname = NULL`
      )
      .run(personId, input.role, color, input.at, input.invitedBy);
    return this.get(personId)!;
  }

  /** What an admin changes of a member: their role — never the last admin's away — their nickname, their colour. */
  updateMember(personId: string, changes: { role?: MemberRole; nickname?: string | null; color?: string }): PersonView {
    const was = this.#db.query<MemberRow, [string]>('SELECT * FROM member WHERE person_id = ? AND left_at IS NULL').get(personId);
    if (!was) throw new Error('They are not a member');
    if (changes.role !== undefined && changes.role !== 'admin' && was.role === 'admin' && this.#admins() === 1) throw new Error('A family keeps at least one admin');
    if (changes.color !== undefined && this.#db.query<{ person_id: string }, [string, string]>('SELECT person_id FROM member WHERE color = ? AND left_at IS NULL AND person_id <> ?').get(changes.color, personId)) throw new Error('Another member has that colour');
    this.#db.query('UPDATE member SET role = ?, nickname = ?, color = ? WHERE person_id = ?').run(changes.role ?? was.role, changes.nickname === undefined ? was.nickname : changes.nickname, changes.color ?? was.color, personId);
    return this.get(personId)!;
  }

  /** A member gone from the family — never the last admin — the row kept for the history that names them. */
  /**
   * A person forgotten (docs/PLAN-WORLD-MODEL.md §11.6): they leave, and
   * all this family kept of them goes but their id — their name is
   * "Someone who left". Showing who they are again, by an invitation, they
   * are someone here again.
   */
  erase(personId: string, at: string): void {
    this.#db.transaction(() => {
      this.leave(personId, at);
      this.#db.query('UPDATE member SET nickname = NULL WHERE person_id = ?').run(personId);
      this.#db.query('DELETE FROM person_identity WHERE person_id = ?').run(personId);
      this.#db.query('DELETE FROM shortcut WHERE person_id = ?').run(personId);
      this.#db.query('UPDATE person_key SET added_with = NULL WHERE person_id = ?').run(personId);
      this.#db.query('DELETE FROM person_key WHERE person_id = ?').run(personId);
      this.#db.query("UPDATE person SET name = ?, short_name = NULL, picture_id = NULL, locale = NULL, chain = NULL, managed_by = NULL, updated_at = ?, erased_at = ? WHERE id = ?").run(SOMEONE_WHO_LEFT, at, at, personId);
    })();
  }

  leave(personId: string, at: string): void {
    if (this.roleOf(personId) === 'admin' && this.#admins() === 1) throw new Error('A family keeps at least one admin: make another one first');
    this.#db.query('UPDATE member SET left_at = ? WHERE person_id = ? AND left_at IS NULL').run(at, personId);
  }

  #admins(): number {
    return this.#db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM member WHERE role = 'admin' AND left_at IS NULL").get()?.n ?? 0;
  }
}
