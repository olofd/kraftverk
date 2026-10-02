import type { DeviceChange } from '@kraftverk/api-contract';
import { partOf, type AttributeSpec, type DeviceDescription, type Reading, type SavedDeviceId, type Value } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';

import type { SqlDatabase } from '@kraftverk/store';

import { sampleOf } from './sampler.ts';

/**
 * Every change of an on/off or an enum, when the device observed it
 * (docs/DATA-MODEL.md, `sample_change`).
 *
 * Minute samples and hourly means suit a number. For an on/off they are a duty
 * cycle nobody asked for, and a switch flicked for thirty seconds between two
 * samples is not there at all. What a timeline wants — "AC outlets off
 * 14:02–14:19" — is the moment each changed, which is one row per change:
 * small, exact, and kept two years.
 *
 * A reading that says what the last row already says is no change and writes
 * nothing. One that arrives late — an app that was offline sends what it
 * queued — lands in its place in time, and the row after it goes if it no
 * longer changes anything.
 */

/** Two years, as the hourly roll-ups; the latest row of each is kept past that, as what it has been since. */
const RETAIN_DAYS = 730;

/** Which of a device's attributes the log keeps, by key: on/off and enums, whose history is their changes. */
export const loggedAttributes = (description: DeviceDescription): Map<string, AttributeSpec> =>
  new Map(description.attributes.filter((attribute) => attribute.value.type === 'boolean' || attribute.value.type === 'enum').map((attribute) => [attribute.key, attribute]));

type Row = { at: string; value: number | null; text: string | null };

const same = (row: Row | null | undefined, sample: { value: number | null; text: string | null }) => row != null && row.value === sample.value && row.text === sample.text;

/** Records what changed among these readings. Returns how many changes were written. */
export function recordChanges(db: SqlDatabase, deviceId: SavedDeviceId, logged: ReadonlyMap<string, AttributeSpec>, readings: readonly Reading[]): number {
  if (!logged.size) return 0;
  const before = db.query<Row, [string, string, string]>('SELECT at, value, text FROM sample_change WHERE device_id = ? AND key = ? AND at <= ? ORDER BY at DESC LIMIT 1');
  const after = db.query<Row, [string, string, string]>('SELECT at, value, text FROM sample_change WHERE device_id = ? AND key = ? AND at > ? ORDER BY at ASC LIMIT 1');
  const insert = db.query('INSERT OR REPLACE INTO sample_change (device_id, part, key, at, value, text) VALUES (?, ?, ?, ?, ?, ?)');
  const drop = db.query('DELETE FROM sample_change WHERE device_id = ? AND key = ? AND at = ?');
  const exists = db.query('SELECT 1 FROM device WHERE id = ?');
  let written = 0;

  db.transaction(() => {
    if (!exists.get(deviceId)) return;
    for (const reading of readings) {
      const attribute = logged.get(reading.key);
      const sample = attribute ? sampleOf(reading.value) : null;
      const taken = reading.at ? Date.parse(reading.at) : Number.NaN;
      // A time to come is a clock that is wrong, not a change.
      if (!attribute || !sample || !Number.isFinite(taken) || taken > Date.now() + 60_000) continue;
      const at = new Date(taken).toISOString();
      if (same(before.get(deviceId, reading.key, at), sample)) continue;
      insert.run(deviceId, partOf(attribute), reading.key, at, sample.value, sample.text);
      written += 1;
      // Late: what came after it may now say what it says, and is no change any more.
      const next = after.get(deviceId, reading.key, at);
      if (same(next, sample)) drop.run(deviceId, reading.key, next!.at);
    }
  })();
  return written;
}

const valueOf = (row: Row, attribute: AttributeSpec | undefined): Value =>
  row.text !== null ? row.text : row.value === null ? null : attribute?.value.type === 'boolean' ? row.value !== 0 : row.value;

/**
 * The changes between two times, oldest first — with, for each key, the one
 * before `from`, so the span starts knowing what each was.
 */
export function changesOf(db: SqlDatabase, deviceId: SavedDeviceId, description: DeviceDescription, options: { from: string; to: string; key?: string }): DeviceChange[] {
  const attributes = new Map(description.attributes.map((attribute) => [attribute.key, attribute]));
  const keyed = options.key ? ' AND key = ?' : '';
  const keyArgs = options.key ? [options.key] : [];
  const rows = db
    .query<Row & { key: string; part: string }, string[]>(
      `SELECT key, part, at, value, text FROM sample_change WHERE device_id = ?${keyed} AND at > ? AND at <= ?
       UNION ALL
       SELECT key, part, MAX(at) AS at, value, text FROM sample_change WHERE device_id = ?${keyed} AND at <= ? GROUP BY key
       ORDER BY at ASC, key ASC`
    )
    .all(deviceId, ...keyArgs, options.from, options.to, deviceId, ...keyArgs, options.from);
  return rows.map((row) => ({ key: row.key, part: row.part, at: row.at, value: valueOf(row, attributes.get(row.key)) }));
}

/** Changes older than two years go, except each key's latest: what it has been since. */
export function pruneChanges(db: SqlDatabase, now = Date.now()): void {
  const before = new Date(now - RETAIN_DAYS * 86_400_000).toISOString();
  db
    .query(
      `DELETE FROM sample_change WHERE at < ? AND at < (
         SELECT MAX(latest.at) FROM sample_change latest WHERE latest.device_id = sample_change.device_id AND latest.key = sample_change.key
       )`
    )
    .run(before);
}

/**
 * Records what the home's own sessions report, as the live bus carries it:
 * only readings whose value moved, the moment a pushing device says so. What
 * an app holds for it arrives by its uplink instead (`HeldReadings`).
 */
export class ChangeLog {
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly bus: LiveBus,
    private readonly describe: (deviceId: SavedDeviceId) => DeviceDescription | null
  ) {}

  start(): void {
    this.#unsubscribe ??= this.bus.subscribe((message) => {
      if (message.kind !== 'readings') return;
      const description = this.describe(message.deviceId);
      if (description) recordChanges(this.db, message.deviceId, loggedAttributes(description), message.readings);
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
