import {
  openChannel,
  validateConfig,
  type Channel,
  type ConnectionHealth,
  type DeviceContext,
  type DeviceSession,
  type DeviceType,
  type OpenConnection,
  type SavedDeviceId,
} from '@kraftverk/device-sdk';

import { audit } from '../history/db.ts';
import type { ProtocolRegistry } from '../runtime/protocols.ts';
import { withTimeout } from '../runtime/timeout.ts';
import type { TransportHost } from '../runtime/transports.ts';
import type { DeviceRecord } from './catalog.ts';
import type { ConnectionRecord, ConnectionStore } from './connections.ts';
import { deviceStore } from './store.ts';
import type { DeviceTypeRegistry } from './types.ts';

/**
 * One open session for every device the server holds, whatever its type
 * (docs/ARCHITECTURE.md §4.7).
 *
 * The catalog says what you own; the registry says what each thing is; its
 * connections say how it is reached. This opens it: the connection in use is
 * the preferred one the server holds and can reach (docs/DATA-MODEL.md §4) —
 * its transport's channel, with what the protocol's binding asks for — and the
 * type's session is opened over it. Without hardware, the type's simulator
 * instead. It knows no product, no protocol and no transport.
 *
 * A device whose session cannot be opened is still a device you own. It gets
 * no session and a reason, which is what its card then says.
 */

const OPEN_TIMEOUT_MS = 10_000;
/** A connection down this long falls back to the device's next one, when it has one. */
const FAILOVER_MS = 2 * 60_000;
const WATCH_MS = 15_000;

export type DeviceSessionManagerDeps = {
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  transports: TransportHost;
  connections: ConnectionStore;
  /** Every device is simulated; no hardware is reached. */
  simulate: boolean;
  /** Every hardware write is refused. Sessions are told, and must honour it. */
  readOnly: boolean;
  /** Frames nobody has described may be sent, by a type's raw-frame tool. */
  allowRawFrames: boolean;
  /** Who a client is, for "held by Olof's iPhone". */
  clientName?: (clientId: string) => string | null;
  /** A device said who it is, and the catalog did not know yet. */
  onIdentified?: (deviceId: SavedDeviceId, identity: string) => void;
  log?: (message: string) => void;
};

type Refusal = { status: 'unconfigured' | 'offline' | 'error'; detail: string };

type Open = {
  session: DeviceSession;
  /** The connection in use; null for a simulator. */
  connection: ConnectionRecord | null;
  channel: Channel | null;
  /** What it was opened with, so a change reopens it. */
  fingerprint: string;
  /** When its channel went down, while it is down. */
  downSince: number | null;
  detach: () => void;
};

const fingerprintOf = (record: DeviceRecord, connection: ConnectionRecord | null) =>
  JSON.stringify([record.config, connection?.id, connection?.address, connection?.config]);

export class DeviceSessionManager {
  #open = new Map<SavedDeviceId, Open>();
  #refusals = new Map<SavedDeviceId, Refusal>();
  #timers = new Map<SavedDeviceId, ReturnType<typeof setInterval>[]>();
  /** Connections that failed over, and may not be chosen again for a while. */
  #avoid = new Map<string, number>();
  #records = new Map<SavedDeviceId, DeviceRecord>();
  #syncing: Promise<unknown> = Promise.resolve();
  #watch: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: DeviceSessionManagerDeps) {}

  /** What a device is, or null when no installed type claims it. */
  typeOf(record: Pick<DeviceRecord, 'typeId'>): DeviceType<any> | null {
    return this.deps.types.get(record.typeId);
  }

  get(deviceId: SavedDeviceId): DeviceSession | null {
    return this.#open.get(deviceId)?.session ?? null;
  }

  /** The connection a device is using right now. Null for a simulator or when none is open. */
  inUse(deviceId: SavedDeviceId): ConnectionRecord | null {
    return this.#open.get(deviceId)?.connection ?? null;
  }

  /** Whether the connection a device's session has open reaches it right now. */
  reachable(deviceId: SavedDeviceId): boolean {
    const open = this.#open.get(deviceId);
    return open?.connection != null && open.channel?.connected === true;
  }

  /** How a device is doing: its session's own answer, or why it has none. */
  health(record: DeviceRecord): ConnectionHealth {
    const open = this.#open.get(record.id);
    if (open) return open.session.health();
    const refusal = this.#refusals.get(record.id);
    return {
      status: refusal?.status ?? 'offline',
      detail: refusal?.detail ?? 'Not open yet',
      owner: 'server',
      transport: null,
      lastReadingAt: null,
    };
  }

