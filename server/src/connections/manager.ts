import { sameStation, stationId, type SavedDeviceId, type StationId } from '@kraftverk/plugin-sdk';

import { boundStation, type DeviceRecord } from '../devices/catalog.ts';
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
  /** Which link this process can hold, decided by the launch flag. */
  kind: LinkKind;
  readOnly: boolean;
  /** Built once, on first use: the radio and the broker are process-wide. */
  host: () => TransportHost;
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
      const host = (await this.link())!;
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
