import {
  attributeMeaning,
  isSimulated,
  methodOf,
  readingOf,
  type Availability,
  type AuditRecord,
  type ConnectionMethod,
  type ConnectionHealth,
  type DescriptionSource,
  type DeviceDescription,
  type DeviceInfo,
  type DeviceSession,
  type DeviceStore,
  type DeviceType,
  type NodeId,
  type Platform,
  type Protocol,
  type SavedDeviceId,
  type TransportSource,
  type Value,
} from '@kraftverk/device-sdk';

import { ReadingChanges, type DeviceEventMessage, type LiveBus } from './bus.ts';

import { openDevice, OpenRefused, type OpenedDevice } from './open.ts';
import { Failover, identityVerdict } from './watch.ts';

/**
 * One open session for every device a holder holds, whatever its type
 * (docs/ARCHITECTURE.md §4.7) — the server, or an app holding connections of
 * its own; the same code in each (docs/PLAN-SHARED-CORE.md).
 *
 * It is told what devices there are and how each is reached; which of those
 * ways are its own is the holder's to say (`holds`). It opens each device: the
 * connection in use is the preferred one it holds and can reach
 * (docs/DATA-MODEL.md §4) — its transport's channel, with what the protocol's
 * binding asks for — and the type's session is opened over it. A simulated
 * connection opens the type's simulator, and reaches nothing. It knows no
 * product, no protocol and no transport.
 *
 * A device whose session cannot be opened is still a device you have. It gets
 * no session and a reason, which is what its card then says; what can mend
 * itself — a transport not up yet, a device that did not answer — is tried
 * again. A connection that reaches a different device is refused, and one down
 * too long gives way to the next.
 */

/** How often every open session is looked at: verified, described again, and given way to its next connection when down too long. */
const WATCH_MS = 15_000;
/**
 * How often what devices say is checked for what changed, for whoever listens
 * on the bus. A session's readings come from its cache, so this asks nothing
 * of a device; one that pushes, or finishes a poll, is published at once.
 */
const PULSE_MS = 1000;
/** Health is published when it changes, and at least this often while readings keep arriving, so "last heard" stays true. */
const HEALTH_REFRESH_MS = 30_000;
/** How long before trying a refused device again, by how many times it has been tried: then every five minutes. */
const RETRY_MS = [30_000, 60_000, 120_000, 300_000];

/** A device as a holder is given it: what the catalog keeps of it. */
export type HolderDevice = {
  id: SavedDeviceId;
  name: string;
  typeId: string;
  config: Record<string, unknown>;
  /** Who the device is, when known: a connection that reaches another device is refused. */
  identity: string | null;
  removedAt: string | null;
  /** What it was last known to be, for when it is not open. */
  description: DeviceDescription;
  descriptionSource: DescriptionSource;
  info: DeviceInfo | null;
};

/** One way a device is reached. */
export type HolderConnection = {
  id: string;
  method: string;
  transport: string;
  address: string;
  config: Record<string, unknown>;
  /** The node that holds it. */
  heldBy: string;
};

export type SessionManagerDeps = {
  /** Where it runs: what a method's transport opens here. */
  platform: Platform;
  /** The node this is: what a device's health names as holding it, and the timeline as acting. */
  node: { id: NodeId; name: string };
  types: { get(typeId: string): DeviceType<any> | null | undefined };
  protocols: { get(id: string): Protocol | null | undefined };
  /** The transports here; one that is started on demand, and can say whether it is available, says so. */
  transports: TransportSource & { start?(id: string): Promise<unknown>; available?(id: string): Availability };
  /** A device's ways in, preferred first. */
  connections(deviceId: SavedDeviceId): readonly HolderConnection[];
  /** Whether a connection is this node's: the ways it holds (`held_by`). */
  holds(connection: HolderConnection): boolean;
  /**
   * Why this node cannot hold a way, from what the way needs of the node
   * holding it (`needs`): a way brought in by a file, or by a home handed
   * over, is held only by a node that is what it needs. Null when it can.
   */
  unfit?: (method: ConnectionMethod) => string | null;
  secret(connectionId: string, field: string): string | null;
  /** The secret fields a connection has, so setting one reopens it. */
  secretFields?(connectionId: string): readonly string[];
  /** What a device keeps for itself. */
  store(deviceId: SavedDeviceId): DeviceStore;
  /** Every hardware write is refused. Sessions are told, and must honour it; a simulator reaches no hardware. */
  readOnly: () => boolean;
  /** Frames nobody has described may be sent, by a type's raw-frame tool. */
  allowRawFrames: boolean;
  /** What another node of the home is called, in "held by …": "Olof's iPhone". */
  nodeName?: (node: string) => string | null;
  /** A connection of its own answered. */
  onConnected?: (connectionId: string) => void;
  /** A device said who it is, and its record did not know yet. */
  onIdentified?: (deviceId: SavedDeviceId, identity: string) => void;
  /** What a device is and says about itself, to keep: returns whether its description changed. */
  onDescribed?: (deviceId: SavedDeviceId, description: DeviceDescription, info: DeviceInfo | null, source: DescriptionSource) => boolean;
  /** An event a device raised, checked against its description. */
  onEvent?: (deviceId: SavedDeviceId, event: DeviceEventMessage) => void;
  /** What happened that the timeline keeps: a connection that reached a different device. */
  record?: (entry: AuditRecord) => void;
  /** Something changed that a screen shows. */
  onChange?: () => void;
  /** Where what devices say, as they say it, is published. */
  bus?: LiveBus;
  /**
   * For a simulator: whether what feeds a part of it gives it power now — a
   * simulated switch linked to it as `feeds` — or null when nothing
   * simulated does. Whoever keeps the links answers.
   */
  fed?: (deviceId: SavedDeviceId, part: string) => boolean | null;
  log?: (message: string) => void;
};

