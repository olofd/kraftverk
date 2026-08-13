import type { DeviceRecord } from '../devices/catalog.ts';
import { DeviceDriver } from '../drivers/device.ts';
import type { StationDriver } from '../drivers/types.ts';
import type { ServerTransportKind, Transport } from '../transport/types.ts';

/**
 * Who is talking to what.
 *
 * The server used to hold one `driver`, one `transport` and one binding, all of
 * them module-level. That is workable while there is exactly one station and
 * fatal the moment there are two: every route reached the same globals, so
 * "edit this device" and "delete this device" could not mean anything specific.
 * The server could not say *whose* link it was holding, because it only had one.
 *
 * A session belongs to a saved device id. That is the whole idea: the catalog
 * says what you own, the manager says what is currently reachable, and a route
 * that wants to read or write a device asks for that device's session rather
 * than for "the station".
 *
 * What it deliberately does not do is pretend. This process holds one link —
 * noble owns the Bluetooth adapter, and the MQTT broker owns its port — so a
 * second station cannot be opened, and the manager says so in words the UI can
 * show instead of quietly handing both records the same link.
 */

/** How a session reaches its device. `sim` is the built-in simulator. */
export type LinkKind = ServerTransportKind | 'sim';

export type StationSession = {
  /** The catalog id. Sessions are keyed by it, and so is history. */
  readonly deviceId: string;
  readonly kind: LinkKind;
  readonly driver: StationDriver;
  /**
   * Present only for real hardware: register dumps, the read-only guard and the
   * blocked-write log are things a simulator has no answer for.
   */
  readonly device: DeviceDriver | null;
  readonly transport: Transport | null;
};

export type ConnectionManagerDeps = {
  /** Which link this process can hold, decided by the launch flag. */
  kind: LinkKind;
  readOnly: boolean;
  /** Built once, on first use: the radio and the broker are process-wide. */
  transport: () => Transport;
  simulator: () => StationDriver;
  /** Told when a session binds, so the record stops lying about its link. */
  onBound?: (deviceId: string, kind: LinkKind, boundId: string | null) => void;
  /** Bind the first station discovered instead of waiting for a choice. */
  autoBind?: boolean;
  log?: (message: string) => void;
};

export class ConnectionManager {
  #sessions = new Map<string, StationSession>();
  /** Why a saved device has no session, in words a user can act on. */
  #refusals = new Map<string, string>();
  #transport: Transport | null = null;
  #starting: Promise<Transport> | null = null;

  constructor(private deps: ConnectionManagerDeps) {}

  get kind(): LinkKind {
    return this.deps.kind;
  }

  get readOnly(): boolean {
    return this.deps.readOnly;
  }

  /**
   * The transport itself, started on demand.
   *
   * Discovery needs one before any device exists — you cannot bind the station
   * you have not found yet — so this is reachable without a session.
   */
  async link(): Promise<Transport | null> {
    if (this.deps.kind === 'sim') return null;
    if (this.#transport) return this.#transport;

    this.#starting ??= (async () => {
      const transport = this.deps.transport();
      await transport.start();
      this.#transport = transport;
      return transport;
    })();

