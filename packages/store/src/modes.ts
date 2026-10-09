import { BUILT_IN_MODES, keyFrom, MODE_KEY, newId, type Actor, type ModeAxis } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * A home's modes (docs/PLAN-WORLD-MODEL.md §8.10): on two axes at once —
 * presence and the day — the built-in ones and a family's own; and which a
 * home is in on each. Two kinds of setting make it: one for good, from a
 * time — lasting until the next for good — and one planned for a while, from
 * a time until another: a vacation from Saturday to Sunday week. While one
 * planned lasts, it is the mode; when it ends, the setting for good in force
 * then is again — whatever was set while it lasted. A setting for good now
 * leaves what was planned ahead as it was. And, per home and axis, which mode
 * was last said on the bus: what began while nobody listened is said when
 * someone does. Kept two years.
 */

export type ModeRecord = { id: string; key: string; axis: ModeAxis; name: string; icon: string | null; builtIn: boolean; position: number; removedAt: string | null };

/**
 * A home in a mode on one axis: from when — and until when, if anything is
 * set to change it — and who set it. `planned`: a setting begins then, what
 * can be let go; not, when it is what comes back as one planned ends.
 */
export type HomeModeRecord = { homeId: string; modeId: string; axis: ModeAxis; since: string; until: string | null; by: Actor; planned: boolean };

type ModeRow = { id: string; key: string; axis: ModeAxis; name: string; icon: string | null; built_in: number; position: number; removed_at: string | null };
const modeOf = (row: ModeRow): ModeRecord => ({ id: row.id, key: row.key, axis: row.axis, name: row.name, icon: row.icon, builtIn: row.built_in === 1, position: row.position, removedAt: row.removed_at });

/** One setting: for good (`until` null), or planned for a while. */
type HomeModeRow = { home_id: string; mode_id: string; axis: ModeAxis; since: string; until: string | null; actor_kind: Actor['kind']; actor_id: string | null; actor_name: string };
const actorOf = (row: HomeModeRow): Actor => ({ kind: row.actor_kind, id: row.actor_id, name: row.actor_name }) as Actor;

