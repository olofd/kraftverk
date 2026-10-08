import type { LabelInput, LabelTarget, LabelView, Labelled } from '@kraftverk/api-contract';
import { KEY, keyFrom, newId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * A family's labels, and what each is on (docs/PLAN-WORLD-MODEL.md §8.13):
 * any grouping it wants, across devices, spaces and automations. A label
 * goes, and is taken off everything with it; nothing's history hangs on one.
 */

type LabelRow = { id: string; key: string; name: string; color: string | null; icon: string | null };

const labelOf = (row: LabelRow): LabelView => ({ id: row.id, key: row.key, name: row.name, color: row.color, icon: row.icon });

/** Which column a target is kept in. */
const columnOf = (target: LabelTarget): ['device_id' | 'space_id' | 'automation_id', string] =>
  'device' in target ? ['device_id', target.device] : 'space' in target ? ['space_id', target.space] : ['automation_id', target.automation];

export class LabelStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** Every label, by name. */
  list(): LabelView[] {
    return this.#db.query<LabelRow, []>('SELECT * FROM label ORDER BY name COLLATE NOCASE').all().map(labelOf);
  }

  get(id: string): LabelView | null {
    const row = this.#db.query<LabelRow, [string]>('SELECT * FROM label WHERE id = ?').get(id);
    return row ? labelOf(row) : null;
  }

  byKey(key: string): LabelView | null {
    const row = this.#db.query<LabelRow, [string]>('SELECT * FROM label WHERE key = ?').get(key);
    return row ? labelOf(row) : null;
  }

  /** Whether a name is another label's: names are unique, as a person reads them. */
  nameTaken(name: string, except?: string): boolean {
    return this.#db.query<{ id: string }, [string]>('SELECT id FROM label WHERE name = ? COLLATE NOCASE').all(name).some((row) => row.id !== except);
  }

  add(input: LabelInput): LabelView {
    if (input.key !== undefined && (!KEY.test(input.key) || this.byKey(input.key))) throw new Error(`"${input.key}" is not a free key`);
    if (this.nameTaken(input.name)) throw new Error(`There is a label called "${input.name}" already`);
    const key = input.key ?? keyFrom(input.name, (taken) => this.byKey(taken) !== null, 'label');
    const id = newId('l');
    this.#db.query('INSERT INTO label (id, key, name, color, icon) VALUES (?, ?, ?, ?, ?)').run(id, key, input.name, input.color ?? null, input.icon ?? null);
    return this.get(id)!;
  }

  update(id: string, changes: Partial<LabelInput>): LabelView | null {
    const was = this.get(id);
    if (!was) return null;
    if (changes.name !== undefined && this.nameTaken(changes.name, id)) throw new Error(`There is a label called "${changes.name}" already`);
    if (changes.key !== undefined && changes.key !== was.key && (!KEY.test(changes.key) || this.byKey(changes.key))) throw new Error(`"${changes.key}" is not a free key`);
    const next = { ...was, ...changes };
    this.#db.query('UPDATE label SET key = ?, name = ?, color = ?, icon = ? WHERE id = ?').run(next.key, next.name, next.color ?? null, next.icon ?? null, id);
    return this.get(id);
  }

  /** A label gone, and off everything it was on. */
  remove(id: string): boolean {
    return this.#db.query('DELETE FROM label WHERE id = ?').run(id).changes > 0;
  }

  /** The labels on one thing, by name. */
  on(target: LabelTarget): LabelView[] {
    const [column, id] = columnOf(target);
    return this.#db.query<LabelRow, [string]>(`SELECT l.* FROM label l JOIN labelled x ON x.label_id = l.id WHERE x.${column} = ? ORDER BY l.name COLLATE NOCASE`).all(id).map(labelOf);
  }

  /** One thing's labels, these and no others. */
  set(target: LabelTarget, labelIds: readonly string[]): void {
    const [column, id] = columnOf(target);
    this.#db.transaction(() => {
      this.#db.query(`DELETE FROM labelled WHERE ${column} = ?`).run(id);
      for (const labelId of new Set(labelIds)) this.#db.query(`INSERT INTO labelled (label_id, ${column}) VALUES (?, ?)`).run(labelId, id);
    })();
  }

  /** What every label is on, by what. */
  labelled(): Labelled {
    const found: Labelled = { devices: {}, spaces: {}, automations: {} };
    const rows = this.#db.query<{ label_id: string; device_id: string | null; space_id: string | null; automation_id: string | null }, []>('SELECT * FROM labelled').all();
    for (const row of rows) {
      const [into, id] = row.device_id ? [found.devices, row.device_id] : row.space_id ? [found.spaces, row.space_id] : [found.automations, row.automation_id!];
      (into[id] ??= []).push(row.label_id);
    }
    return found;
  }
}
