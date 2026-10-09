
import type { AutomationRun, RunLog, RunLogDevice, RunLogKey, RunLogReach, RunLogReading, RunLogRole } from '@kraftverk/api-contract';
import { KEY, keyFrom } from '@kraftverk/device-sdk';
import { automationId, savedDeviceId, type ActorKind, type AutomationId, type Quantity, type Value } from '@kraftverk/device-sdk';
import type { PlaceKind, RoleBinding, Rule, WorldFill } from '@kraftverk/automation';

import type { SqlDatabase } from './database.ts';
import { newId } from '@kraftverk/device-sdk';
import type { AutomationMode, AutomationRecord, AutomationStorage, Seen, TriggerState } from '@kraftverk/automation-engine';

/**
 * The automations you made — each with its own rule — what fills their
 * roles, what their triggers last saw, and every run (docs/DATA-MODEL.md, docs/SEQUENCES.md,
 * docs/AUTOMATION-EDITOR.md). Validation is the caller's: this only keeps
 * them.
 */

type Row = {
  id: string;
  key: string;
  name: string;
  rule: string;
  made_from: string | null;
  home_id: string | null;
  time_zone: string | null;
  mode: AutomationMode;
  recheck_minutes: number | null;
  acting_for: string | null;
  looked_at: string | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  automation_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: AutomationRun['outcome'];
  started_by_kind: ActorKind | null;
  started_by_id: string | null;
  started_by_name: string | null;
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
export type AutomationInput = Pick<AutomationRecord, 'name' | 'rule' | 'madeFrom' | 'roles' | 'groups' | 'starts' | 'recheckMinutes'> & {
  /** Who and where fills its roles of the family's world; none: it has none. */
  world?: Record<string, WorldFill>;
  /** Which script fills each role a script fills; none: it has none. */
  scripts?: Record<string, string>;
  /** The home it is for; null or left out: the family's. */
  homeId?: string | null;
  /** A clock of its own; null: its home's. */
  timeZone: string | null;
};

/** What an automation keeps changed: its clock its own (a time zone) or its home's (null). */
export type AutomationUpdate = Partial<Pick<AutomationRecord, 'key' | 'name' | 'rule' | 'roles' | 'groups' | 'starts' | 'scripts' | 'world' | 'mode' | 'actingFor' | 'recheckMinutes' | 'homeId'>> & { timeZone?: string | null };

/** Where no home says a clock: none kept yet. */
const NO_CLOCK = 'UTC';

/** What a run keeps beside its columns. */
type RunDetail = Pick<AutomationRun, 'saw' | 'conditions' | 'steps' | 'answered'>;

const parse = <T>(json: string | null, fallback: T): T => {
  try {
    return json === null ? fallback : (JSON.parse(json) as T);
  } catch {
    return fallback;
  }
};

/** Who started a run, as its three columns: all null when its own triggers did. */
const startedBy = (run: AutomationRun): [ActorKind | null, string | null, string | null] => [run.startedBy?.kind ?? null, run.startedBy?.id ?? null, run.startedBy?.name ?? null];

const runOf = (row: RunRow): AutomationRun => {
  const detail = parse<Partial<RunDetail>>(row.detail, {});
  return {
    id: row.id,
    at: row.started_at,
    endedAt: row.ended_at,
    startedBy: row.started_by_kind && row.started_by_name !== null ? { kind: row.started_by_kind, id: row.started_by_id, name: row.started_by_name } : null,
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
    answered: detail.answered ?? null,
  };
};

const detailOf = (run: AutomationRun): string => JSON.stringify({ saw: run.saw, conditions: run.conditions, steps: run.steps, answered: run.answered } satisfies RunDetail);

/** A rule with nothing in it: what a row whose JSON could not be read is shown as, and refuses to run. */
const EMPTY_RULE: Rule = { roles: {}, params: { fields: {} }, when: [], then: [] };

export class AutomationStore implements AutomationStorage {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  #revision = 0;

  /** Moves whenever an automation is made, changed or deleted — not when one runs: what the engine indexes by. */
  get revision(): number {
    return this.#revision;
  }

  #records(rows: Row[]): AutomationRecord[] {
    if (!rows.length) return [];
    // Each home's clock, and the first home's: what one with no clock of its own keeps.
    const homes = this.#db
      .query<{ id: string; time_zone: string }, []>("SELECT p.id, p.time_zone FROM place p JOIN home h ON h.id = p.id WHERE p.removed_at IS NULL ORDER BY h.position, p.created_at")
      .all();
    const clocks = new Map(homes.map((home) => [home.id, home.time_zone]));
    const first = homes[0]?.time_zone;
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => '?').join(', ');
    const roles = new Map<string, Record<string, RoleBinding>>();
    const starts = new Map<string, Record<string, AutomationId>>();
    const scripts = new Map<string, Record<string, string>>();
    for (const role of this.#db
      .query<{ automation_id: string; role: string; device_id: string | null; part: string | null; starts: string | null; script_id: string | null }, string[]>(
        `SELECT automation_id, role, device_id, part, starts, script_id FROM automation_role WHERE automation_id IN (${marks})`
      )
      .all(...ids)) {
      if (role.starts) starts.set(role.automation_id, { ...starts.get(role.automation_id), [role.role]: automationId(role.starts) });
      else if (role.script_id) scripts.set(role.automation_id, { ...scripts.get(role.automation_id), [role.role]: role.script_id });
      else if (role.device_id && role.part) roles.set(role.automation_id, { ...roles.get(role.automation_id), [role.role]: { device: savedDeviceId(role.device_id), part: role.part } });
    }
    // Each group's parts, in their order.
    const groups = new Map<string, Record<string, RoleBinding[]>>();
    for (const member of this.#db
      .query<{ automation_id: string; role: string; device_id: string; part: string }, string[]>(
        `SELECT automation_id, role, device_id, part FROM automation_group_part WHERE automation_id IN (${marks}) ORDER BY automation_id, role, place`
      )
      .all(...ids)) {
      const own = groups.get(member.automation_id) ?? {};
      own[member.role] = [...(own[member.role] ?? []), { device: savedDeviceId(member.device_id), part: member.part }];
      groups.set(member.automation_id, own);
    }
    // Who and where fills each role of the family's world.
    const world = new Map<string, Record<string, WorldFill>>();
    for (const row of this.#db
      .query<{ automation_id: string; role: string; kind: 'person' | 'people' | 'everyone' | 'place'; person_id: string | null; place_id: string | null; place_kind: PlaceKind | null }, string[]>(
        `SELECT automation_id, role, kind, person_id, place_id, place_kind FROM automation_world WHERE automation_id IN (${marks}) ORDER BY automation_id, role, place`
      )
      .all(...ids)) {
      const own = world.get(row.automation_id) ?? {};
      const had = own[row.role];
      own[row.role] =
        row.kind === 'person'
          ? { person: row.person_id! }
          : row.kind === 'people'
            ? { people: [...(had && 'people' in had ? had.people : []), row.person_id!] }
            : row.kind === 'everyone'
              ? { everyone: true }
              : { place: row.place_id!, kind: row.place_kind! };
      world.set(row.automation_id, own);
    }
    // Each one's latest ended run, and the one it runs now.
    const last = new Map(
      this.#db
        .query<RunRow, string[]>(
          `${RUN_SELECT}
           WHERE r.automation_id IN (${marks}) AND r.ended_at IS NOT NULL
             AND r.started_at = (SELECT MAX(started_at) FROM automation_run WHERE automation_id = r.automation_id AND ended_at IS NOT NULL)`
        )
        .all(...ids)
        .map((row) => [row.automation_id, runOf(row)])
    );
    const running = new Map(
      this.#db
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
      groups: groups.get(row.id) ?? {},
      starts: starts.get(row.id) ?? {},
      scripts: scripts.get(row.id) ?? {},
      actingFor: row.acting_for,
      world: world.get(row.id) ?? {},
      homeId: row.home_id,
      timeZone: row.time_zone ?? (row.home_id ? clocks.get(row.home_id) : undefined) ?? first ?? NO_CLOCK,
      ownTimeZone: row.time_zone,
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
    return this.#records(this.#db.query<Row, []>('SELECT * FROM automation ORDER BY created_at, rowid').all());
  }

  get(id: string): AutomationRecord | null {
    return this.#records(this.#db.query<Row, [string]>('SELECT * FROM automation WHERE id = ?').all(id))[0] ?? null;
  }

  /** The automations a device fills a role of: what its page lists. */
  usingDevice(deviceId: string): AutomationRecord[] {
    return this.#records(
      this.#db
        .query<Row, [string, string]>(
          'SELECT a.* FROM automation a WHERE a.id IN (SELECT automation_id FROM automation_role WHERE device_id = ? UNION SELECT automation_id FROM automation_group_part WHERE device_id = ?) ORDER BY a.created_at'
        )
        .all(deviceId, deviceId)
    );
  }

  /** The automations a script fills a role of: those that run it, or call one of its functions. Their ids and names, in the order they were made. */
  usingScript(scriptId: string): { id: string; name: string }[] {
    return this.#db
      .query<{ id: string; name: string }, [string]>('SELECT a.id, a.name FROM automation a WHERE a.id IN (SELECT automation_id FROM automation_role WHERE script_id = ?) ORDER BY a.created_at')
      .all(scriptId);
  }

  /**
   * A device's parts called otherwise — its type changed — in every role
   * filled by one of them. A part that maps to nothing is left as it was: its
   * automation is checked against the device as it is now, and says what to
   * choose again.
   */
  repointParts(deviceId: string, parts: ReadonlyMap<string, string | null>): void {
    // Through parts of no one's first: two parts that swap names must not meet on the way.
    const moves = [...parts].flatMap(([from, to], index) => (to && to !== from ? [{ from, to, parked: `\u0000moving:${index}` }] : []));
    for (const step of [moves.map(({ from, parked }) => [from, parked]), moves.map(({ to, parked }) => [parked, to])]) {
      for (const [was, now] of step) {
        this.#db.query('UPDATE automation_role SET part = ? WHERE device_id = ? AND part = ?').run(now, deviceId, was);
        this.#db.query('UPDATE automation_group_part SET part = ? WHERE device_id = ? AND part = ?').run(now, deviceId, was);
      }
    }
  }

  #setRoles(id: string, fills: Pick<AutomationRecord, 'roles' | 'groups' | 'starts'> & { world?: Record<string, WorldFill>; scripts?: Record<string, string> }): void {
    this.#db.query('DELETE FROM automation_role WHERE automation_id = ?').run(id);
    this.#db.query('DELETE FROM automation_group_part WHERE automation_id = ?').run(id);
    this.#db.query('DELETE FROM automation_world WHERE automation_id = ?').run(id);
    const filled = this.#db.query('INSERT INTO automation_world (automation_id, role, place, kind, person_id, place_id, place_kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [role, fill] of Object.entries(fills.world ?? {})) {
      if ('person' in fill) filled.run(id, role, 0, 'person', fill.person, null, null);
      else if ('people' in fill) fill.people.forEach((person, place) => filled.run(id, role, place, 'people', person, null, null));
      else if ('everyone' in fill) filled.run(id, role, 0, 'everyone', null, null, null);
      else filled.run(id, role, 0, 'place', null, fill.place, fill.kind);
    }
    const part = this.#db.query('INSERT INTO automation_role (automation_id, role, device_id, part, starts) VALUES (?, ?, ?, ?, NULL)');
    for (const [role, binding] of Object.entries(fills.roles)) part.run(id, role, binding.device, binding.part);
    const member = this.#db.query('INSERT INTO automation_group_part (automation_id, role, place, device_id, part) VALUES (?, ?, ?, ?, ?)');
    for (const [role, parts] of Object.entries(fills.groups)) parts.forEach((binding, place) => member.run(id, role, place, binding.device, binding.part));
    const automation = this.#db.query('INSERT INTO automation_role (automation_id, role, device_id, part, starts) VALUES (?, ?, NULL, NULL, ?)');
    for (const [role, started] of Object.entries(fills.starts)) automation.run(id, role, started);
    const script = this.#db.query('INSERT INTO automation_role (automation_id, role, device_id, part, starts, script_id) VALUES (?, ?, NULL, NULL, NULL, ?)');
    for (const [role, scriptId] of Object.entries(fills.scripts ?? {})) script.run(id, role, scriptId);
  }

  /** The automation known by this key, or null. */
  byKey(key: string): AutomationRecord | null {
    return this.#records(this.#db.query<Row, [string]>('SELECT * FROM automation WHERE key = ?').all(key))[0] ?? null;
  }

  /** Whether an automation is known by this key. */
  keyTaken(key: string, except?: string): boolean {
    return this.#db.query<{ id: string }, [string]>('SELECT id FROM automation WHERE key = ?').all(key).some((row) => row.id !== except);
  }

  create(input: AutomationInput & { key?: string }): AutomationRecord {
    if (input.key !== undefined && (!KEY.test(input.key) || this.keyTaken(input.key))) throw new Error(`"${input.key}" is not a free key: lowercase letters, digits and dashes, and not another automation's`);
    const id = automationId(newId('a'));
    const key = input.key ?? keyFrom(input.name, (taken) => this.keyTaken(taken), 'automation');
    const now = new Date().toISOString();
    this.#db.transaction(() => {
      this.#db
        // Not looked at yet: the engine says when it looks, on its own clock.
        .query(
          'INSERT INTO automation (id, key, name, rule, made_from, home_id, time_zone, mode, recheck_minutes, looked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)'
        )
        .run(id, key, input.name, JSON.stringify(input.rule), input.madeFrom, input.homeId ?? null, input.timeZone, 'watch', input.recheckMinutes, now, now);
      this.#setRoles(id, input);
    })();
    this.#revision += 1;
    return this.get(id)!;
  }

  /** A change: a new rule comes with what fills its roles. */
  update(id: string, changes: AutomationUpdate): AutomationRecord | null {
    const current = this.get(id);
    if (!current) return null;
    if (changes.key !== undefined && changes.key !== current.key && (!KEY.test(changes.key) || this.keyTaken(changes.key, id))) {
      throw new Error(`"${changes.key}" is not a free key: lowercase letters, digits and dashes, and not another automation's`);
    }
    const { timeZone, ...rest } = changes;
    const next = { ...current, ...rest, ownTimeZone: timeZone === undefined ? current.ownTimeZone : timeZone };
    this.#db.transaction(() => {
      this.#db
        .query('UPDATE automation SET key = ?, name = ?, rule = ?, home_id = ?, time_zone = ?, mode = ?, acting_for = ?, recheck_minutes = ?, updated_at = ? WHERE id = ?')
        .run(next.key, next.name, JSON.stringify(next.rule), next.homeId, next.ownTimeZone, next.mode, next.mode === 'act' ? next.actingFor : null, next.recheckMinutes, new Date().toISOString(), id);
      if (changes.roles || changes.groups || changes.starts || changes.scripts || changes.world) this.#setRoles(id, next);
    })();
    this.#revision += 1;
    return this.get(id);
  }

  delete(id: string): boolean {
    this.#revision += 1;
    return this.#db.query('DELETE FROM automation WHERE id = ?').run(id).changes > 0;
  }

  // --- what its triggers last saw ---------------------------------------------------

  trigger(id: string, trigger: string): TriggerState | null {
    const row = this.#db
      .query<{ holds: number; held_since: string | null; fired: number }, [string, string]>('SELECT holds, held_since, fired FROM automation_trigger WHERE automation_id = ? AND trigger = ?')
      .get(id, trigger);
    return row ? { last: row.holds === 1, heldSince: row.held_since, fired: row.fired === 1 } : null;
  }

  keepTrigger(id: string, trigger: string, state: TriggerState): void {
    this.#db
      .query('INSERT INTO automation_trigger (automation_id, trigger, holds, held_since, fired) VALUES (?, ?, ?, ?, ?) ON CONFLICT (automation_id, trigger) DO UPDATE SET holds = excluded.holds, held_since = excluded.held_since, fired = excluded.fired')
      .run(id, trigger, state.last ? 1 : 0, state.last ? state.heldSince : null, state.last && state.fired ? 1 : 0);
  }

  triggerStarted(id: string, trigger: string): string | null {
    return this.#db.query<{ started_at: string }, [string, string]>('SELECT started_at FROM automation_trigger_start WHERE automation_id = ? AND trigger = ?').get(id, trigger)?.started_at ?? null;
  }

  keepTriggerStarted(id: string, trigger: string, at: string): void {
    this.#db.query('INSERT INTO automation_trigger_start (automation_id, trigger, started_at) VALUES (?, ?, ?) ON CONFLICT (automation_id, trigger) DO UPDATE SET started_at = excluded.started_at').run(id, trigger, at);
  }

  seen(id: string, trigger: string): Seen | null {
    const row = this.#db.query<{ value: string; unit: string | null }, [string, string]>('SELECT value, unit FROM automation_trigger_seen WHERE automation_id = ? AND trigger = ?').get(id, trigger);
    return row ? { value: JSON.parse(row.value) as Value, unit: row.unit } : null;
  }

  keepSeen(id: string, trigger: string, seen: Seen): void {
    this.#db
      .query('INSERT INTO automation_trigger_seen (automation_id, trigger, value, unit) VALUES (?, ?, ?, ?) ON CONFLICT (automation_id, trigger) DO UPDATE SET value = excluded.value, unit = excluded.unit')
      .run(id, trigger, JSON.stringify(seen.value), seen.unit);
  }

  /** It starts afresh: what its triggers saw, and when each last started it, is forgotten, and it last looked now. */
  startAfresh(id: string, at: string): void {
    this.#db.transaction(() => {
      this.#db.query('DELETE FROM automation_trigger WHERE automation_id = ?').run(id);
      this.#db.query('DELETE FROM automation_trigger_seen WHERE automation_id = ?').run(id);
      this.#db.query('DELETE FROM automation_trigger_start WHERE automation_id = ?').run(id);
      this.#db.query('UPDATE automation SET looked_at = ? WHERE id = ?').run(at, id);
    })();
  }

  /** It looked again, to keep things so. */
  looked(id: string, at: string): void {
    this.#db.query('UPDATE automation SET looked_at = ? WHERE id = ?').run(at, id);
  }

  // --- what it remembers ------------------------------------------------------------------

  memory(id: string): Record<string, Value> {
    const rows = this.#db.query<{ name: string; value: string }, [string]>('SELECT name, value FROM automation_memory WHERE automation_id = ?').all(id);
    return Object.fromEntries(rows.map((row) => [row.name, JSON.parse(row.value) as Value]));
  }

  remember(id: string, name: string, value: Value): void {
    this.#db
      .query('INSERT INTO automation_memory (automation_id, name, value) VALUES (?, ?, ?) ON CONFLICT (automation_id, name) DO UPDATE SET value = excluded.value')
      .run(id, name, JSON.stringify(value));
  }

  // --- runs ---------------------------------------------------------------------------

  /** A run that takes steps, begun: its row, written again at every step. Throws if one of the automation's already runs. */
  beginRun(automationId: string, run: AutomationRun): string {
    const id = newId('r');
    this.#db
      .query(
        'INSERT INTO automation_run (id, automation_id, started_at, ended_at, outcome, started_by_kind, started_by_id, started_by_name, started_by_run, why, summary, detail) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, automationId, run.at, 'running', ...startedBy(run), run.startedByRun?.id ?? null, run.why, run.summary, detailOf(run));
    return id;
  }

  /** Where a run has got to. */
  stepRun(runId: string, run: AutomationRun): void {
    this.#db.query('UPDATE automation_run SET summary = ?, detail = ? WHERE id = ? AND ended_at IS NULL').run(run.summary, detailOf(run), runId);
  }

  /** A run ended, as it came out. */
  endRun(runId: string, run: AutomationRun): void {
    this.#db
      .query('UPDATE automation_run SET ended_at = ?, outcome = ?, summary = ?, detail = ? WHERE id = ?')
      .run(run.endedAt ?? new Date().toISOString(), run.outcome, run.summary, detailOf(run), runId);
  }

  /**
   * A run that was over as it began — commands alone, or nothing to do — kept
   * at once. Null when its automation was deleted while it ran: its runs went
   * with it, and so does this one.
   */
  ran(automationId: string, run: AutomationRun): string | null {
    const id = newId('r');
    const kept = this.#db
      .query(
        'INSERT INTO automation_run (id, automation_id, started_at, ended_at, outcome, started_by_kind, started_by_id, started_by_name, started_by_run, why, summary, detail) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM automation WHERE id = ?'
      )
      .run(id, run.at, run.endedAt ?? run.at, run.outcome, ...startedBy(run), run.startedByRun?.id ?? null, run.why, run.summary, detailOf(run), automationId);
    return kept.changes > 0 ? id : null;
  }

  /** One run, as it stands — what a step that waits on another automation's run looks at. */
  run(runId: string): AutomationRun | null {
    const row = this.#db.query<RunRow, [string]>(`${RUN_SELECT} WHERE r.id = ?`).get(runId);
    return row ? runOf(row) : null;
  }

  /** Runs that never ended: interrupted, when found as the server starts. */
  unended(): { automationId: string; run: AutomationRun }[] {
    return this.#db
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
    const handle = this.#db;
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
    const handle = this.#db;
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
  runs(automationId: string, limit = 50): AutomationRun[] {
    return this.#db.query<RunRow, [string, number]>(`${RUN_SELECT} WHERE r.automation_id = ? ORDER BY r.started_at DESC LIMIT ?`).all(automationId, limit).map(runOf);
  }
}