export class ModeStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    this.ensureBuiltIns();
  }

  /** The built-in modes, there: made with the database, and again after a reset. */
  ensureBuiltIns(): void {
    const insert = this.#db.query('INSERT OR IGNORE INTO mode (id, key, axis, name, icon, built_in, position) VALUES (?, ?, ?, ?, ?, 1, ?)');
    // Each one's id is its key; its place, its order on its axis.
    for (const mode of BUILT_IN_MODES) insert.run(mode.key, mode.key, mode.axis, mode.name, mode.icon, BUILT_IN_MODES.filter((each) => each.axis === mode.axis).indexOf(mode));
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

  /** A family's own mode let go, at a time: history names it; a home in it now stays so until it is set again. */
  remove(id: string, at: string): ModeRecord | null {
    this.#db.query('UPDATE mode SET removed_at = ? WHERE id = ? AND built_in = 0 AND removed_at IS NULL').run(at, id);
    return this.get(id);
  }

  // --- a home's modes --------------------------------------------------------------

  /** The mode a home is in on an axis at a time: none, when it was never set. */
  at(homeId: string, axis: ModeAxis, at: string): HomeModeRecord | null {
    const planned = this.#db
      .query<HomeModeRow, [string, string, string, string]>('SELECT * FROM home_mode WHERE home_id = ? AND axis = ? AND until IS NOT NULL AND since <= ? AND until > ? ORDER BY since DESC LIMIT 1')
      .get(homeId, axis, at, at);
    if (planned) return { homeId, axis, modeId: planned.mode_id, since: planned.since, until: planned.until, by: actorOf(planned), planned: true };
    const kept = this.#db.query<HomeModeRow, [string, string, string]>('SELECT * FROM home_mode WHERE home_id = ? AND axis = ? AND until IS NULL AND since <= ? ORDER BY since DESC LIMIT 1').get(homeId, axis, at);
    if (!kept) return null;
    // Since it began — or since the last planned one within it ended: then it came back.
    const back = this.#db
      .query<{ at: string | null }, [string, string, string, string]>('SELECT max(until) AS at FROM home_mode WHERE home_id = ? AND axis = ? AND until IS NOT NULL AND until <= ? AND until > ?')
      .get(homeId, axis, at, kept.since)?.at;
    const since = back ?? kept.since;
    return { homeId, axis, modeId: kept.mode_id, since, until: this.#next(homeId, axis, at), by: actorOf(kept), planned: since === kept.since };
  }

  /** What is set to come on an axis, after a time: each change, in order — one planned, and what comes back after it. */
  ahead(homeId: string, axis: ModeAxis, after: string): HomeModeRecord[] {
    const changes = this.#db
      .query<{ at: string }, [string, string, string, string, string, string]>('SELECT since AS at FROM home_mode WHERE home_id = ? AND axis = ? AND since > ? UNION SELECT until FROM home_mode WHERE home_id = ? AND axis = ? AND until > ? ORDER BY at')
      .all(homeId, axis, after, homeId, axis, after);
    const coming: HomeModeRecord[] = [];
    let was = this.at(homeId, axis, after)?.modeId ?? null;
    for (const { at } of changes) {
      const then = this.at(homeId, axis, at);
      if (!then || then.modeId === was) continue;
      coming.push(then);
      was = then.modeId;
    }
    return coming;
  }

  /**
   * A home set to a mode from `from`: for good, until the next setting for
   * good — what is planned ahead stays — or planned, until `until`, when the
   * setting for good in force then is again. What was planned within it is
   * replaced; one planned across it is kept before it and after. Already in
   * that mode for good, nothing changes. In one transaction.
   */
  set(homeId: string, modeId: string, by: Actor, from: string, until: string | null = null): void {
    const mode = this.get(modeId);
    if (!mode) throw new Error('No such mode');
    if (until !== null && until <= from) throw new Error('A mode ends after it begins');
    const axis = mode.axis;
    this.#db.transaction(() => {
      const now = this.at(homeId, axis, from);
      const covered = this.#db.query<HomeModeRow, [string, string, string, string]>('SELECT * FROM home_mode WHERE home_id = ? AND axis = ? AND until IS NOT NULL AND since < ? AND until > ?').get(homeId, axis, from, from);
      if (until === null && now?.modeId === modeId && !covered) return;
      this.#db.query('DELETE FROM home_mode WHERE home_id = ? AND axis = ? AND since = ?').run(homeId, axis, from);
      const insert = this.#db.query('INSERT OR IGNORE INTO home_mode (home_id, mode_id, axis, since, until, actor_kind, actor_id, actor_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      // One planned across `from` ends as this begins; planned across its end too, it goes on after it.
      if (covered) {
        this.#db.query('UPDATE home_mode SET until = ? WHERE home_id = ? AND axis = ? AND since = ?').run(from, homeId, axis, covered.since);
        if (until !== null && covered.until! > until) insert.run(homeId, covered.mode_id, axis, until, covered.until, covered.actor_kind, covered.actor_id, covered.actor_name);
      }
      if (until !== null) this.#db.query('DELETE FROM home_mode WHERE home_id = ? AND axis = ? AND until IS NOT NULL AND since > ? AND since < ?').run(homeId, axis, from, until);
      insert.run(homeId, modeId, axis, from, until, by.kind, by.id ?? null, by.name);
    })();
  }

  /** A setting ahead let go — the one that begins at `since`, after `now`: what is in force then is again. Whether there was one. */
  cancel(homeId: string, axis: ModeAxis, since: string, now: string): boolean {
    if (since <= now) return false;
    return this.#db.query('DELETE FROM home_mode WHERE home_id = ? AND axis = ? AND since = ?').run(homeId, axis, since).changes > 0;
  }

  /** When any home's mode might next change after a time, on the clock alone: a setting beginning, or one planned ending. None: nothing ahead. */
  nextChange(after: string): string | null {
    return this.#db.query<{ next: string | null }, [string, string]>('SELECT min(at) AS next FROM (SELECT min(since) AS at FROM home_mode WHERE since > ? UNION ALL SELECT min(until) FROM home_mode WHERE until > ?)').get(after, after)?.next ?? null;
  }

  /** The mode last said on the bus for a home's axis: none, before the first. */
  said(homeId: string, axis: ModeAxis): string | null {
    return this.#db.query<{ mode_id: string }, [string, string]>('SELECT mode_id FROM home_mode_said WHERE home_id = ? AND axis = ?').get(homeId, axis)?.mode_id ?? null;
  }

  /** A home's mode on an axis, said. */
  saidNow(homeId: string, axis: ModeAxis, modeId: string, at: string): void {
    this.#db.query('INSERT INTO home_mode_said (home_id, axis, mode_id, at) VALUES (?, ?, ?, ?) ON CONFLICT (home_id, axis) DO UPDATE SET mode_id = excluded.mode_id, at = excluded.at').run(homeId, axis, modeId, at);
  }

  /** What no longer counts before a time, let go: settings planned that ended, and those for good another followed. Kept two years. */
  prune(before: string): number {
    const planned = this.#db.query('DELETE FROM home_mode WHERE until IS NOT NULL AND until < ?').run(before).changes;
    const kept = this.#db
      .query('DELETE FROM home_mode WHERE until IS NULL AND EXISTS (SELECT 1 FROM home_mode later WHERE later.home_id = home_mode.home_id AND later.axis = home_mode.axis AND later.until IS NULL AND later.since > home_mode.since AND later.since < ?)')
      .run(before).changes;
    return planned + kept;
  }

  /** When the mode in force at a time is next set to change: the next setting that begins after it. */
  #next(homeId: string, axis: ModeAxis, at: string): string | null {
    return this.#db.query<{ since: string }, [string, string, string]>('SELECT since FROM home_mode WHERE home_id = ? AND axis = ? AND since > ? ORDER BY since LIMIT 1').get(homeId, axis, at)?.since ?? null;
  }
}

