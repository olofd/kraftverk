import { randomBytes } from 'node:crypto';

import type { RoleBinding } from '@kraftverk/api-contract';
import type { ConfigValues } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';
import type { AutomationMode, AutomationRecord, RunResult } from './recipes.ts';

type Row = {
  id: string;
  name: string;
  recipe: string;
  roles: string;
  params: string;
  time_zone: string;
  mode: AutomationMode;
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

const toRecord = (row: Row): AutomationRecord => ({
  id: row.id,
  name: row.name,
  recipe: row.recipe,
  roles: parse<Record<string, RoleBinding>>(row.roles, {}),
  params: parse<ConfigValues>(row.params, {}),
  timeZone: row.time_zone,
  mode: row.mode,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastRunAt: row.last_run_at,
  lastResult: parse<RunResult | null>(row.last_result, null),
});

/** The automations you made. Validation is the caller's: this only keeps them. */
export class AutomationStore {
  list(): AutomationRecord[] {
    return db().query<Row, []>('SELECT * FROM automation ORDER BY created_at').all().map(toRecord);
  }

  get(id: string): AutomationRecord | null {
    const row = db().query<Row, [string]>('SELECT * FROM automation WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  create(input: Pick<AutomationRecord, 'name' | 'recipe' | 'roles' | 'params' | 'timeZone'>): AutomationRecord {
    const id = `a-${randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    db()
      .query('INSERT INTO automation (id, name, recipe, roles, params, time_zone, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.recipe, JSON.stringify(input.roles), JSON.stringify(input.params), input.timeZone, 'observe', now, now);
    return this.get(id)!;
  }

  update(id: string, changes: Partial<Pick<AutomationRecord, 'name' | 'roles' | 'params' | 'timeZone' | 'mode'>>): AutomationRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...changes };
    db()
      .query('UPDATE automation SET name = ?, roles = ?, params = ?, time_zone = ?, mode = ?, updated_at = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.roles), JSON.stringify(next.params), next.timeZone, next.mode, new Date().toISOString(), id);
    return this.get(id);
  }

  ran(id: string, result: RunResult): void {
    db().query('UPDATE automation SET last_run_at = ?, last_result = ? WHERE id = ?').run(result.at, JSON.stringify(result), id);
  }

  delete(id: string): boolean {
    return db().query('DELETE FROM automation WHERE id = ?').run(id).changes > 0;
  }
}
