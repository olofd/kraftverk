import { randomBytes } from 'node:crypto';

import type { RoleBinding } from '@kraftverk/api-contract';
import { automationId, type ConfigValues } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';
import type { AutomationMode, AutomationRecord, RunResult } from './engine.ts';

type Row = {
  id: string;
  name: string;
  recipe: string;
  roles: string;
  params: string;
  time_zone: string;
  mode: AutomationMode;
  recheck_minutes: number | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_result: string | null;
};

const parse = <T>(json: string | null, fallback: T): T => {
  try {
    return json === null ? fallback : (JSON.parse(json) as T);
  } catch {
    return fallback;
  }
};

/** A last run as runs are now said: one kept before a run said why and what it did is shown as none; the timeline still has it. */
const runOf = (run: RunResult | null): RunResult | null => (run && Array.isArray(run.actions) && Array.isArray(run.conditions) ? run : null);

const toRecord = (row: Row): AutomationRecord => ({
  id: automationId(row.id),
  name: row.name,
  recipe: row.recipe,
  roles: parse<Record<string, RoleBinding>>(row.roles, {}),
  params: parse<ConfigValues>(row.params, {}),
  timeZone: row.time_zone,
  mode: row.mode,
  recheckMinutes: row.recheck_minutes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastRunAt: row.last_run_at,
  lastResult: runOf(parse<RunResult | null>(row.last_result, null)),
});

/** The automations you made. Validation is the caller's: this only keeps them. */
export class AutomationStore {
  #revision = 0;

  /** Moves whenever an automation is made, changed or deleted — not when one runs: what the engine indexes by. */
  get revision(): number {
    return this.#revision;
  }

  list(): AutomationRecord[] {
    return db().query<Row, []>('SELECT * FROM automation ORDER BY created_at').all().map(toRecord);
  }

  get(id: string): AutomationRecord | null {
    const row = db().query<Row, [string]>('SELECT * FROM automation WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  create(input: Pick<AutomationRecord, 'name' | 'recipe' | 'roles' | 'params' | 'timeZone' | 'recheckMinutes'>): AutomationRecord {
    const id = automationId(`a-${randomBytes(6).toString('hex')}`);
    const now = new Date().toISOString();
    db()
      .query('INSERT INTO automation (id, name, recipe, roles, params, time_zone, mode, recheck_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.recipe, JSON.stringify(input.roles), JSON.stringify(input.params), input.timeZone, 'observe', input.recheckMinutes, now, now);
    this.#revision += 1;
    return this.get(id)!;
  }

  update(id: string, changes: Partial<Pick<AutomationRecord, 'name' | 'roles' | 'params' | 'timeZone' | 'mode' | 'recheckMinutes'>>): AutomationRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...changes };
    db()
      .query('UPDATE automation SET name = ?, roles = ?, params = ?, time_zone = ?, mode = ?, recheck_minutes = ?, updated_at = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.roles), JSON.stringify(next.params), next.timeZone, next.mode, next.recheckMinutes, new Date().toISOString(), id);
    this.#revision += 1;
    return this.get(id);
  }

  ran(id: string, result: RunResult): void {
    db().query('UPDATE automation SET last_run_at = ?, last_result = ? WHERE id = ?').run(result.at, JSON.stringify(result), id);
  }

  delete(id: string): boolean {
    this.#revision += 1;
    return db().query('DELETE FROM automation WHERE id = ?').run(id).changes > 0;
  }
}
