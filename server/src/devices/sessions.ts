import { isSimulated, methodOf, type ConnectionHealth, type DeviceDescription, type DeviceInfo, type DeviceSession, type DeviceType, type SavedDeviceId } from '@kraftverk/device-sdk';
import { Failover, identityVerdict, openDevice, OpenRefused, type DeviceEventMessage, type LiveBus, type OpenedDevice } from '@kraftverk/holder';

import { audit } from '../history/db.ts';
import type { ProtocolRegistry } from '../runtime/protocols.ts';
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
 * type's session is opened over it. A simulated connection opens the type's
 * simulator instead, and reaches nothing. It knows no product, no protocol and
 * no transport.
 *
 * A device whose session cannot be opened is still a device you own. It gets
 * no session and a reason, which is what its card then says.
 *
 * Opening, the wrong-device check and failover are `@kraftverk/holder`'s, the
 * same code the app runs for the connections it holds; what is the server's
 * here is which connection to choose, the catalog, and where things are kept.
 */

const WATCH_MS = 15_000;

export type DeviceSessionManagerDeps = {
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  transports: TransportHost;
  connections: ConnectionStore;
  /** Every hardware write is refused. Sessions are told, and must honour it; a simulator reaches no hardware. */
  readOnly: boolean;
  /** Frames nobody has described may be sent, by a type's raw-frame tool. */
  allowRawFrames: boolean;
  /** Who a client is, for "held by Olof's iPhone". */
  clientName?: (clientId: string) => string | null;
  /** A device said who it is, and the catalog did not know yet. */
  onIdentified?: (deviceId: SavedDeviceId, identity: string) => void;
  /** What a device is and says about itself, to keep: returns whether its description changed. */
  onDescribed?: (deviceId: SavedDeviceId, description: DeviceDescription, info: DeviceInfo | null) => boolean;
  /** An event a device raised, checked against its description. */
  onEvent?: (deviceId: SavedDeviceId, event: DeviceEventMessage) => void;
  /** Where what devices say, as they say it, is published. */
  bus?: LiveBus;
  log?: (message: string) => void;
};

type Refusal = { status: 'unconfigured' | 'offline' | 'error'; detail: string };

type Open = {
  opened: OpenedDevice;
  /** The connection in use: a simulated one opens the type's simulator. */
  connection: ConnectionRecord;
  /** What it was opened with, so a change reopens it. */
  fingerprint: string;
  detach: () => void;
};

const fingerprintOf = (record: DeviceRecord, connection: ConnectionRecord) =>
  JSON.stringify([record.config, connection.id, connection.address, connection.config]);

export class DeviceSessionManager {
  #open = new Map<SavedDeviceId, Open>();
  #refusals = new Map<SavedDeviceId, Refusal>();
  /** When each connection went down, and which have failed over and are passed over for a while. */
  #failover = new Failover();
  #records = new Map<SavedDeviceId, DeviceRecord>();
  #syncing: Promise<unknown> = Promise.resolve();
  #watch: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: DeviceSessionManagerDeps) {}

  /** What a device is, or null when no installed type claims it. */
  typeOf(record: Pick<DeviceRecord, 'typeId'>): DeviceType<any> | null {
    return this.deps.types.get(record.typeId);
  }

  get(deviceId: SavedDeviceId): DeviceSession | null {
    return this.#open.get(deviceId)?.opened.session ?? null;
  }

  /** What a device is now: its open session's word, or what was last kept. */
  description(record: Pick<DeviceRecord, 'id' | 'description'>): DeviceDescription {
    return this.#open.get(record.id)?.opened.description() ?? record.description;
  }

  /** What a device has said about itself: its open session's word, or what was last kept. */
  info(record: Pick<DeviceRecord, 'id' | 'info'>): DeviceInfo | null {
    return this.#open.get(record.id)?.opened.info() ?? record.info;
  }

