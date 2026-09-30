import { randomBytes } from 'node:crypto';

import type { RoleBinding } from '@kraftverk/api-contract';
import { automationId, savedDeviceId, type ConfigValues } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';
import type { AutomationMode, AutomationRecord, RunResult } from './engine.ts';

/**
 * The automations you made, their roles, what their triggers last saw, and
 * every run (docs/DATA-MODEL.md, docs/SEQUENCES.md). Validation is the
 * caller's: this only keeps them.
 */

type Row = {
  id: string;
  name: string;
  recipe: string;
  params: string;
  time_zone: string;
  mode: AutomationMode;
  recheck_minutes: number | null;
  looked_at: string | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  automation_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: RunResult['outcome'];
  started_by: string | null;
  why: string;
  summary: string;
  detail: string;
};

/** A `becomes` trigger's state, as kept: whether its condition held, since when, and whether this hold has run it. */
export type TriggerState = { last: boolean; heldSince: string | null; fired: boolean };

/** What a run keeps beside its columns. */
type RunDetail = Pick<RunResult, 'saw' | 'conditions' | 'steps'>;

const parse = <T>(json: string | null, fallback: T): T => {
  try {
    return json === null ? fallback : (JSON.parse(json) as T);
  } catch {
    return fallback;
  }
};

const runOf = (row: RunRow): RunResult => {
  const detail = parse<Partial<RunDetail>>(row.detail, {});
  return {
    id: row.id,
    at: row.started_at,
    endedAt: row.ended_at,
    startedBy: row.started_by,
    outcome: row.outcome,
    summary: row.summary,
    why: row.why,
    saw: detail.saw ?? [],
    conditions: detail.conditions ?? [],
    steps: detail.steps ?? [],
  };
};

const detailOf = (run: RunResult): string => JSON.stringify({ saw: run.saw, conditions: run.conditions, steps: run.steps } satisfies RunDetail);

export class AutomationStore {
  #revision = 0;

  /** Moves whenever an automation is made, changed or deleted — not when one runs: what the engine indexes by. */
  get revision(): number {
    return this.#revision;
  }

