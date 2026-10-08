import { keyFrom, newId, type Actor } from '@kraftverk/device-sdk';

import type { ModeAxis } from '@kraftverk/api-contract';

import type { SqlDatabase } from './database.ts';

/**
 * A home's modes (docs/PLAN-WORLD-MODEL.md §8.10): on two axes at once —
 * presence and the day — the built-in ones and a family's own; and which a
 * home is in on each, as intervals, some ahead. Setting one rewrites what
 * follows: from a time, for good or until another, the mode before coming
 * back after. Kept two years.
 */

export const MODE_AXES: readonly ModeAxis[] = ['presence', 'day'];

export type ModeRecord = { id: string; key: string; axis: ModeAxis; name: string; icon: string | null; builtIn: boolean; position: number; removedAt: string | null };

/** A home in a mode on one axis, from when — and until when, if it ends — and who set it. */
export type HomeModeRecord = { homeId: string; modeId: string; axis: ModeAxis; since: string; until: string | null; by: Actor };

/** The built-in modes: what every family has, its id its key. */
export const BUILT_IN_MODES: readonly Omit<ModeRecord, 'removedAt' | 'builtIn'>[] = [
  { id: 'home', key: 'home', axis: 'presence', name: 'Home', icon: 'home', position: 0 },
  { id: 'away', key: 'away', axis: 'presence', name: 'Away', icon: 'log-out', position: 1 },
  { id: 'vacation', key: 'vacation', axis: 'presence', name: 'Vacation', icon: 'sun', position: 2 },
  { id: 'day', key: 'day', axis: 'day', name: 'Day', icon: 'sun', position: 0 },
  { id: 'evening', key: 'evening', axis: 'day', name: 'Evening', icon: 'sunset', position: 1 },
  { id: 'night', key: 'night', axis: 'day', name: 'Night', icon: 'moon', position: 2 },
];

type ModeRow = { id: string; key: string; axis: ModeAxis; name: string; icon: string | null; built_in: number; position: number; removed_at: string | null };
const modeOf = (row: ModeRow): ModeRecord => ({ id: row.id, key: row.key, axis: row.axis, name: row.name, icon: row.icon, builtIn: row.built_in === 1, position: row.position, removedAt: row.removed_at });

type HomeModeRow = { home_id: string; mode_id: string; axis: ModeAxis; since: string; until: string | null; actor_kind: Actor['kind']; actor_id: string | null; actor_name: string };
const homeModeOf = (row: HomeModeRow): HomeModeRecord => ({
  homeId: row.home_id,
  modeId: row.mode_id,
  axis: row.axis,
  since: row.since,
  until: row.until,
  by: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name } as Actor,
});

