import type { DeviceRecord } from '../devices/catalog.ts';
import { DeviceDriver } from '../drivers/device.ts';
import type { StationDriver } from '../drivers/types.ts';
import type { ServerLink, ServerTransportKind, TransportHost } from '../transport/types.ts';

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
 * It no longer refuses the second station. That refusal was honest about the
 * old transport and wrong about the hardware: one broker serves every station
 * that connects to it, and a BLE central holds several peripherals at once.
 * What the process has one of is the *host* — the radio, the broker — and
 * `TransportHost` now carries as many links as there are saved stations.
 *
 * The constraint that remains is real, and it is per station rather than per
 * server: a station accepts one connection at a time, so opening it here is
 * still taking it away from the app, or from BrightEMS.
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
  /** This device's own link. Null for the simulator, which has no transport. */
  readonly link: ServerLink | null;
};

export type ConnectionManagerDeps = {
  /** Which link this process can hold, decided by the launch flag. */
  kind: LinkKind;
  readOnly: boolean;
  /** Built once, on first use: the radio and the broker are process-wide. */
  host: () => TransportHost;
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
  /**
   * How to stop listening for discoveries on a session's behalf.
   *
   * The host outlives its sessions, so a listener left behind by a closed
   * session keeps running — and would happily auto-bind a station again on
   * behalf of a device that has just been forgotten.
   */
  #watchers = new Map<string, () => void>();
  /**
   * Which station each session is meant to be on.
   *
   * Tracked here rather than re-read from the catalog, so the manager stays
   * free of the database — but it must follow a rebind, or a session would go
   * on preferring the station the user just moved away from.
   */
  #bound = new Map<string, string | null>();
  /**
   * Devices whose station the user let go of on purpose.
   *
   * Distinct from "has no station yet", which auto-bind is allowed to fill.
   * Cleared by an explicit bind, and by forgetting the device.
   */
  #released = new Set<string>();
  #host: TransportHost | null = null;
  #starting: Promise<TransportHost> | null = null;

  constructor(private deps: ConnectionManagerDeps) {}

  get kind(): LinkKind {
    return this.deps.kind;
  }

  get readOnly(): boolean {
    return this.deps.readOnly;
  }

  /**
   * The host itself, started on demand.
   *
   * Discovery needs one before any device exists — you cannot bind the station
   * you have not found yet — so this is reachable without a session.
   */
  async link(): Promise<TransportHost | null> {
    if (this.deps.kind === 'sim') return null;
    if (this.#host) return this.#host;

    this.#starting ??= (async () => {
      const host = this.deps.host();
      await host.start();
      this.#host = host;
      return host;
    })();

    return this.#starting;
  }

  /** The host if it has already been started, without starting one. */
  get transport(): TransportHost | null {
    return this.#host;
  }

  get(deviceId: string): StationSession | null {
    return this.#sessions.get(deviceId) ?? null;
  }

  /** Why this saved device has no live session. */
  refusal(deviceId: string): string | null {
    return this.#refusals.get(deviceId) ?? null;
  }

  /**
   * `station()` was here, returning the first open session.
   *
   * It is deliberately gone rather than deprecated. "The station" is a question
   * with no correct answer once a server holds several, and an accessor that
   * answers it anyway is a standing invitation to act on the wrong machine —
   * which is precisely the bug this whole model exists to make impossible.
   * Every caller names a device: `get(deviceId)`.
   */

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

    /*
      Concurrently, and each one isolated.

      Opening a BLE link means a GATT connect, which for a station that is
      asleep or out of range takes its time and then fails. Serially that cost
      is paid once per saved station before the HTTP listener comes up, so a
      handful of quiet stations would hold the whole server down; and one that
      threw took every station after it with it.

      Safe to run at once because each `open` makes its claim synchronously
      before its first await — see `#hardware`.
    */
    await Promise.all(
      stations
        .filter((record) => !this.#sessions.has(record.id))
        .map((record) =>
          this.open(record).catch((error: unknown) => {
            this.#refuse(record.id, (error as Error).message);
            return null;
          })
        )
    );
  }

  /**
   * Opens the link for one saved station.
   *
   * Every saved station gets one. A link whose station is out of range, asleep
   * or already claimed by something else is not an error — it is disconnected,
   * and it keeps trying.
   */
  async open(record: DeviceRecord): Promise<StationSession | null> {
    if (this.#sessions.has(record.id)) return this.#sessions.get(record.id)!;

    // Cleared before opening, not after: `#hardware` may set a fresh one, and
    // clearing afterwards threw it away — the device then looked merely quiet
    // rather than in conflict with another device you own.
    this.#refusals.delete(record.id);

    const session =
      this.deps.kind === 'sim' ? this.#simulated(record) : await this.#hardware(record);

    await session.driver.start();
    this.#sessions.set(record.id, session);
    return session;
  }

  #simulated(record: DeviceRecord): StationSession {
    return {
      deviceId: record.id,
      kind: 'sim',
      driver: this.deps.simulator(),
      device: null,
      link: null,
    };
  }

  async #hardware(record: DeviceRecord): Promise<StationSession> {
    const kind = this.deps.kind as ServerTransportKind;

    // What the record already knows, which is how a restart reconnects to the
    // same unit instead of whichever station answers first.
    const saved = typeof record.config.boundId === 'string' ? record.config.boundId : null;

    /*
      The one conflict that survives, and it is a real one: a station accepts a
      single connection, so two saved devices naming the same station cannot
      both have it. This is what `refusal` means now — not "the server is full",
      which was never true, but "another device you own already has this unit".

      Claimed here, before the first `await`. Sessions are opened concurrently,
      so a check that straddles an await would let both of them see the station
      free and both take it.
    */
    const clash = saved ? this.#ownerOf(saved, record.id) : null;
    if (clash) this.#refuse(record.id, `Another saved device is already bound to ${saved}`);
    this.#bound.set(record.id, clash ? null : saved);

    const host = (await this.link())!;

    // A link with no station yet is a real thing: it exists, it is disconnected,
    // and the discovery watcher below is what gives it one.
    const link = saved && !clash ? await host.open(saved).catch(() => null) : null;
    if (link) this.deps.log?.(`Linked ${record.name} to ${saved}`);

    const device = new DeviceDriver({
      transport: link ?? idleLink(kind),
      readOnly: this.deps.readOnly,
    });

    const stop = host.onDiscovery((found) => {
      // Gone: this session was closed, and a forgotten device must not quietly
      // take a station back the moment something advertises.
      if (!this.#sessions.has(record.id)) return;

      // The record is the authority on which station is this device's, and it
      // changes under us when the user binds a different one.
      const preferred = this.#bound.get(record.id) ?? null;
      if (preferred) return; // it has its station; the link's own loop reconnects

      // A deliberate unbind means stop. Without this, auto-bind — which is on
      // by default — reads "no preferred station" as "free to take the first
      // one it sees", and takes back the station the user just released on its
      // very next advertisement.
      if (this.#released.has(record.id)) return;

      // Never take a station another saved device is already linked to or has
      // claimed, and never auto-connect to something that cannot be identified
      // as a station.
      if (this.#ownerOf(found.id, record.id)) return;
      if (host.openIds().some((id) => same(id, found.id))) return;
      if (!(this.deps.autoBind && found.likelyStation)) return;

      void this.bind(record.id, found.id)
        .then(() => this.deps.log?.(`Auto-bound ${record.name} to ${found.id}`))
        .catch((error: unknown) => {
          this.deps.log?.(`Auto-bind failed: ${(error as Error).message}`);
        });
    });

    this.#watchers.set(record.id, stop);

    return { deviceId: record.id, kind, driver: device, device, link };
  }

  /**
   * Binds a saved device to a station on the shared host.
   *
   * The choice is written back to the record by the caller's `onBound`, because
   * where a device is reached is a property of that device — not of a file the
   * whole server shares.
   */
  async bind(deviceId: string, stationId: string): Promise<void> {
    const session = this.#sessions.get(deviceId);
    if (!session || session.kind === 'sim') {
      throw new Error('That device has no hardware link to bind');
    }

    /*
      Claimed before the first await, and rolled back if opening fails.
      Every waiting session's discovery watcher fires in the same turn, so a
      check followed by an `await` and only then a write is not a claim: each
      caller looks, sees the station free, and takes it. One station, two
      owners, both drivers polling one link, and whichever closes first takes
      it away from the other.
    */
    const taken = this.#ownerOf(stationId, deviceId);
    if (taken) throw new Error(`Another saved device is already bound to ${stationId}`);

    const previous = this.#bound.get(deviceId) ?? null;
    this.#bound.set(deviceId, stationId);
    this.#released.delete(deviceId);

    try {
      const host = (await this.link())!;
      await session.link?.close();

      const link = await host.open(stationId);
      session.device?.retarget(link);
      session.device?.reset();

      this.#sessions.set(deviceId, { ...session, link });
      this.deps.onBound?.(deviceId, session.kind, stationId);
    } catch (error) {
      // Releasing the claim matters as much as making it: a station left
      // reserved by a bind that failed is one nothing else may ever take.
      this.#bound.set(deviceId, previous);
      throw error;
    }
  }

  async unbind(deviceId: string): Promise<void> {
    const session = this.#sessions.get(deviceId);
    if (!session || session.kind === 'sim') {
      throw new Error('That device has no hardware link to unbind');
    }

    await session.link?.close();
    this.#bound.set(deviceId, null);
    // Remembered, because "no station" and "the user let this one go" are not
    // the same thing to auto-bind.
    this.#released.add(deviceId);
    session.device?.retarget(idleLink(session.kind));
    session.device?.reset();

    this.#sessions.set(deviceId, { ...session, link: null });
    this.deps.onBound?.(deviceId, session.kind, null);
  }

  async close(deviceId: string): Promise<void> {
    const session = this.#sessions.get(deviceId);
    if (!session) return;

    this.#sessions.delete(deviceId);
    this.#bound.delete(deviceId);
    this.#released.delete(deviceId);
    // Stop watching before releasing the station: an unclaimed station is
    // exactly what this session's discovery listener would rush to bind again.
    this.#watchers.get(deviceId)?.();
    this.#watchers.delete(deviceId);

    await session.driver.stop().catch(() => undefined);
    // Only this device's link closes. The host is the process's one radio, and
    // every other station stays exactly where it was.
    await session.link?.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const deviceId of [...this.#sessions.keys()]) await this.close(deviceId);
  }

  #refuse(deviceId: string, reason: string): void {
    this.#refusals.set(deviceId, reason);
    this.deps.log?.(`No link for ${deviceId}: ${reason}`);
  }

  /** Which other saved device has claimed this station, if any. */
  #ownerOf(stationId: string, except: string): string | null {
    for (const [id, bound] of this.#bound) {
      if (id !== except && bound && same(bound, stationId)) return id;
    }
    return null;
  }
}

/**
 * Station ids compared without regard to case.
 *
 * The two transports disagree, and quietly: `MqttHost` upper-cases MACs, while
 * a noble peripheral id is lower-case hex. A record written by one and checked
 * against the other would compare unequal, and the ownership check that stops
 * two devices sharing a station would wave the second one through.
 */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A link to nothing, for a saved station that has not been given one yet.
 *
 * The driver wants something to poll from the moment it starts, and a null
 * would mean a null check on every call in `StationClient`. This answers
 * honestly instead: not connected, bound to nothing, every write refused.
 */
const idleLink = (kind: ServerTransportKind): ServerLink => ({
  kind,
  boundId: null,
  connected: false,
  async send() {
    throw new Error('No station bound');
  },
  async request() {
    throw new Error('No station bound');
  },
  onFrame: () => () => {},
  async close() {},
});