  #records(rows: Row[]): AutomationRecord[] {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => '?').join(', ');
    const roles = new Map<string, Record<string, RoleBinding>>();
    for (const role of db()
      .query<{ automation_id: string; role: string; device_id: string; part: string }, string[]>(`SELECT automation_id, role, device_id, part FROM automation_role WHERE automation_id IN (${marks})`)
      .all(...ids)) {
      roles.set(role.automation_id, { ...roles.get(role.automation_id), [role.role]: { device: savedDeviceId(role.device_id), part: role.part } });
    }
    // Each one's latest ended run, and the one it runs now.
    const last = new Map(
      db()
        .query<RunRow, string[]>(
          `SELECT r.* FROM automation_run r
           WHERE r.automation_id IN (${marks}) AND r.ended_at IS NOT NULL
             AND r.started_at = (SELECT MAX(started_at) FROM automation_run WHERE automation_id = r.automation_id AND ended_at IS NOT NULL)`
        )
        .all(...ids)
        .map((row) => [row.automation_id, runOf(row)])
    );
    const running = new Map(
      db()
        .query<RunRow, string[]>(`SELECT * FROM automation_run WHERE automation_id IN (${marks}) AND ended_at IS NULL`)
        .all(...ids)
        .map((row) => [row.automation_id, runOf(row)])
    );
    return rows.map((row) => ({
      id: automationId(row.id),
      name: row.name,
      recipe: row.recipe,
      roles: roles.get(row.id) ?? {},
      params: parse<ConfigValues>(row.params, {}),
      timeZone: row.time_zone,
      mode: row.mode,
      recheckMinutes: row.recheck_minutes,
      lookedAt: row.looked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRun: last.get(row.id) ?? null,
      running: running.get(row.id) ?? null,
    }));
  }

  list(): AutomationRecord[] {
    return this.#records(db().query<Row, []>('SELECT * FROM automation ORDER BY created_at').all());
  }

  get(id: string): AutomationRecord | null {
    return this.#records(db().query<Row, [string]>('SELECT * FROM automation WHERE id = ?').all(id))[0] ?? null;
  }

  /** The automations a device fills a role of: what its page can start. */
  usingDevice(deviceId: string): AutomationRecord[] {
    return this.#records(
      db()
        .query<Row, [string]>('SELECT a.* FROM automation a WHERE a.id IN (SELECT automation_id FROM automation_role WHERE device_id = ?) ORDER BY a.created_at')
        .all(deviceId)
    );
  }

  #setRoles(id: string, roles: Record<string, RoleBinding>): void {
    db().query('DELETE FROM automation_role WHERE automation_id = ?').run(id);
    const insert = db().query('INSERT INTO automation_role (automation_id, role, device_id, part) VALUES (?, ?, ?, ?)');
    for (const [role, binding] of Object.entries(roles)) insert.run(id, role, binding.device, binding.part);
  }

  create(input: Pick<AutomationRecord, 'name' | 'recipe' | 'roles' | 'params' | 'timeZone' | 'recheckMinutes'>): AutomationRecord {
    const id = automationId(`a-${randomBytes(6).toString('hex')}`);
    const now = new Date().toISOString();
    db().transaction(() => {
      db()
        // Not looked at yet: the engine says when it looks, on its own clock.
        .query('INSERT INTO automation (id, name, recipe, params, time_zone, mode, recheck_minutes, looked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
        .run(id, input.name, input.recipe, JSON.stringify(input.params), input.timeZone, 'observe', input.recheckMinutes, now, now);
      this.#setRoles(id, input.roles);
    })();
    this.#revision += 1;
    return this.get(id)!;
  }

  update(id: string, changes: Partial<Pick<AutomationRecord, 'name' | 'roles' | 'params' | 'timeZone' | 'mode' | 'recheckMinutes'>>): AutomationRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...changes };
    db().transaction(() => {
      db()
        .query('UPDATE automation SET name = ?, params = ?, time_zone = ?, mode = ?, recheck_minutes = ?, updated_at = ? WHERE id = ?')
        .run(next.name, JSON.stringify(next.params), next.timeZone, next.mode, next.recheckMinutes, new Date().toISOString(), id);
      if (changes.roles) this.#setRoles(id, changes.roles);
    })();
    this.#revision += 1;
    return this.get(id);
  }

  delete(id: string): boolean {
    this.#revision += 1;
    return db().query('DELETE FROM automation WHERE id = ?').run(id).changes > 0;
  }

  // --- what its triggers last saw ---------------------------------------------------

  trigger(id: string, index: number): TriggerState | null {
    const row = db()
      .query<{ holds: number; held_since: string | null; fired: number }, [string, number]>('SELECT holds, held_since, fired FROM automation_trigger WHERE automation_id = ? AND trigger = ?')
      .get(id, index);
    return row ? { last: row.holds === 1, heldSince: row.held_since, fired: row.fired === 1 } : null;
  }

  keepTrigger(id: string, index: number, state: TriggerState): void {
    db()
      .query('INSERT INTO automation_trigger (automation_id, trigger, holds, held_since, fired) VALUES (?, ?, ?, ?, ?) ON CONFLICT (automation_id, trigger) DO UPDATE SET holds = excluded.holds, held_since = excluded.held_since, fired = excluded.fired')
      .run(id, index, state.last ? 1 : 0, state.last ? state.heldSince : null, state.last && state.fired ? 1 : 0);
  }

  /** It starts afresh: what its triggers saw is forgotten, and it last looked now. */
  startAfresh(id: string, at: string): void {
    db().transaction(() => {
      db().query('DELETE FROM automation_trigger WHERE automation_id = ?').run(id);
      db().query('UPDATE automation SET looked_at = ? WHERE id = ?').run(at, id);
    })();
  }

  /** It looked again, to keep things so. */
  looked(id: string, at: string): void {
    db().query('UPDATE automation SET looked_at = ? WHERE id = ?').run(at, id);
  }

  // --- runs ---------------------------------------------------------------------------

  /** A run that takes steps, begun: its row, written again at every step. Throws if one of the automation's already runs. */
  beginRun(automationId: string, run: RunResult): string {
    const id = `r-${randomBytes(8).toString('hex')}`;
    db()
      .query('INSERT INTO automation_run (id, automation_id, started_at, ended_at, outcome, started_by, why, summary, detail) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(id, automationId, run.at, 'running', run.startedBy, run.why, run.summary, detailOf(run));
    return id;
  }

  /** Where a run has got to. */
  stepRun(runId: string, run: RunResult): void {
    db().query('UPDATE automation_run SET summary = ?, detail = ? WHERE id = ? AND ended_at IS NULL').run(run.summary, detailOf(run), runId);
  }

  /** A run ended, as it came out. */
  endRun(runId: string, run: RunResult): void {
    db()
      .query('UPDATE automation_run SET ended_at = ?, outcome = ?, summary = ?, detail = ? WHERE id = ?')
      .run(run.endedAt ?? new Date().toISOString(), run.outcome, run.summary, detailOf(run), runId);
  }

  /**
   * A run that was over as it began — commands alone, or nothing to do — kept
   * at once. Null when its automation was deleted while it ran: its runs went
   * with it, and so does this one.
   */
  ran(automationId: string, run: RunResult): string | null {
    const id = `r-${randomBytes(8).toString('hex')}`;
    const kept = db()
      .query(
        'INSERT INTO automation_run (id, automation_id, started_at, ended_at, outcome, started_by, why, summary, detail) SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM automation WHERE id = ?'
      )
      .run(id, run.at, run.endedAt ?? run.at, run.outcome, run.startedBy, run.why, run.summary, detailOf(run), automationId);
    return kept.changes > 0 ? id : null;
  }

  /** Runs that never ended: interrupted, when found as the server starts. */
  unended(): { automationId: string; run: RunResult }[] {
    return db()
      .query<RunRow, []>('SELECT * FROM automation_run WHERE ended_at IS NULL')
      .all()
      .map((row) => ({ automationId: row.automation_id, run: runOf(row) }));
  }

  /** An automation's runs, the latest first. */
  runs(automationId: string, limit = 50): RunResult[] {
    return db().query<RunRow, [string, number]>('SELECT * FROM automation_run WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?').all(automationId, limit).map(runOf);
  }
}