export class ModeStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    this.ensureBuiltIns();
  }

  /** The built-in modes, there: made with the database, and again after a reset. */
  ensureBuiltIns(): void {
    const insert = this.#db.query('INSERT OR IGNORE INTO mode (id, key, axis, name, icon, built_in, position) VALUES (?, ?, ?, ?, ?, 1, ?)');
    for (const mode of BUILT_IN_MODES) insert.run(mode.id, mode.key, mode.axis, mode.name, mode.icon, mode.position);
  }

  // --- the modes -------------------------------------------------------------------

  /** Every mode, by axis and order; with those let go, `removed`. */
  list(options: { removed?: boolean } = {}): ModeRecord[] {
    return this.#db
      .query<ModeRow, []>(`SELECT * FROM mode ${options.removed ? '' : 'WHERE removed_at IS NULL'} ORDER BY axis DESC, built_in DESC, position, name`)
      .all()
      .map(modeOf);
  }

  get(id: string): ModeRecord | null {
    const row = this.#db.query<ModeRow, [string]>('SELECT * FROM mode WHERE id = ?').get(id);
    return row ? modeOf(row) : null;
  }

  /** A mode by its key: one not let go. */
  byKey(key: string): ModeRecord | null {
    const row = this.#db.query<ModeRow, [string]>('SELECT * FROM mode WHERE key = ? AND removed_at IS NULL').get(key);
    return row ? modeOf(row) : null;
  }

  keyTaken(key: string, except?: string): boolean {
    return this.#db.query<{ id: string }, [string]>('SELECT id FROM mode WHERE key = ? AND removed_at IS NULL').all(key).some((row) => row.id !== except);
  }

  /** A family's own mode, on one axis, after the others there. */
  add(input: { key?: string; axis: ModeAxis; name: string; icon?: string | null }): ModeRecord {
    if (input.key !== undefined && (!MODE_KEY.test(input.key) || this.keyTaken(input.key))) throw new Error(`"${input.key}" is not a free key for a mode`);
    const key = input.key ?? keyFrom(input.name, (taken) => this.keyTaken(taken) || !MODE_KEY.test(taken), 'mode');
    const position = this.#db.query<{ next: number }, [string]>('SELECT coalesce(max(position) + 1, 0) AS next FROM mode WHERE axis = ?').get(input.axis)!.next;
    const id = newId('m');
    this.#db.query('INSERT INTO mode (id, key, axis, name, icon, built_in, position) VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, key, input.axis, input.name, input.icon ?? null, position);
    return this.get(id)!;
  }

  /** A family's own mode renamed, rekeyed, its icon changed. A built-in one stays as it is. */
  update(id: string, changes: { key?: string; name?: string; icon?: string | null }): ModeRecord | null {
    const was = this.get(id);
    if (!was || was.builtIn) return was;
    if (changes.key !== undefined && changes.key !== was.key && (!MODE_KEY.test(changes.key) || this.keyTaken(changes.key, id))) throw new Error(`"${changes.key}" is not a free key for a mode`);
    const next = { ...was, ...changes };
    this.#db.query('UPDATE mode SET key = ?, name = ?, icon = ? WHERE id = ?').run(next.key, next.name, next.icon ?? null, id);
    return this.get(id);
  }

  /** A family's own mode let go: history names it; a home in it now stays so until it is set again. */
  remove(id: string): ModeRecord | null {
    this.#db.query('UPDATE mode SET removed_at = ? WHERE id = ? AND built_in = 0 AND removed_at IS NULL').run(new Date().toISOString(), id);
    return this.get(id);
  }

  // --- a home's modes --------------------------------------------------------------

  /** The mode a home is in on an axis at a time — now unless said: none, when it was never set. */
  at(homeId: string, axis: ModeAxis, at = new Date().toISOString()): HomeModeRecord | null {
    const row = this.#db
      .query<HomeModeRow, [string, string, string, string]>('SELECT * FROM home_mode WHERE home_id = ? AND axis = ? AND since <= ? AND (until IS NULL OR until > ?) ORDER BY since DESC LIMIT 1')
      .get(homeId, axis, at, at);
    return row ? homeModeOf(row) : null;
  }

  /** What is set to come on an axis: the intervals that begin after a time. */
  ahead(homeId: string, axis: ModeAxis, after = new Date().toISOString()): HomeModeRecord[] {
    return this.#db.query<HomeModeRow, [string, string, string]>('SELECT * FROM home_mode WHERE home_id = ? AND axis = ? AND since > ? ORDER BY since').all(homeId, axis, after).map(homeModeOf);
  }

  /** A home's modes since a time, on both axes, oldest first. */
  history(homeId: string, since: string): HomeModeRecord[] {
    return this.#db.query<HomeModeRow, [string, string]>('SELECT * FROM home_mode WHERE home_id = ? AND (until IS NULL OR until > ?) ORDER BY since').all(homeId, since).map(homeModeOf);
  }

  /**
   * A home in a mode from `from` — for good, or until `until`, when what
   * was to be then comes back. What was set for that time is replaced; what
   * begins after `until` stays. In one transaction.
   */
  set(homeId: string, modeId: string, by: Actor, from = new Date().toISOString(), until: string | null = null): void {
    const mode = this.get(modeId);
    if (!mode) throw new Error('No such mode');
    if (until !== null && until <= from) throw new Error('A mode ends after it begins');
    const axis = mode.axis;
    this.#db.transaction(() => {
      // What was to be when it ends: it comes back then.
      const after = until === null ? null : this.at(homeId, axis, until);
      const resumeUntil = after?.until ?? null;
      // What begins within it goes; what began before it ends as it begins.
      if (until === null) this.#db.query('DELETE FROM home_mode WHERE home_id = ? AND axis = ? AND since >= ?').run(homeId, axis, from);
      else this.#db.query('DELETE FROM home_mode WHERE home_id = ? AND axis = ? AND since >= ? AND since < ?').run(homeId, axis, from, until);
      this.#db.query('UPDATE home_mode SET until = ? WHERE home_id = ? AND axis = ? AND since < ? AND (until IS NULL OR until > ?)').run(from, homeId, axis, from, from);
      const insert = this.#db.query('INSERT INTO home_mode (home_id, mode_id, axis, since, until, actor_kind, actor_id, actor_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run(homeId, modeId, axis, from, until, by.kind, by.id ?? null, by.name);
      // The mode before comes back at its end — unless something begins then already.
      if (until !== null && after && !this.#db.query('SELECT 1 FROM home_mode WHERE home_id = ? AND axis = ? AND since = ?').get(homeId, axis, until)) {
        const next = this.#db.query<{ since: string }, [string, string, string]>('SELECT since FROM home_mode WHERE home_id = ? AND axis = ? AND since > ? ORDER BY since LIMIT 1').get(homeId, axis, until);
        insert.run(homeId, after.modeId, axis, until, next?.since ?? resumeUntil, after.by.kind, after.by.id ?? null, after.by.name);
      }
    })();
  }

  /** What ended before a time, let go: kept two years. */
  prune(before: string): number {
    return this.#db.query('DELETE FROM home_mode WHERE until IS NOT NULL AND until < ?').run(before).changes;
  }
}

/** A mode's key: lowercase letters, digits and dashes, from a letter — "away", "party", "guests-over". */
export const MODE_KEY = /^[a-z][a-z0-9-]{0,29}$/;

