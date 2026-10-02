import { randomBytes } from 'node:crypto';

import type { RoleBinding, RunLog, RunLogDevice, RunLogKey, RunLogReach, RunLogReading, RunLogRole } from '@kraftverk/api-contract';
import { KEY, keyFrom } from '@kraftverk/device-sdk';
import { automationId, savedDeviceId, type AutomationId, type Quantity, type Value } from '@kraftverk/device-sdk';
import type { Rule } from '@kraftverk/automation';

import { db } from '../history/db.ts';
import type { AutomationMode, AutomationRecord, AutomationStorage, RunResult, TriggerState } from '@kraftverk/automation-engine';

/**
 * The automations you made — each with its own rule — what fills their
 * roles, what their triggers last saw, their places on the home page, and
 * every run (docs/DATA-MODEL.md, docs/SEQUENCES.md,
 * docs/AUTOMATION-EDITOR.md). Validation is the caller's: this only keeps
 * them.
 */

type Row = {
  id: string;
  key: string;
  name: string;
  rule: string;
  made_from: string | null;
  time_zone: string;
  mode: AutomationMode;
  recheck_minutes: number | null;
  home_place: number | null;
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
  started_by_run: string | null;
  why: string;
  summary: string;
  detail: string;
  /** Joined: the automation, and its name, whose run started this one. */
  parent_automation: string | null;
  parent_name: string | null;
};

/** A run, with the automation of the run that started it. */
const RUN_SELECT = `SELECT r.*, p.automation_id AS parent_automation, pa.name AS parent_name
  FROM automation_run r
  LEFT JOIN automation_run p ON p.id = r.started_by_run
  LEFT JOIN automation pa ON pa.id = p.automation_id`;

/** What an automation is made of, as it is kept: its rule, and what fills its roles. */
export type AutomationInput = Pick<AutomationRecord, 'name' | 'rule' | 'madeFrom' | 'roles' | 'starts' | 'timeZone' | 'recheckMinutes'>;

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
    startedByRun:
      row.started_by_run && row.parent_automation && row.parent_name !== null
        ? { id: row.started_by_run, automationId: automationId(row.parent_automation), name: row.parent_name }
        : null,
    outcome: row.outcome,
    summary: row.summary,
    why: row.why,
    saw: detail.saw ?? [],
    conditions: detail.conditions ?? [],
    steps: detail.steps ?? [],
  };
};

const detailOf = (run: RunResult): string => JSON.stringify({ saw: run.saw, conditions: run.conditions, steps: run.steps } satisfies RunDetail);

/** A rule with nothing in it: what a row whose JSON could not be read is shown as, and refuses to run. */
const EMPTY_RULE: Rule = { roles: {}, params: { fields: {} }, when: [], then: [] };