type Refusal = {
  status: 'unconfigured' | 'offline' | 'error';
  detail: string;
  /**
   * When to try again, for what can mend itself — a transport not up yet, a
   * device that did not answer. Absent for what waits on a person: nothing set
   * up, held elsewhere, a different device at the address.
   */
  retryAt?: number;
  attempts?: number;
};

type Open = {
  opened: OpenedDevice;
  /** The connection in use: a simulated one opens the type's simulator. */
  connection: HolderConnection;
  /** What it was opened with, so a change reopens it. */
  fingerprint: string;
  detach: () => void;
};

export class SessionManager {
  #open = new Map<SavedDeviceId, Open>();
  #refusals = new Map<SavedDeviceId, Refusal>();
  /** When each connection went down, and which have failed over and are passed over for a while. */
  #failover = new Failover();
  #records = new Map<SavedDeviceId, HolderDevice>();
  #syncing: Promise<unknown> = Promise.resolve();
  #watch: ReturnType<typeof setInterval> | null = null;
  #pulse: ReturnType<typeof setInterval> | null = null;
  /** What was last published, so only what moved is published again. */
  #changes = new ReadingChanges();
  #published = new Map<SavedDeviceId, { key: string; at: number }>();

  constructor(private deps: SessionManagerDeps) {}

  /** What a device is, or null when no installed type claims it. */
  typeOf(record: Pick<HolderDevice, 'typeId'>): DeviceType<any> | null {
    return this.deps.types.get(record.typeId) ?? null;
  }

  get(deviceId: SavedDeviceId): DeviceSession | null {
    return this.#open.get(deviceId)?.opened.session ?? null;
  }

  /** What a device is now: its open session's word, or what was last kept. */
  description(record: Pick<HolderDevice, 'id' | 'description'>): DeviceDescription {
    return this.#open.get(record.id)?.opened.description() ?? record.description;
  }

  /** Whose word its description is: the type's, or the device's own — as the open session says, else as last kept. */
  describedBy(record: Pick<HolderDevice, 'id' | 'descriptionSource'>): DescriptionSource {
    return this.#open.get(record.id)?.opened.describedBy() ?? record.descriptionSource;
  }

  /** What a device has said about itself: its open session's word, or what was last kept. */
  info(record: Pick<HolderDevice, 'id' | 'info'>): DeviceInfo | null {
    return this.#open.get(record.id)?.opened.info() ?? record.info;
  }

  /** Every device it has a session for. */
  opened(): SavedDeviceId[] {
    return [...this.#open.keys()];
  }

  /** Keeps what an open device is and has said; tells listeners when it changed. */
  #describe(deviceId: SavedDeviceId): void {
    const open = this.#open.get(deviceId);
    if (!open) return;
    const changed = this.deps.onDescribed?.(deviceId, open.opened.description(), open.opened.info(), open.opened.describedBy()) ?? false;
    if (changed) this.deps.bus?.publish({ kind: 'described', deviceId });
  }

  /** The connection a device is using right now. Null when none is open. */
  inUse(deviceId: SavedDeviceId): HolderConnection | null {
    return this.#open.get(deviceId)?.connection ?? null;
  }

  /** Whether a device is open as its type's simulator: nothing it does reaches hardware. */
  simulated(deviceId: SavedDeviceId): boolean {
    const open = this.#open.get(deviceId);
    return open !== undefined && isSimulated(open.connection);
  }

