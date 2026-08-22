import { sameStation, stationId, type SavedDeviceId, type StationId } from '@kraftverk/plugin-sdk';

import { boundStation, transportOf, type DeviceRecord } from '../devices/catalog.ts';
import { DeviceDriver } from '../drivers/device.ts';
import type { StationDriver } from '../drivers/types.ts';
import type { ServerLink, ServerTransportKind, TransportHost } from '../transport/types.ts';

/**
 * Who is talking to what.
 *
 * A session belongs to a saved device id, and there is one per saved station.
 * The catalog says what you own; the manager says what is currently reachable;
 * a route that wants to read or write a device asks for *that device's*
 * session. There is no such thing here as "the station".
 *
 * What the process has exactly one of is the `TransportHost` — the radio, or
 * the broker. Links are not scarce in the same way: a broker serves every
 * station that connects to it, and a BLE central holds several peripherals at
 * once. So the host carries as many links as there are saved stations.
 *
 * The scarcity that is real belongs to the station rather than to the server: a
 * station accepts one connection at a time, so opening it here takes it away
 * from the app, and from BrightEMS. That is why two saved devices may not name
 * the same station, and why the refusal says which one already has it.
 */

/** How a session reaches its device. `sim` is the built-in simulator. */
export type LinkKind = ServerTransportKind | 'sim';

export type StationSession = {
  /** The catalog id. Sessions are keyed by it, and so is history. */
  readonly deviceId: SavedDeviceId;
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
  /**
   * Which transports this server offers, in preference order.
   *
   * Plural, because they are independent resources: the broker is a TCP
   * listener and noble is a radio, and nothing stops a server holding both.
   * Which one a *station* is reached over is a property of that station's
   * record, not of the process — so a station on Bluetooth and one on WiFi can
   * be owned by the same server at the same time, and adding the second does
   * not disturb the first.
   */
  transports: ServerTransportKind[];
  /** Every station is simulated and no radio runs. */
  simulate: boolean;
  readOnly: boolean;
  /** Builds one transport. Started on first use, and at most once each. */
  host: (kind: ServerTransportKind) => TransportHost;
  simulator: () => StationDriver;
  /** Told when a session binds, so the record stops lying about its link. */
  onBound?: (deviceId: SavedDeviceId, kind: LinkKind, boundId: StationId | null) => void;
  /** Bind the first station discovered instead of waiting for a choice. */
  autoBind?: boolean;
  log?: (message: string) => void;
};

export class ConnectionManager {
  #sessions = new Map<SavedDeviceId, StationSession>();
  /** Why a saved device has no session, in words a user can act on. */
  #refusals = new Map<SavedDeviceId, string>();
  /**
   * How to stop listening for discoveries on a session's behalf.
   *
   * The host outlives its sessions, so a listener left behind by a closed
   * session keeps running — and would happily auto-bind a station again on
   * behalf of a device that has just been forgotten.
   */
  #watchers = new Map<SavedDeviceId, () => void>();
  /**
   * Which station each session is meant to be on.
   *
   * Tracked here rather than re-read from the catalog, so the manager stays
   * free of the database — but it must follow a rebind, or a session would go
   * on preferring the station the user just moved away from.
   */
  #bound = new Map<SavedDeviceId, StationId | null>();
  /**
   * Devices whose station the user let go of on purpose.
   *
   * Distinct from "has no station yet", which auto-bind is allowed to fill.
   * Cleared by an explicit bind, and by forgetting the device.
   */
  #released = new Set<SavedDeviceId>();
  /** One per transport, started on demand and at most once each. */
  #hosts = new Map<ServerTransportKind, TransportHost>();
  #starting = new Map<ServerTransportKind, Promise<TransportHost>>();
  /**
   * Why a transport is unavailable.
   *
   * A machine with no Bluetooth adapter should still serve its WiFi stations,
   * so a host that fails to start is recorded and reported rather than thrown:
   * one absent radio is not a reason for the server not to come up.
   */
  #hostErrors = new Map<ServerTransportKind, string>();

  constructor(private deps: ConnectionManagerDeps) {}

  /** The transports this server offers, whether or not they have started. */
  get transports(): ServerTransportKind[] {
    return this.deps.simulate ? [] : this.deps.transports;
  }

  /** Why a transport is not available, if it isn't. */
  transportError(kind: ServerTransportKind): string | null {
    return this.#hostErrors.get(kind) ?? null;
  }

  get readOnly(): boolean {
    return this.deps.readOnly;
  }