  /** Keeps what an open device is and has said; tells listeners when it changed. */
  #describe(deviceId: SavedDeviceId): void {
    const open = this.#open.get(deviceId);
    if (!open) return;
    const changed = this.deps.onDescribed?.(deviceId, open.opened.description(), open.opened.info()) ?? false;
    if (changed) this.deps.bus?.publish({ kind: 'described', deviceId });
  }

  /** The connection a device is using right now. Null when none is open. */
  inUse(deviceId: SavedDeviceId): ConnectionRecord | null {
    return this.#open.get(deviceId)?.connection ?? null;
  }

  /** Whether a device is open as its type's simulator: nothing it does reaches hardware. */
  simulated(deviceId: SavedDeviceId): boolean {
    const open = this.#open.get(deviceId);
    return open !== undefined && isSimulated(open.connection);
  }

  /** Whether the connection a device's session has open reaches it right now. */
  reachable(deviceId: SavedDeviceId): boolean {
    const open = this.#open.get(deviceId);
    if (!open) return false;
    return isSimulated(open.connection) || open.opened.channel?.connected === true;
  }

  /** How a device is doing: its session's own answer, or why it has none. */
  health(record: DeviceRecord): ConnectionHealth {
    const open = this.#open.get(record.id);
    if (open) return open.opened.session.health();
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
    const wanted = new Map<SavedDeviceId, { record: DeviceRecord; connection: ConnectionRecord }>();

    for (const record of records) {
      if (record.removedAt) continue;
      const type = this.typeOf(record);
      if (!type) {
        this.#refusals.set(record.id, { status: 'unconfigured', detail: `Nothing installed on this server knows what "${record.typeId}" is` });
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
   * is available here — a simulated one always is. A device held only by a
   * phone has no server session — its card says who holds it.
   */
  async #choose(record: DeviceRecord, type: DeviceType<any>): Promise<{ connection: ConnectionRecord } | { refusal: Refusal }> {
    const all = this.deps.connections.forDevice(record.id);
    if (!all.length) return { refusal: { status: 'unconfigured', detail: 'Nothing can reach this device yet: add a way to reach it' } };

    const reasons: string[] = [];
    const serverHeld = all.filter((connection) => connection.heldBy === null);
    for (const connection of serverHeld) {
      if (this.#failover.avoided(connection.id) && serverHeld.length > 1) continue;
      const method = methodOf(type, connection.method);
      if (!method) {
        reasons.push(`${record.typeId} no longer has a way called "${connection.method}"`);
        continue;
      }
      if (isSimulated(connection)) return { connection };
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

  async #openDevice(record: DeviceRecord, connection: ConnectionRecord): Promise<void> {
    const type = this.typeOf(record)!;
    const simulated = isSimulated(connection);
    this.#refusals.delete(record.id);
    const log = (level: 'log' | 'warn' | 'error') => (message: string, extra?: unknown) => console[level](`[${record.name}] ${message}`, extra ?? '');

    try {
      const opened = await openDevice({
        type,
        device: record,
        // Simulated: no connection to open, and its type's simulator in its place.
        connection: simulated ? null : connection,
        secret: (field) => this.deps.connections.secret(connection.id, field),
        protocols: this.deps.protocols,
        transports: this.deps.transports,
        store: deviceStore(record.id),
        platform: 'server',
        readOnly: this.deps.readOnly && !simulated,
        allowRawFrames: this.deps.allowRawFrames,
        log: { info: log('log'), warn: log('warn'), error: log('error') },
        changed: () => {
          this.#describe(record.id);
          const session = this.#open.get(record.id)?.opened.session;
          if (session) this.deps.bus?.publish({ kind: 'readings', deviceId: record.id, readings: session.readings() });
        },
        event: (event) => {
          this.deps.onEvent?.(record.id, event);
          this.deps.bus?.publish({ kind: 'event', deviceId: record.id, event });
        },
      });

      const entry: Open = { opened, connection, fingerprint: fingerprintOf(record, connection), detach: () => {} };
      if (opened.channel) {
        const noteState = (connected: boolean) => {
          this.#failover.note(connection.id, connected);
          if (connected) this.deps.connections.touch(connection.id);
        };
        entry.detach = opened.channel.onConnectedChange(noteState);
        noteState(opened.channel.connected);
      }
      this.#open.set(record.id, entry);
      this.#describe(record.id);
    } catch (error) {
      const refused = error instanceof OpenRefused ? error : new OpenRefused((error as Error).message, 'error');
      this.#refusals.set(record.id, { status: refused.status, detail: refused.message });
      this.deps.log?.(`${record.name} could not be opened: ${refused.message}`);
    }
  }

  /**
   * Every little while: learns identities devices have said, refuses a
   * connection that reaches the wrong device, and falls back from one that has
   * been down too long. Run by a timer; a test runs it directly.
   */
  async check(): Promise<void> {
    let changed = false;
    for (const [id, open] of [...this.#open]) {
      const record = this.#records.get(id);
      // What it is can change while it is open: a pack plugged in, firmware read.
      this.#describe(id);
      if (!record || isSimulated(open.connection)) continue;

      const said = open.opened.session.identity?.().id ?? null;
      const verdict = identityVerdict(record.identity, said);
      if (verdict === 'mismatch') {
        // The address now leads somewhere else: nothing it says is this device's.
        await this.close(id);
        this.#refusals.set(id, { status: 'error', detail: `That connection reaches a different device (${said}), not the one you added` });
        audit({ at: new Date().toISOString(), kind: 'device.mismatch', actor: 'server', resource: id, summary: `${record.name}'s connection reaches ${said} instead`, detail: { expected: record.identity } });
        continue;
      }
      if (verdict === 'learnt') {
        this.deps.onIdentified?.(id, said!);
        this.#records.set(id, { ...record, identity: said });
      }

      const others = this.deps.connections.forDevice(id).filter((connection) => connection.heldBy === null && connection.id !== open.connection.id);
      const down = this.#failover.downFor(open.connection.id);
      if (this.#failover.due(open.connection.id, others.length > 0)) {
        this.deps.log?.(`${record.name}: ${open.connection.method} has been down for ${Math.round((down ?? 0) / 1000)} s; trying its next connection`);
        await this.close(id);
        changed = true;
      }
    }
    if (changed) await this.sync([...this.#records.values()]);
  }

  async close(deviceId: SavedDeviceId): Promise<void> {
    const open = this.#open.get(deviceId);
    this.#open.delete(deviceId);
    if (!open) return;
    open.detach();
    // The channel is this manager's: it opened it, so it closes it.
    await open.opened.close();
  }

  async closeAll(): Promise<void> {
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    await Promise.all([...this.#open.keys()].map((id) => this.close(id)));
  }
}