  /** How many times faster than real time a device's world runs: its simulated way's speed; 1 for hardware, or one not open. */
  speed(deviceId: SavedDeviceId): number {
    const open = this.#open.get(deviceId);
    const speed = open && isSimulated(open.connection) ? Number(open.connection.config.speed ?? 1) : 1;
    return Number.isFinite(speed) && speed >= 1 ? speed : 1;
  }

  /** What an open device reports now for a meaning on one of its parts — a plug's `switch.on` — or null: not open, or saying nothing of it. */
  reads(deviceId: SavedDeviceId, part: string, means: string): Value {
    const open = this.#open.get(deviceId);
    const attribute = open ? attributeMeaning(open.opened.description(), part, means) : null;
    return open && attribute ? (readingOf(open.opened.session.readings(), attribute.key)?.value ?? null) : null;
  }

  /** Whether the connection a device's session has open reaches it right now. */
  reachable(deviceId: SavedDeviceId): boolean {
    const open = this.#open.get(deviceId);
    if (!open) return false;
    return isSimulated(open.connection) || open.opened.channel?.connected === true;
  }

  /** How a device is doing: its session's own answer, or why it has none. */
  health(record: Pick<HolderDevice, 'id'>): ConnectionHealth {
    const open = this.#open.get(record.id);
    if (open) return open.opened.health();
    const refusal = this.#refusals.get(record.id);
    // Coarse, so a health that says it does not change every second.
    const wait = refusal?.retryAt ? refusal.retryAt - Date.now() : null;
    const again = wait === null ? '' : wait <= 45_000 ? '; trying again in under a minute' : `; trying again in ${Math.round(wait / 60_000)} min`;
    return {
      status: refusal?.status ?? 'offline',
      detail: refusal ? `${refusal.detail}${again}` : 'Not open yet',
      node: null,
      transport: null,
      lastReadingAt: null,
    };
  }