  /**
   * One transport, started on demand.
   *
   * Discovery needs a host before any device exists — you cannot bind the
   * station you have not found yet — so this is reachable without a session.
   * A transport this server does not offer returns null rather than starting
   * a radio nobody asked for.
   */
  async hostFor(kind: ServerTransportKind): Promise<TransportHost | null> {
    if (!this.transports.includes(kind)) return null;

    const started = this.#hosts.get(kind);
    if (started) return started;

    let pending = this.#starting.get(kind);
    if (!pending) {
      pending = (async () => {
        const host = this.deps.host(kind);
        await host.start();
        this.#hosts.set(kind, host);
        this.#hostErrors.delete(kind);
        return host;
      })();
      this.#starting.set(kind, pending);
    }

    try {
      return await pending;
    } catch (error) {
      // Recorded, not thrown: a machine with no Bluetooth adapter must still
      // serve the stations it reaches over WiFi.
      this.#hostErrors.set(kind, (error as Error).message);
      this.#starting.delete(kind);
      this.deps.log?.(`${kind} is unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  /** Starts every offered transport, reporting rather than throwing. */
  async startTransports(): Promise<void> {
    await Promise.all(this.transports.map((kind) => this.hostFor(kind)));
  }

  /** The hosts already started, for discovery and diagnostics. */
  get hosts(): { kind: ServerTransportKind; host: TransportHost }[] {
    return [...this.#hosts.entries()].map(([kind, host]) => ({ kind, host }));
  }

  get(deviceId: SavedDeviceId): StationSession | null {
    return this.#sessions.get(deviceId) ?? null;
  }

  /** Why this saved device has no live session. */
  refusal(deviceId: SavedDeviceId): string | null {
    return this.#refusals.get(deviceId) ?? null;
  }

  /**
   * Every open session.
   *
   * For counting and listing only. There is deliberately no accessor that
   * returns "the" station: it is a question with no correct answer, and one
   * that answered it anyway would be a standing invitation to act on the wrong
   * machine. Callers that mean a particular device use `get(deviceId)`.
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

    const session = this.deps.simulate
      ? this.#simulated(record)
      : await this.#hardware(record);

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
    /*
      Which radio *this station* is reached over, from its own record.

      A server can hold several transports at once, so this is a property of
      the device rather than of the process: a station on Bluetooth and one on
      WiFi are both ordinary saved devices, and neither has to know the other
      exists. A record with no transport yet takes the first one offered, which
      is what a station gets when it is discovered rather than configured.
    */
    const kind = transportOf(record) ?? this.transports[0] ?? 'mqtt';

    // What the record already knows, which is how a restart reconnects to the
    // same unit instead of whichever station answers first.
    const saved = boundStation(record);

    /*
      A station accepts a single connection, so two saved devices naming the
      same one cannot both have it. That is what a `refusal` means: not "the
      server is full", but "another device you own already has this unit".

      The claim is made here, before the first `await`. Sessions open
      concurrently, and a check separated from its write by an await is not a
      claim at all — both callers would look, both would see the station free,
      and both would take it.
    */
    const clash = saved ? this.#ownerOf(saved, record.id) : null;
    if (clash) this.#refuse(record.id, `Another saved device is already bound to ${saved}`);
    this.#bound.set(record.id, clash ? null : saved);

    const host = await this.hostFor(kind);
    if (!host) {
      // The transport this station is configured for is not available on this
      // machine. It stays a device you own, greyed and saying why.
      this.#refuse(
        record.id,
        this.transportError(kind) ?? `This server does not offer the ${kind} transport`
      );
    }

    // A link with no station yet is a real thing: it exists, it is disconnected,
    // and the discovery watcher below is what gives it one.
    const link = host && saved && !clash ? await host.open(saved).catch(() => null) : null;
    if (link) this.deps.log?.(`Linked ${record.name} to ${saved} over ${kind}`);

    const device = new DeviceDriver({
      transport: link ?? idleLink(kind),
      readOnly: this.deps.readOnly,
    });

    const stop = host?.onDiscovery((found) => {
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
      const candidate = stationId(found.id);
      if (this.#ownerOf(candidate, record.id)) return;
      if (host.openIds().some((id) => sameStation(id, candidate))) return;
      if (!(this.deps.autoBind && found.likelyStation)) return;

      void this.bind(record.id, candidate)
        .then(() => this.deps.log?.(`Auto-bound ${record.name} to ${found.id}`))
        .catch((error: unknown) => {
          this.deps.log?.(`Auto-bind failed: ${(error as Error).message}`);
        });
    });

    if (stop) this.#watchers.set(record.id, stop);

    return { deviceId: record.id, kind, driver: device, device, link };
  }

  /**
   * Binds a saved device to a station on the shared host.
   *
   * The choice is written back to the record by the caller's `onBound`, because
   * where a device is reached is a property of that device — not of a file the
   * whole server shares.
   */
  async bind(deviceId: SavedDeviceId, station: StationId): Promise<void> {
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
    const taken = this.#ownerOf(station, deviceId);
    if (taken) throw new Error(`Another saved device is already bound to ${station}`);

    const previous = this.#bound.get(deviceId) ?? null;
    this.#bound.set(deviceId, station);
    this.#released.delete(deviceId);

    try {
      // The session already knows which transport this device uses; a bind
      // moves it to a different station on the same radio, not to a different
      // radio. Changing transport is `rebind`.
      const host = await this.hostFor(session.kind as ServerTransportKind);
      if (!host) throw new Error(`The ${session.kind} transport is not available`);

      await session.link?.close();

      const link = await host.open(station);
      session.device?.retarget(link);
      session.device?.reset();

      this.#sessions.set(deviceId, { ...session, link });
      this.deps.onBound?.(deviceId, session.kind, station);
    } catch (error) {
      // Releasing the claim matters as much as making it: a station left
      // reserved by a bind that failed is one nothing else may ever take.
      this.#bound.set(deviceId, previous);
      throw error;
    }
  }

  async unbind(deviceId: SavedDeviceId): Promise<void> {
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

  async close(deviceId: SavedDeviceId): Promise<void> {
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

  #refuse(deviceId: SavedDeviceId, reason: string): void {
    this.#refusals.set(deviceId, reason);
    this.deps.log?.(`No link for ${deviceId}: ${reason}`);
  }

  /** Which other saved device has claimed this station, if any. */
  #ownerOf(station: StationId, except: SavedDeviceId): SavedDeviceId | null {
    for (const [id, bound] of this.#bound) {
      if (id !== except && bound && sameStation(bound, station)) return id;
    }
    return null;
  }
}
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