export class AutomationStore implements AutomationStorage {
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
    const starts = new Map<string, Record<string, AutomationId>>();
    for (const role of db()
      .query<{ automation_id: string; role: string; device_id: string | null; part: string | null; starts: string | null }, string[]>(
        `SELECT automation_id, role, device_id, part, starts FROM automation_role WHERE automation_id IN (${marks})`
      )
      .all(...ids)) {
      if (role.starts) starts.set(role.automation_id, { ...starts.get(role.automation_id), [role.role]: automationId(role.starts) });
      else if (role.device_id && role.part) roles.set(role.automation_id, { ...roles.get(role.automation_id), [role.role]: { device: savedDeviceId(role.device_id), part: role.part } });
    }
    // Each one's latest ended run, and the one it runs now.
    const last = new Map(
      db()
        .query<RunRow, string[]>(
          `${RUN_SELECT}
           WHERE r.automation_id IN (${marks}) AND r.ended_at IS NOT NULL
             AND r.started_at = (SELECT MAX(started_at) FROM automation_run WHERE automation_id = r.automation_id AND ended_at IS NOT NULL)`
        )
        .all(...ids)
        .map((row) => [row.automation_id, runOf(row)])
    );
    const running = new Map(
      db()
        .query<RunRow, string[]>(`${RUN_SELECT} WHERE r.automation_id IN (${marks}) AND r.ended_at IS NULL`)
        .all(...ids)
        .map((row) => [row.automation_id, runOf(row)])
    );
    return rows.map((row) => ({
      id: automationId(row.id),
      key: row.key,
      name: row.name,
      rule: parse<Rule>(row.rule, EMPTY_RULE),
      madeFrom: row.made_from,
      roles: roles.get(row.id) ?? {},
      starts: starts.get(row.id) ?? {},
      timeZone: row.time_zone,
      mode: row.mode,
      recheckMinutes: row.recheck_minutes,
      homePlace: row.home_place,
      lookedAt: row.looked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRun: last.get(row.id) ?? null,
      running: running.get(row.id) ?? null,
    }));
  }

  list(): AutomationRecord[] {
    return this.#records(db().query<Row, []>('SELECT * FROM automation ORDER BY created_at, rowid').all());
  }

  get(id: string): AutomationRecord | null {
    return this.#records(db().query<Row, [string]>('SELECT * FROM automation WHERE id = ?').all(id))[0] ?? null;
  }

  /** The automations a device fills a role of: what its page lists. */
  usingDevice(deviceId: string): AutomationRecord[] {
    return this.#records(
      db()
        .query<Row, [string]>('SELECT a.* FROM automation a WHERE a.id IN (SELECT automation_id FROM automation_role WHERE device_id = ?) ORDER BY a.created_at')
        .all(deviceId)
    );
  }

  /** The automations on the home page, in their places. */
  onHome(): AutomationRecord[] {
    return this.#records(db().query<Row, []>('SELECT * FROM automation WHERE home_place IS NOT NULL ORDER BY home_place').all());
  }

  #setRoles(id: string, roles: Record<string, RoleBinding>, starts: Record<string, AutomationId>): void {
    db().query('DELETE FROM automation_role WHERE automation_id = ?').run(id);
    const part = db().query('INSERT INTO automation_role (automation_id, role, device_id, part, starts) VALUES (?, ?, ?, ?, NULL)');
    for (const [role, binding] of Object.entries(roles)) part.run(id, role, binding.device, binding.part);
    const automation = db().query('INSERT INTO automation_role (automation_id, role, device_id, part, starts) VALUES (?, ?, NULL, NULL, ?)');
    for (const [role, started] of Object.entries(starts)) automation.run(id, role, started);
  }

  /** The automation known by this key, or null. */
  byKey(key: string): AutomationRecord | null {
    return this.#records(db().query<Row, [string]>('SELECT * FROM automation WHERE key = ?').all(key))[0] ?? null;
  }

  /** Whether an automation is known by this key. */
  keyTaken(key: string, except?: string): boolean {
    return db().query<{ id: string }, [string]>('SELECT id FROM automation WHERE key = ?').all(key).some((row) => row.id !== except);
  }

  create(input: AutomationInput & { key?: string }): AutomationRecord {
    if (input.key !== undefined && (!KEY.test(input.key) || this.keyTaken(input.key))) throw new Error(`"${input.key}" is not a free key: lowercase letters, digits and dashes, and not another automation's`);
    const id = automationId(`a-${randomBytes(6).toString('hex')}`);
    const key = input.key ?? keyFrom(input.name, (taken) => this.keyTaken(taken), 'automation');
    const now = new Date().toISOString();
    db().transaction(() => {
      db()
        // Not looked at yet: the engine says when it looks, on its own clock.
        .query('INSERT INTO automation (id, key, name, rule, made_from, time_zone, mode, recheck_minutes, home_place, looked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
        .run(id, key, input.name, JSON.stringify(input.rule), input.madeFrom, input.timeZone, 'observe', input.recheckMinutes, now, now);
      this.#setRoles(id, input.roles, input.starts);
    })();
    this.#revision += 1;
    return this.get(id)!;
  }

  /** A change: a new rule comes with what fills its roles. */
  update(id: string, changes: Partial<Pick<AutomationRecord, 'key' | 'name' | 'rule' | 'roles' | 'starts' | 'timeZone' | 'mode' | 'recheckMinutes'>>): AutomationRecord | null {
    const current = this.get(id);
    if (!current) return null;
    if (changes.key !== undefined && changes.key !== current.key && (!KEY.test(changes.key) || this.keyTaken(changes.key, id))) {
      throw new Error(`"${changes.key}" is not a free key: lowercase letters, digits and dashes, and not another automation's`);
    }
    const next = { ...current, ...changes };
    db().transaction(() => {
      db()
        .query('UPDATE automation SET key = ?, name = ?, rule = ?, time_zone = ?, mode = ?, recheck_minutes = ?, updated_at = ? WHERE id = ?')
        .run(next.key, next.name, JSON.stringify(next.rule), next.timeZone, next.mode, next.recheckMinutes, new Date().toISOString(), id);
      if (changes.roles || changes.starts) this.#setRoles(id, next.roles, next.starts);
    })();
    this.#revision += 1;
    return this.get(id);
  }

  /**
   * Puts it on the home page at `place` — the others moving along to make
   * room — or takes it off (null). Places stay 0, 1, 2… in order.
   */
  placeOnHome(id: string, place: number | null): AutomationRecord | null {
    if (!this.get(id)) return null;
    db().transaction(() => {
      const order = db()
        .query<{ id: string }, [string]>('SELECT id FROM automation WHERE home_place IS NOT NULL AND id <> ? ORDER BY home_place')
        .all(id)
        .map((row) => row.id);
      if (place !== null) order.splice(Math.max(0, Math.min(place, order.length)), 0, id);
      // Cleared first: the unique index holds every place to one automation, even between two updates.
      db().query('UPDATE automation SET home_place = NULL WHERE home_place IS NOT NULL OR id = ?').run(id);
      const put = db().query('UPDATE automation SET home_place = ? WHERE id = ?');
      order.forEach((one, index) => put.run(index, one));
    })();
    this.#revision += 1;
    return this.get(id);
  }

  delete(id: string): boolean {
    this.#revision += 1;
    const deleted = db().query('DELETE FROM automation WHERE id = ?').run(id).changes > 0;
    // The shortcuts close up behind it.
    if (deleted) {
      const order = db().query<{ id: string }, []>('SELECT id FROM automation WHERE home_place IS NOT NULL ORDER BY home_place').all();
      db().transaction(() => {
        db().query('UPDATE automation SET home_place = NULL WHERE home_place IS NOT NULL').run();
        const put = db().query('UPDATE automation SET home_place = ? WHERE id = ?');
        order.forEach((one, index) => put.run(index, one.id));
      })();
    }
    return deleted;
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
      .query('INSERT INTO automation_run (id, automation_id, started_at, ended_at, outcome, started_by, started_by_run, why, summary, detail) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)')
      .run(id, automationId, run.at, 'running', run.startedBy, run.startedByRun?.id ?? null, run.why, run.summary, detailOf(run));
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
        'INSERT INTO automation_run (id, automation_id, started_at, ended_at, outcome, started_by, started_by_run, why, summary, detail) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM automation WHERE id = ?'
      )
      .run(id, run.at, run.endedAt ?? run.at, run.outcome, run.startedBy, run.startedByRun?.id ?? null, run.why, run.summary, detailOf(run), automationId);
    return kept.changes > 0 ? id : null;
  }

  /** One run, as it stands — what a step that waits on another automation's run looks at. */
  run(runId: string): RunResult | null {
    const row = db().query<RunRow, [string]>(`${RUN_SELECT} WHERE r.id = ?`).get(runId);
    return row ? runOf(row) : null;
  }

  /** Runs that never ended: interrupted, when found as the server starts. */
  unended(): { automationId: string; run: RunResult }[] {
    return db()
      .query<RunRow, []>(`${RUN_SELECT} WHERE r.ended_at IS NULL`)
      .all()
      .map((row) => ({ automationId: row.automation_id, run: runOf(row) }));
  }

  /**
   * A run's log, kept as it comes, in one transaction a look: the devices and
   * roles it uses (as it begins), what each value it keeps is (the first time
   * one is seen), every reading, and whether each device could be reached.
   */
  recordLog(runId: string, log: Partial<Pick<RunLog, 'devices' | 'roles' | 'keys' | 'readings' | 'reach'>>): void {
    const { devices = [], roles = [], keys = [], readings = [], reach = [] } = log;
    if (!devices.length && !roles.length && !keys.length && !readings.length && !reach.length) return;
    const handle = db();
    handle.transaction(() => {
      const device = handle.query('INSERT INTO automation_run_device (run_id, device_id, name, type_id) VALUES (?, ?, ?, ?)');
      for (const each of devices) device.run(runId, each.id, each.name, each.typeId);
      const role = handle.query('INSERT INTO automation_run_role (run_id, role, label, device_id, part) VALUES (?, ?, ?, ?, ?)');
      for (const each of roles) role.run(runId, each.role, each.label, each.device, each.part);
      const key = handle.query('INSERT INTO automation_run_key (run_id, device_id, key, part, label, kind, unit, quantity, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const each of keys) {
        const words = each.kind === 'boolean' ? each.words : each.kind === 'enum' ? each.options : null;
        key.run(runId, each.device, each.key, each.part, each.label, each.kind, each.unit, each.quantity, words ? JSON.stringify(words) : null);
      }
      const reading = handle.query('INSERT INTO automation_run_reading (run_id, device_id, key, at, heard_at, value) VALUES (?, ?, ?, ?, ?, ?)');
      for (const each of readings) reading.run(runId, each.device, each.key, each.at, each.heardAt, JSON.stringify(each.value));
      const reached = handle.query('INSERT INTO automation_run_reach (run_id, device_id, at, reachable, detail) VALUES (?, ?, ?, ?, ?)');
      for (const each of reach) reached.run(runId, each.device, each.at, each.reachable ? 1 : 0, each.detail);
    })();
  }

  /** One of an automation's runs with its log, the earliest first; null when the run is not one of its. */
  runLog(automationId: string, runId: string): Omit<RunLog, 'capped'> | null {
    const handle = db();
    if (!handle.query('SELECT 1 FROM automation_run WHERE id = ? AND automation_id = ?').get(runId, automationId)) return null;
    const run = this.run(runId);
    if (!run) return null;
    const devices = handle
      .query<{ device_id: string; name: string; type_id: string }, [string]>('SELECT device_id, name, type_id FROM automation_run_device WHERE run_id = ? ORDER BY rowid')
      .all(runId)
      .map((row): RunLogDevice => ({ id: row.device_id, name: row.name, typeId: row.type_id }));
    const roles = handle
      .query<{ role: string; label: string; device_id: string; part: string }, [string]>('SELECT role, label, device_id, part FROM automation_run_role WHERE run_id = ? ORDER BY rowid')
      .all(runId)
      .map((row): RunLogRole => ({ role: row.role, label: row.label, device: row.device_id, part: row.part }));
    const keys = handle
      .query<{ device_id: string; key: string; part: string; label: string; kind: RunLogKey['kind']; unit: string | null; quantity: string | null; words: string | null }, [string]>(
        'SELECT device_id, key, part, label, kind, unit, quantity, words FROM automation_run_key WHERE run_id = ? ORDER BY rowid'
      )
      .all(runId)
      .map(
        (row): RunLogKey => ({
          device: row.device_id,
          key: row.key,
          part: row.part,
          label: row.label,
          kind: row.kind,
          unit: row.unit,
          quantity: row.quantity as Quantity | null,
          words: row.kind === 'boolean' && row.words ? (JSON.parse(row.words) as RunLogKey['words']) : null,
          options: row.kind === 'enum' && row.words ? (JSON.parse(row.words) as RunLogKey['options']) : null,
        })
      );
    const readings = handle
      .query<{ device_id: string; key: string; at: string; heard_at: string; value: string }, [string]>(
        'SELECT device_id, key, at, heard_at, value FROM automation_run_reading WHERE run_id = ? ORDER BY at, rowid'
      )
      .all(runId)
      .map((row): RunLogReading => ({ device: row.device_id, key: row.key, at: row.at, heardAt: row.heard_at, value: JSON.parse(row.value) as Value }));
    const reach = handle
      .query<{ device_id: string; at: string; reachable: number; detail: string }, [string]>('SELECT device_id, at, reachable, detail FROM automation_run_reach WHERE run_id = ? ORDER BY at, rowid')
      .all(runId)
      .map((row): RunLogReach => ({ device: row.device_id, at: row.at, reachable: row.reachable === 1, detail: row.detail }));
    return { run, devices, roles, keys, readings, reach };
  }

  /** An automation's runs, the latest first. */
  runs(automationId: string, limit = 50): RunResult[] {
    return db().query<RunRow, [string, number]>(`${RUN_SELECT} WHERE r.automation_id = ? ORDER BY r.started_at DESC LIMIT ?`).all(automationId, limit).map(runOf);
  }
}