  /**
   * Brings the open sessions in line with what it is given: opens what was
   * added, closes what was removed, and reopens a device whose config,
   * connection, secrets or read-only changed. One at a time, so two syncs never
   * each decide the other's work is still to do.
   */
  sync(records: readonly HolderDevice[]): Promise<void> {
    const run = this.#syncing.then(() => this.#sync(records));
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  async #sync(records: readonly HolderDevice[]): Promise<void> {
    this.#records = new Map(records.map((record) => [record.id, record]));
    const wanted = new Map<SavedDeviceId, { record: HolderDevice; connection: HolderConnection }>();

    for (const record of records) {
      if (record.removedAt) continue;
      const type = this.typeOf(record);
      if (!type) {
        this.#refusals.set(record.id, { status: 'unconfigured', detail: `Nothing installed here knows what "${record.typeId}" is` });
        continue;
      }
      const chosen = await this.#choose(record, type);
      if ('refusal' in chosen) {
        this.#refuse(record.id, chosen.refusal, chosen.refusal.status === 'error');
        continue;
      }
      wanted.set(record.id, { record, connection: chosen.connection });
    }

    for (const [id, open] of [...this.#open]) {
      const next = wanted.get(id);
      if (!next || open.fingerprint !== this.#fingerprint(next.record, next.connection)) await this.close(id);
    }
    for (const id of [...this.#refusals.keys()]) {
      if (!records.some((record) => record.id === id && !record.removedAt)) this.#refusals.delete(id);
    }

    // Each isolated: one device that will not open must not keep the others shut.
    await Promise.all([...wanted.values()].filter(({ record }) => !this.#open.has(record.id)).map(({ record, connection }) => this.#openDevice(record, connection)));

    // Nobody waits on a check: what goes wrong is said, never left unhandled.
    this.#watch ??= setInterval(() => void this.check().catch((error: unknown) => this.deps.log?.(`checking the sessions failed: ${(error as Error).message}`)), WATCH_MS);
    (this.#watch as { unref?: () => void }).unref?.();
    this.#pulse ??= setInterval(() => this.pulse(), PULSE_MS);
    (this.#pulse as { unref?: () => void }).unref?.();
    this.deps.onChange?.();
  }

  /** What it was opened with: a change to any of it reopens it. */
  #fingerprint(record: HolderDevice, connection: HolderConnection): string {
    return JSON.stringify([record.typeId, record.config, connection.id, connection.address, connection.config, [...(this.deps.secretFields?.(connection.id) ?? [])].sort(), this.deps.readOnly()]);
  }

  /**
   * Publishes what changed for every device: the readings whose values moved,
   * and health when it changed. Nothing when nobody listens. Run by a timer; a
   * test runs it directly.
   */
  pulse(): void {
    for (const id of this.#records.keys()) {
      try {
        this.#publish(id);
      } catch (error) {
        // A device's own code that fails to say how it is costs that device its pulse, never the others' — nor the process, from a timer.
        this.deps.log?.(`${this.#records.get(id)?.name ?? id} could not say how it is: ${(error as Error).message}`);
      }
    }
  }

  #publish(deviceId: SavedDeviceId): void {
    const bus = this.deps.bus;
    const record = this.#records.get(deviceId);
    if (!bus || bus.listening === 0 || !record || record.removedAt) return;
    const open = this.#open.get(deviceId);
    if (open) {
      const changed = this.#changes.since(deviceId, open.opened.session.readings());
      if (changed.length) bus.publish({ kind: 'readings', deviceId, readings: changed });
    }
    const health = this.health(record);
    const key = `${health.status}|${health.detail}|${health.node}|${health.transport}`;
    const last = this.#published.get(deviceId);
    const now = Date.now();
    const stale = health.lastReadingAt !== null && last !== undefined && now - last.at >= HEALTH_REFRESH_MS;
    if (last?.key === key && !stale) return;
    this.#published.set(deviceId, { key, at: now });
    bus.publish({ kind: 'health', deviceId, health });
  }

  /**
   * The connection to use: the preferred one this holder holds whose
   * transport is available here — a simulated one always is. A device only
   * another holds has no session here: its card says who holds it.
   */
  async #choose(record: HolderDevice, type: DeviceType<any>): Promise<{ connection: HolderConnection } | { refusal: Refusal }> {
    const all = this.deps.connections(record.id);
    if (!all.length) return { refusal: { status: 'unconfigured', detail: 'Nothing can reach this device yet: add a way to reach it' } };

    const reasons: string[] = [];
    const mine = all.filter((connection) => this.deps.holds(connection));
    for (const connection of mine) {
      if (this.#failover.avoided(connection.id) && mine.length > 1) continue;
      const method = methodOf(type, connection.method);
      if (!method) {
        reasons.push(`${record.typeId} no longer has a way called "${connection.method}"`);
        continue;
      }
      const unfit = this.deps.unfit?.(method) ?? null;
      if (unfit) {
        reasons.push(unfit);
        continue;
      }
      if (isSimulated(connection)) return { connection };
      await this.deps.transports.start?.(connection.transport);
      const available = this.deps.transports.available?.(connection.transport) ?? { ok: true };
      if (!available.ok) {
        reasons.push(available.reason);
        continue;
      }
      return { connection };
    }

    const other = all.find((connection) => !this.deps.holds(connection));
    if (!mine.length && other) {
      const who = this.deps.nodeName?.(other.heldBy) ?? 'another node';
      return { refusal: { status: 'offline', detail: `Held by ${who}, not by ${this.deps.node.name}` } };
    }
    return { refusal: { status: 'error', detail: reasons[0] ?? 'None of its connections can be used here' } };
  }

  async #openDevice(record: HolderDevice, connection: HolderConnection): Promise<void> {
    const type = this.typeOf(record)!;
    const simulated = isSimulated(connection);
    // Tried again: what it was refused for goes, and how often it has been is kept — a dead one waits longer each time.
    const tried = this.#refusals.get(record.id)?.attempts ?? 0;
    this.#refusals.delete(record.id);
    const log = (level: 'log' | 'warn' | 'error') => (message: string, extra?: unknown) => console[level](`[${record.name}] ${message}`, extra ?? '');

    try {
      const opened = await openDevice({
        type,
        device: record,
        // A simulated one opens its type's simulator in its place, in every holder.
        connection,
        secret: (field) => this.deps.secret(connection.id, field),
        protocols: this.deps.protocols,
        transports: this.deps.transports,
        store: this.deps.store(record.id),
        platform: this.deps.platform,
        node: this.deps.node.id,
        // Read-only is about hardware: a simulated device has none, and takes writes either way.
        readOnly: this.deps.readOnly() && !simulated,
        allowRawFrames: this.deps.allowRawFrames,
        log: { info: log('log'), warn: log('warn'), error: log('error') },
        // A device that pushes, or a poll that finished: what moved is published now, not at the next pulse.
        changed: () => {
          this.#describe(record.id);
          this.#publish(record.id);
          this.deps.onChange?.();
        },
        afterScheduled: () => {
          // A wrong device is caught at its first answer, not at the next look round.
          void this.#verify(record.id);
          this.#publish(record.id);
          this.deps.onChange?.();
        },
        event: (event) => {
          this.deps.onEvent?.(record.id, event);
          this.deps.bus?.publish({ kind: 'event', deviceId: record.id, event });
        },
        fed: (part) => this.deps.fed?.(record.id, part) ?? null,
      });

      const entry: Open = { opened, connection, fingerprint: this.#fingerprint(record, connection), detach: () => {} };
      // A simulator has no channel: it is there, and stays there.
      const noteState = (connected: boolean) => {
        this.#failover.note(connection.id, connected);
        if (connected) this.deps.onConnected?.(connection.id);
      };
      if (opened.channel) {
        entry.detach = opened.channel.onConnectedChange((connected) => {
          noteState(connected);
          this.deps.onChange?.();
        });
        noteState(opened.channel.connected);
      } else noteState(true);
      this.#open.set(record.id, entry);
      this.#describe(record.id);
    } catch (error) {
      const refused = error instanceof OpenRefused ? error : new OpenRefused((error as Error).message, 'error');
      this.#refuse(record.id, { status: refused.status, detail: refused.message }, refused.status !== 'unconfigured', tried);
      this.deps.log?.(`${record.name} could not be opened: ${refused.message}`);
    }
  }

  /** Why a device has no session; for what can mend itself, when it will be tried again. */
  #refuse(deviceId: SavedDeviceId, refusal: Refusal, retry: boolean, tried = this.#refusals.get(deviceId)?.attempts ?? 0): void {
    if (!retry) {
      this.#refusals.set(deviceId, refusal);
      return;
    }
    const attempts = tried + 1;
    const wait = RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1]!;
    this.#refusals.set(deviceId, { ...refusal, attempts, retryAt: Date.now() + wait });
  }

  /**
   * The wrong-device check: a connection whose device says it is another one
   * is closed, nothing it says is kept as this one's, and the timeline says so.
   * A device saying who it is for the first time is learnt. Returns whether
   * the session still stands.
   */
  async #verify(deviceId: SavedDeviceId): Promise<boolean> {
    const open = this.#open.get(deviceId);
    const record = this.#records.get(deviceId);
    if (!open || !record || isSimulated(open.connection)) return Boolean(open);
    const said = open.opened.session.identity?.().id ?? null;
    const verdict = identityVerdict(record.identity, said);
    if (verdict === 'mismatch') {
      // The address now leads somewhere else: nothing it says is this device's.
      await this.close(deviceId);
      this.#refusals.set(deviceId, { status: 'error', detail: `That connection reaches a different device (${said}), not the one you added` });
      this.deps.record?.({ at: new Date().toISOString(), kind: 'device.mismatch', actor: this.deps.node.name, resourceKind: 'device', resource: deviceId, summary: `${record.name}'s connection reaches ${said} instead`, detail: { expected: record.identity } });
      this.deps.onChange?.();
      return false;
    }
    if (verdict === 'learnt') {
      this.deps.onIdentified?.(deviceId, said!);
      this.#records.set(deviceId, { ...record, identity: said });
    }
    return true;
  }

  /**
   * Every little while: learns identities devices have said, refuses a
   * connection that reaches the wrong device, falls back from one that has
   * been down too long, and tries again to open a device whose refusal can
   * mend itself. Run by a timer; a test runs it directly, and may say when "now" is.
   */
  async check(now = Date.now()): Promise<void> {
    // A device refused for what can mend itself — a transport not up at boot — is tried again when due.
    let changed = [...this.#refusals.values()].some((refusal) => refusal.retryAt !== undefined && refusal.retryAt <= now);
    for (const [id, open] of [...this.#open]) {
      // What it is can change while it is open: a pack plugged in, firmware read.
      this.#describe(id);
      if (!(await this.#verify(id)) || isSimulated(open.connection)) continue;
      const record = this.#records.get(id);
      const others = this.deps.connections(id).filter((connection) => this.deps.holds(connection) && connection.id !== open.connection.id);
      const down = this.#failover.downFor(open.connection.id);
      if (record && this.#failover.due(open.connection.id, others.length > 0)) {
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
    // Opened again, everything it says is news.
    this.#changes.forget(deviceId);
    if (!open) return;
    open.detach();
    // The channel is this manager's: it opened it, so it closes it.
    await open.opened.close();
  }

  async closeAll(): Promise<void> {
    if (this.#watch) clearInterval(this.#watch);
    if (this.#pulse) clearInterval(this.#pulse);
    this.#watch = null;
    this.#pulse = null;
    await Promise.all([...this.#open.keys()].map((id) => this.close(id)));
    this.#refusals.clear();
  }
}