    return this.#starting;
  }

  /** The transport if it has already been started, without starting one. */
  get transport(): Transport | null {
    return this.#transport;
  }

  get(deviceId: string): StationSession | null {
    return this.#sessions.get(deviceId) ?? null;
  }

  /** Why this saved device has no live session. */
  refusal(deviceId: string): string | null {
    return this.#refusals.get(deviceId) ?? null;
  }

  /**
   * The one station session, while there can only be one.
   *
   * The remaining global routes — `/api/status`, `/api/settings`, the register
   * diagnostics — still ask this question. They are on their way to
   * `/api/devices/:id/...`; until they get there this is where they resolve,
   * and it returns null rather than a fake when nothing is open.
   */
  station(): StationSession | null {
    return this.#sessions.values().next().value ?? null;
  }

  get sessions(): StationSession[] {
    return [...this.#sessions.values()];
  }

  /**
   * Brings live sessions in line with what is saved.
   *
   * Called at startup and after the catalog changes, so adding a station opens
   * its link and forgetting one closes it — which is what makes deleting a
   * device an honest act rather than a row disappearing while a socket stays up.
   */
  async sync(records: DeviceRecord[]): Promise<void> {
    const stations = records.filter((record) => record.type === 'power-station');
    const wanted = new Set(stations.map((record) => record.id));

    for (const deviceId of [...this.#sessions.keys()]) {
      if (!wanted.has(deviceId)) await this.close(deviceId);
    }
    for (const deviceId of [...this.#refusals.keys()]) {
      if (!wanted.has(deviceId)) this.#refusals.delete(deviceId);
    }

    for (const record of stations) {
      if (this.#sessions.has(record.id)) continue;
      await this.open(record);
    }
  }

  /**
   * Opens the link for one saved station.
   *
   * Refusing is a normal outcome, not an error: this process holds one link, so
   * the second station a user adds cannot have one until they are given a way to
   * choose. Recording *why* means the device still appears in the catalog, with
   * a reason under it, rather than looking broken.
   */
  async open(record: DeviceRecord): Promise<StationSession | null> {
    if (this.#sessions.has(record.id)) return this.#sessions.get(record.id)!;

    if (this.#sessions.size > 0) {
      this.#refuse(
        record.id,
        this.deps.kind === 'ble'
          ? 'The server holds one Bluetooth station at a time, and another is already open'
          : 'The server holds one station link at a time, and another is already open'
      );
      return null;
    }

    const session =
      this.deps.kind === 'sim' ? this.#simulated(record) : await this.#hardware(record);

    await session.driver.start();
    this.#sessions.set(record.id, session);
    this.#refusals.delete(record.id);
    return session;
  }

  #simulated(record: DeviceRecord): StationSession {
    return {
      deviceId: record.id,
      kind: 'sim',
      driver: this.deps.simulator(),
      device: null,
      transport: null,
    };
  }

  async #hardware(record: DeviceRecord): Promise<StationSession> {
    const transport = (await this.link())!;
    const device = new DeviceDriver({ transport, readOnly: this.deps.readOnly });
    const kind = transport.kind;

    // What the record already knows, which is how a restart reconnects to the
    // same unit instead of whichever station answers first.
    const saved = typeof record.config.boundId === 'string' ? record.config.boundId : null;
    if (saved) {
      try {
        await transport.bind(saved);
        this.deps.log?.(`Bound ${record.name} to ${saved}`);
      } catch (error) {
        this.deps.log?.(`Could not bind ${saved} yet: ${(error as Error).message}`);
      }
    }

    transport.onDiscovery((found) => {
      const wanted = saved && found.id.toUpperCase() === saved.toUpperCase();
      // Never auto-connect to something that cannot be identified as a station.
      if (transport.boundId || !(wanted || (this.deps.autoBind && found.likelyStation))) return;

      void transport
        .bind(found.id)
        .then(() => {
          this.deps.log?.(`Auto-bound ${record.name} to ${found.id}`);
          device.reset();
          this.deps.onBound?.(record.id, kind, found.id);
        })
        .catch((error: unknown) => {
          this.deps.log?.(`Auto-bind failed: ${(error as Error).message}`);
        });
    });

    return { deviceId: record.id, kind, driver: device, device, transport };
  }

  /**
   * Binds a saved device to a station on its own transport.
   *
   * The choice is written back to the record by the caller's `onBound`, because
   * where a device is reached is a property of that device — not of a file the
   * whole server shares.
   */
  async bind(deviceId: string, stationId: string): Promise<void> {
    const session = this.#sessions.get(deviceId);
    if (!session?.transport) throw new Error('That device has no hardware link to bind');

    await session.transport.bind(stationId);
    session.device?.reset();
    this.deps.onBound?.(deviceId, session.kind, stationId);
  }

  async unbind(deviceId: string): Promise<void> {
    const session = this.#sessions.get(deviceId);
    if (!session?.transport) throw new Error('That device has no hardware link to unbind');

    await session.transport.unbind();
    session.device?.reset();
    this.deps.onBound?.(deviceId, session.kind, null);
  }

  async close(deviceId: string): Promise<void> {
    const session = this.#sessions.get(deviceId);
    if (!session) return;

    this.#sessions.delete(deviceId);
    await session.driver.stop().catch(() => undefined);
    // The transport outlives the session: it is this process's one radio, and
    // the next device to be opened will want it.
    await session.transport?.unbind().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const deviceId of [...this.#sessions.keys()]) await this.close(deviceId);
  }

  #refuse(deviceId: string, reason: string): void {
    this.#refusals.set(deviceId, reason);
    this.deps.log?.(`No link for ${deviceId}: ${reason}`);
  }
}
