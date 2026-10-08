import type { SqlDatabase } from './database.ts';

/**
 * Each person's own shortcuts on their home page (docs/PLAN-WORLD-MODEL.md
 * §8.3): the automations they start from it, in their order — a person's
 * own, never one list for everyone. Places are 0, 1, 2… as they are said;
 * one taken off, or deleted, and the rest close up.
 */
export class ShortcutStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** A person's shortcuts: automation ids, in their order. */
  of(personId: string): string[] {
    return this.#db
      .query<{ automation_id: string }, [string]>('SELECT automation_id FROM shortcut WHERE person_id = ? ORDER BY position')
      .all(personId)
      .map((row) => row.automation_id);
  }

  /** Where an automation is among a person's shortcuts; null, not there. */
  placeOf(personId: string, automationId: string): number | null {
    const at = this.of(personId).indexOf(automationId);
    return at < 0 ? null : at;
  }

  /** Puts an automation among a person's shortcuts at `place` — the others moving along to make room — or takes it off (null). */
  place(personId: string, automationId: string, place: number | null): void {
    const order = this.of(personId).filter((id) => id !== automationId);
    if (place !== null) order.splice(Math.max(0, Math.min(place, order.length)), 0, automationId);
    this.set(personId, order);
  }

  /** A person's shortcuts, all at once, in this order. */
  set(personId: string, automationIds: readonly string[]): void {
    this.#db.transaction(() => {
      this.#db.query('DELETE FROM shortcut WHERE person_id = ?').run(personId);
      const put = this.#db.query('INSERT INTO shortcut (person_id, automation_id, position) VALUES (?, ?, ?)');
      [...new Set(automationIds)].forEach((id, position) => put.run(personId, id, position));
    })();
  }
}