  /**
   * Brings the open sessions in line with the catalog: opens what was added,
   * closes what was removed, and reopens a device whose config or connection
   * changed. One at a time, so two syncs never each decide the other's work is
   * still to do.
   */
  sync(records: DeviceRecord[]): Promise<void> {
    const run = this.#syncing.then(() => this.#sync(records));
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  async #sync(records: DeviceRecord[]): Promise<void> {
    this.#records = new Map(records.map((record) => [record.id, record]));
    const wanted = new Map<SavedDeviceId, { record: DeviceRecord; connection: ConnectionRecord | null }>();

    for (const record of records) {
      if (record.removedAt) continue;
      const type = this.typeOf(record);
      if (!type) {
        this.#refusals.set(record.id, { status: 'unconfigured', detail: `Nothing installed on this server knows what "${record.typeId}" is` });
        continue;
      }
      if (this.deps.simulate) {
        wanted.set(record.id, { record, connection: null });
        continue;
      }
      const chosen = await this.#choose(record, type);
      if ('refusal' in chosen) {
        this.#refusals.set(record.id, chosen.refusal);
        continue;
      }
      wanted.set(record.id, { record, connection: chosen.connection });
    }

    for (const [id, open] of [...this.#open]) {
      const next = wanted.get(id);
      if (!next || open.fingerprint !== fingerprintOf(next.record, next.connection)) await this.close(id);
    }
    for (const id of [...this.#refusals.keys()]) {
      if (!records.some((record) => record.id === id && !record.removedAt)) this.#refusals.delete(id);
    }

    // Each isolated: one device that will not open must not keep the others shut.
    await Promise.all(
      [...wanted.values()].filter(({ record }) => !this.#open.has(record.id)).map(({ record, connection }) => this.#openDevice(record, connection))
    );

    this.#watch ??= setInterval(() => void this.check(), WATCH_MS);
    this.#watch.unref?.();
  }

  /**
   * The connection to use: the preferred one the server holds whose transport
   * is available here. A device held only by a phone has no server session —
   * its card says who holds it.
   */
  async #choose(record: DeviceRecord, type: DeviceType<any>): Promise<{ connection: ConnectionRecord } | { refusal: Refusal }> {
    const all = this.deps.connections.forDevice(record.id);
    if (!all.length) return { refusal: { status: 'unconfigured', detail: 'Nothing can reach this device yet: add a way to reach it' } };

    const reasons: string[] = [];
    const serverHeld = all.filter((connection) => connection.heldBy === null);
    const now = Date.now();
    for (const connection of serverHeld) {
      if ((this.#avoid.get(connection.id) ?? 0) > now && serverHeld.length > 1) continue;
      const method = type.connections.find((candidate) => candidate.id === connection.method);
      if (!method) {
        reasons.push(`${record.typeId} no longer has a way called "${connection.method}"`);
        continue;
      }
      await this.deps.transports.start(connection.transport);
      const available = this.deps.transports.available(connection.transport);
      if (!available.ok) {
        reasons.push(available.reason);
        continue;
      }
      return { connection };
    }

    const held = all.find((connection) => connection.heldBy !== null);
    if (!serverHeld.length && held) {
      const who = this.deps.clientName?.(held.heldBy!) ?? 'another app';
      return { refusal: { status: 'offline', detail: `Held by ${who}, not by this server` } };
    }
    return { refusal: { status: 'error', detail: reasons[0] ?? 'None of its connections can be used here' } };
  }

  async #openDevice(record: DeviceRecord, connection: ConnectionRecord | null): Promise<void> {
    const type = this.typeOf(record)!;
    this.#refusals.delete(record.id);

    /*
      Only the fields the type knows. Writes are held to the schema strictly;
      but a device saved by an older version may carry a key its type has since
      dropped, and that must not stop a working device from opening.
    */
    const known = Object.fromEntries(Object.entries(record.config).filter(([field]) => field in type.config.fields));
    const config = validateConfig(type.config, known);
    if (!config.ok) {
      this.#refusals.set(record.id, { status: 'unconfigured', detail: `Needs setting up: ${config.issues.map((issue) => issue.message).join('; ')}` });
      return;
    }

    let channel: Channel | null = null;
    let open: OpenConnection | null = null;
    try {
      if (connection) {
        const method = type.connections.find((candidate) => candidate.id === connection.method)!;
        channel = await openChannel(this.deps.transports, this.deps.protocols.get(method.protocol), connection);
        open = {
          method: connection.method,
          protocol: method.protocol,
          transport: connection.transport,
          address: connection.address,
          channel,
          config: connection.config as OpenConnection['config'],
          secrets: { get: (field) => this.deps.connections.secret(connection.id, field) },
          platform: 'server',
        };
      }

      const context = this.#contextFor(record, config.value, open);
      const session = await withTimeout(
        connection ? type.createSession(context) : type.createSimulator(context),
        `Opening ${record.name}`,
        OPEN_TIMEOUT_MS
      );

      const entry: Open = { session, connection, channel, fingerprint: fingerprintOf(record, connection), downSince: null, detach: () => {} };
      if (channel && connection) {
        const noteState = (connected: boolean) => {
          entry.downSince = connected ? null : (entry.downSince ?? Date.now());
          if (connected) this.deps.connections.touch(connection.id);
        };
        entry.detach = channel.onConnectedChange(noteState);
        noteState(channel.connected);
      }
      this.#open.set(record.id, entry);
    } catch (error) {
      this.#clearTimers(record.id);
      await channel?.close().catch(() => undefined);
      const detail = (error as Error).message;
      this.#refusals.set(record.id, { status: 'error', detail });
      this.deps.log?.(`${record.name} could not be opened: ${detail}`);
    }
  }

  /**
   * Every little while: learns identities devices have said, refuses a
   * connection that reaches the wrong device, and falls back from one that has
   * been down too long. Run by a timer; a test runs it directly.
   */
  async check(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [id, open] of [...this.#open]) {
      const record = this.#records.get(id);
      if (!record || !open.connection) continue;

      const said = open.session.identity?.().id ?? null;
      if (said && record.identity && said.toLowerCase() !== record.identity.toLowerCase()) {
        // The address now leads somewhere else: nothing it says is this device's.
        await this.close(id);
        this.#refusals.set(id, { status: 'error', detail: `That connection reaches a different device (${said}), not the one you added` });
        audit({ at: new Date().toISOString(), kind: 'device.mismatch', actor: 'server', resource: id, summary: `${record.name}'s connection reaches ${said} instead`, detail: { expected: record.identity } });
        continue;
      }
      if (said && !record.identity) {
        this.deps.onIdentified?.(id, said);
        this.#records.set(id, { ...record, identity: said });
      }

      const others = this.deps.connections.forDevice(id).filter((connection) => connection.heldBy === null && connection.id !== open.connection!.id);
      if (open.downSince !== null && now - open.downSince > FAILOVER_MS && others.length) {
        this.deps.log?.(`${record.name}: ${open.connection.method} has been down for ${Math.round((now - open.downSince) / 1000)} s; trying its next connection`);
        this.#avoid.set(open.connection.id, now + FAILOVER_MS);
        await this.close(id);
        changed = true;
      }
    }
    if (changed) await this.sync([...this.#records.values()]);
  }

  #contextFor(record: DeviceRecord, config: DeviceContext['config'], connection: OpenConnection | null): DeviceContext {
    const log = (level: 'log' | 'warn' | 'error') => (message: string, extra?: unknown) =>
      console[level](`[${record.name}] ${message}`, extra ?? '');

    return {
      deviceId: record.id,
      config,
      connection,
      store: deviceStore(record.id),
      log: { info: log('log'), warn: log('warn'), error: log('error') },
      readOnly: this.deps.readOnly,
      allowRawFrames: this.deps.allowRawFrames,
      platform: 'server',
      schedule: (everyMs, task) => {
        let running = false;
        const timer = setInterval(() => {
          // Skipped, not queued: a device that stops answering must not build
          // a backlog of polls that all fire when it comes back.
          if (running) return;
          running = true;
          void Promise.resolve()
            .then(task)
            .catch((error: unknown) => console.warn(`[${record.name}] scheduled work failed:`, (error as Error).message))
            .finally(() => {
              running = false;
            });
        }, everyMs);
        this.#timers.set(record.id, [...(this.#timers.get(record.id) ?? []), timer]);
      },
      emit: (event) =>
        audit({
          at: new Date().toISOString(),
          kind: `device.${event.level}`,
          actor: record.name,
          resource: record.id,
          summary: event.message,
          detail: event.data,
        }),
    };
  }

  async close(deviceId: SavedDeviceId): Promise<void> {
    const open = this.#open.get(deviceId);
    this.#open.delete(deviceId);
    this.#clearTimers(deviceId);
    if (!open) return;
    open.detach();
    await withTimeout(open.session.close(), 'Closing a device', 5_000).catch(() => undefined);
    // The channel is this manager's: it opened it, so it closes it.
    await open.channel?.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    await Promise.all([...this.#open.keys()].map((id) => this.close(id)));
  }

  #clearTimers(deviceId: SavedDeviceId): void {
    for (const timer of this.#timers.get(deviceId) ?? []) clearInterval(timer);
    this.#timers.delete(deviceId);
  }
}
