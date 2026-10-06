
import { nodeId, connectionId, savedDeviceId, type NodeId, type ConnectionId, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';
import { newId } from '@kraftverk/device-sdk';
import type { SecretsAtRest } from './secrets.ts';

/**
 * How each device is reached (docs/DATA-MODEL.md §3): one row per way, from
 * one place. The station over Wi-Fi from the master and over Bluetooth from
 * a node that follows it — your phone — is one device with two connections.
 *
 * A connection names its device type's method, the transport it rides, which
 * node holds it — the master, or one that follows it — or the bridge it goes
 * through, and the address that transport, or that bridge, knows the device
 * by. Its secrets live beside it, sealed; the ones of a connection held by a
 * node that follows never reach the master at all.
 */

/** Who has a connection in hand: a node of the home, or — for a member of a bridge — the bridge device, wherever that is held. */
export type ConnectionHolding = { heldBy: NodeId; through: null } | { heldBy: null; through: SavedDeviceId };

export type ConnectionRecord = ConnectionHolding & {
  id: ConnectionId;
  deviceId: SavedDeviceId;
  /** One of the device type's connection methods: `wifi`. */
  method: string;
  /** The method's transport, copied here for the address rule: `mqtt`; `bridge` through a bridge. */
  transport: string;
  /** What the transport knows the device by: a MAC, an IP, a browser's handle; a member's key within its bridge. */
  address: string;
  /** 0 is preferred; higher numbers are fallbacks. */
  priority: number;
  /** The method's own choices, and the protocol's non-secret credentials. */
  config: Record<string, unknown>;
  /** Whether its secrets may leave in an export as plain text: its owner's choice, off unless chosen (docs/CONFIG.md). */
  secretsExportable: boolean;
  createdAt: string;
  lastConnectedAt: string | null;
};

type Row = {
  id: string;
  device_id: string;
  method: string;
  transport: string;
  held_by: string | null;
  through: string | null;
  address: string;
  priority: number;
  config: string;
  secrets_exportable: number;
  created_at: string;
  last_connected_at: string | null;
};

/** Held by a node, or through a bridge: the schema holds a row to exactly one. */
const holdingOf = (row: Pick<Row, 'held_by' | 'through'>): ConnectionHolding =>
  row.through !== null ? { heldBy: null, through: savedDeviceId(row.through) } : { heldBy: nodeId(row.held_by!), through: null };

const toRecord = (row: Row): ConnectionRecord => ({
  id: connectionId(row.id),
  deviceId: savedDeviceId(row.device_id),
  method: row.method,
  transport: row.transport,
  ...holdingOf(row),
  address: row.address,
  priority: row.priority,
  config: JSON.parse(row.config) as Record<string, unknown>,
  secretsExportable: row.secrets_exportable === 1,
  createdAt: row.created_at,
  lastConnectedAt: row.last_connected_at,
});

export class ConnectionStore {
  readonly #db: SqlDatabase;
  readonly #secrets: SecretsAtRest;

  constructor(db: SqlDatabase, secrets: SecretsAtRest) {
    this.#db = db;
    this.#secrets = secrets;
  }

  /** A device's connections, preferred first. */
  forDevice(deviceId: SavedDeviceId): ConnectionRecord[] {
    return this.#db
      .query<Row, [string]>('SELECT * FROM device_connection WHERE device_id = ? ORDER BY priority, created_at')
      .all(deviceId)
      .map(toRecord);
  }

  /** Every connection, grouped by device, each group preferred first: one query for a whole list. */
  byDevice(): Map<SavedDeviceId, ConnectionRecord[]> {
    const grouped = new Map<SavedDeviceId, ConnectionRecord[]>();
    for (const row of this.#db.query<Row, []>('SELECT * FROM device_connection ORDER BY priority, created_at').all()) {
      const record = toRecord(row);
      grouped.set(record.deviceId, [...(grouped.get(record.deviceId) ?? []), record]);
    }
    return grouped;
  }

  get(id: string): ConnectionRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM device_connection WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  /** The connections that go through a bridge device: its members' ways to it. */
  through(bridgeId: SavedDeviceId): ConnectionRecord[] {
    return this.#db.query<Row, [string]>('SELECT * FROM device_connection WHERE through = ? ORDER BY created_at').all(bridgeId).map(toRecord);
  }

  add(
    input: {
      deviceId: SavedDeviceId;
      method: string;
      transport: string;
      address: string;
      config?: Record<string, unknown>;
      priority?: number;
      secretsExportable?: boolean;
    } & ({ heldBy: NodeId; through?: null } | { heldBy?: null; through: SavedDeviceId })
  ): ConnectionRecord {
    const existing = this.forDevice(input.deviceId);
    const holding: ConnectionHolding = input.through ? { heldBy: null, through: input.through } : { heldBy: input.heldBy!, through: null };
    const record: ConnectionRecord = {
      id: connectionId(newId('c')),
      deviceId: input.deviceId,
      method: input.method,
      transport: input.transport,
      ...holding,
      address: input.address,
      // A new way to reach a device comes after the ones it already has.
      priority: input.priority ?? (existing.length ? Math.max(...existing.map((c) => c.priority)) + 1 : 0),
      config: input.config ?? {},
      secretsExportable: input.secretsExportable ?? false,
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
    };
    this.#db
      .query(
        'INSERT INTO device_connection (id, device_id, method, transport, held_by, through, address, priority, config, secrets_exportable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(record.id, record.deviceId, record.method, record.transport, record.heldBy, record.through, record.address, record.priority, JSON.stringify(record.config), record.secretsExportable ? 1 : 0, record.createdAt);
    return record;
  }

  update(id: string, changes: { priority?: number; config?: Record<string, unknown>; address?: string; secretsExportable?: boolean }): ConnectionRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next = { ...existing, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
    this.#db
      .query('UPDATE device_connection SET priority = ?, config = ?, address = ?, secrets_exportable = ? WHERE id = ?')
      .run(next.priority, JSON.stringify(next.config), next.address, next.secretsExportable ? 1 : 0, id);
    return next;
  }

  /** Makes one connection the preferred way, keeping the others in order behind it. */
  prefer(id: string): void {
    const chosen = this.get(id);
    if (!chosen) return;
    const others = this.forDevice(chosen.deviceId).filter((connection) => connection.id !== id);
    this.#db.transaction(() => {
      this.#db.query('UPDATE device_connection SET priority = 0 WHERE id = ?').run(id);
      others.forEach((connection, index) => this.#db.query('UPDATE device_connection SET priority = ? WHERE id = ?').run(index + 1, connection.id));
    })();
  }

  remove(id: string): void {
    this.#db.query('DELETE FROM device_connection WHERE id = ?').run(id);
  }

  /**
   * Keeps a connection as the master's database has it, by its id: a node
   * that follows the home, holding a way to one of its devices
   * (docs/PLAN-SHARED-CORE.md, phase 6). Added, or its address, priority
   * and settings brought up to what they are there — what it is, and who
   * holds it, never change; its secrets, which only the node holding it has,
   * stay.
   */
  mirror(record: ConnectionHolding & Pick<ConnectionRecord, 'id' | 'deviceId' | 'method' | 'transport' | 'address' | 'priority' | 'config' | 'secretsExportable' | 'createdAt'>): void {
    this.#db
      .query(
        `INSERT INTO device_connection (id, device_id, method, transport, held_by, through, address, priority, config, secrets_exportable, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET address = excluded.address, priority = excluded.priority, config = excluded.config, secrets_exportable = excluded.secrets_exportable`
      )
      .run(record.id, record.deviceId, record.method, record.transport, record.heldBy, record.through, record.address, record.priority, JSON.stringify(record.config), record.secretsExportable ? 1 : 0, record.createdAt);
  }

  /** The device answered through this connection. */
  touch(id: string): void {
    this.#db.query('UPDATE device_connection SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * Which device already is this member of this bridge, if any: a member's key
   * is one thing behind one bridge, so two devices may not both claim it.
   */
  member(bridgeId: SavedDeviceId, key: string): { deviceId: SavedDeviceId; connectionId: string } | null {
    const row = this.#db
      .query<{ id: string; device_id: string }, [string, string]>(
        `SELECT c.id, c.device_id FROM device_connection c JOIN device d ON d.id = c.device_id
         WHERE c.through = ? AND c.address = ? AND d.removed_at IS NULL`
      )
      .get(bridgeId, key);
    return row ? { deviceId: row.device_id as SavedDeviceId, connectionId: row.id } : null;
  }

  /**
   * Which device this home's own node already reaches at this address on
   * this transport, if any. An exclusive transport's address is one physical thing, so
   * two devices may not both claim it (docs/DATA-MODEL.md §3).
   */
  claimant(transport: string, address: string): { deviceId: SavedDeviceId; connectionId: string } | null {
    const row = this.#db
      .query<{ id: string; device_id: string }, [string, string]>(
        `SELECT c.id, c.device_id FROM device_connection c JOIN device d ON d.id = c.device_id
         JOIN node n ON n.id = c.held_by AND n.self = 1
         WHERE c.transport = ? AND UPPER(c.address) = UPPER(?) AND d.removed_at IS NULL`
      )
      .get(transport, address);
    return row ? { deviceId: row.device_id as SavedDeviceId, connectionId: row.id } : null;
  }

  // --- secrets -------------------------------------------------------------------

  /** One secret, opened: null when there is none, or it cannot be opened with the key this node has. */
  secret(connectionId: string, field: string): string | null {
    const row = this.#db
      .query<{ value: string; encrypted: number }, [string, string]>('SELECT value, encrypted FROM connection_secret WHERE connection_id = ? AND field = ?')
      .get(connectionId, field);
    return row ? this.#secrets.open(row.value, row.encrypted === 1) : null;
  }

  /** Which secrets a connection has, by field — never their values; given by a person, or kept by its session, when asked which. */
  secretFields(connectionId: string, source?: 'person' | 'session'): string[] {
    return this.#db
      .query<{ field: string; source: string }, [string]>('SELECT field, source FROM connection_secret WHERE connection_id = ? ORDER BY field')
      .all(connectionId)
      .filter((row) => source === undefined || row.source === source)
      .map((row) => row.field);
  }

  /** Every secret a connection has, opened, by field: what a way carries to the home it moves to. One that cannot be opened is left out. */
  secrets(connectionId: string): Record<string, string> {
    return Object.fromEntries(
      this.secretFields(connectionId).flatMap((field) => {
        const value = this.secret(connectionId, field);
        return value === null ? [] : [[field, value] as const];
      })
    );
  }

  /** The names of every connection's secrets, by connection: one query for a whole list. */
  secretFieldsByConnection(): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const row of this.#db.query<{ connection_id: string; field: string }, []>('SELECT connection_id, field FROM connection_secret ORDER BY field').all()) {
      grouped.set(row.connection_id, [...(grouped.get(row.connection_id) ?? []), row.field]);
    }
    return grouped;
  }

  /** Secrets, sealed, by field: given by a person, or kept by the connection's session. */
  setSecrets(connectionId: string, values: Record<string, string>, source: 'person' | 'session' = 'person'): void {
    const upsert = this.#db.query(
      'INSERT INTO connection_secret (connection_id, field, value, encrypted, source, written_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (connection_id, field) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, source = excluded.source, written_at = excluded.written_at'
    );
    const at = new Date().toISOString();
    this.#db.transaction(() => {
      for (const [field, value] of Object.entries(values)) {
        const sealed = this.#secrets.seal(value);
        upsert.run(connectionId, field, sealed.value, sealed.encrypted ? 1 : 0, source, at);
      }
    })();
  }

  /** Forgets one secret: what a session does with a token that no longer signs in. */
  forgetSecret(connectionId: string, field: string): void {
    this.#db.query('DELETE FROM connection_secret WHERE connection_id = ? AND field = ?').run(connectionId, field);
  }
}
