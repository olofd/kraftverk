import { ApiError, type ConnectionView, type DeviceView, type KraftverkApi, type PolicyValueView } from '@kraftverk/api-contract';
import { clientId as asClientId, isSimulated, placesOf, type AuditRecord, type ClientId, type DeviceSession, type DeviceStore, type PolicyValues, type Reading, type SavedDeviceId, type ScopedHttp } from '@kraftverk/device-sdk';
import { ActionGateway, Confirmations } from '@kraftverk/gateway';
import { LiveBus, SessionManager, toHold, toolsOf, withInUse, type DeviceEventMessage } from '@kraftverk/holder';
import { AppState, ConnectionStore, databaseLedger, DeviceCatalog, deviceStore, LastHeard, LinkStore, SendQueue, type DeviceRecord, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';

import type { Installed } from '../hub.ts';
import { SetupService } from '../setup/index.ts';
import { unref } from '../timers.ts';
import { holdingApi } from './api.ts';

/**
 * What an app holds for a server's home (docs/PLAN-SHARED-CORE.md, phase 6):
 * the ways in to the server's devices that this app reaches itself — its
 * own Bluetooth — beside the server's. The server stays the home's master:
 * it keeps the devices, their history and their automations. This holds
 * the connections that are this app's, with the same session manager and
 * the same gateway the home runs, and sends what they say to the server,
 * queued while it is away.
 *
 * Its `api` is the server's `KraftverkApi` with what this app holds wrapped
 * in: a view carries this app's own readings for a device it holds, a
 * command to one goes through this app's gateway, a way it holds is set up
 * here, its secrets kept here. The screens ask it as they ask any home.
 *
 * What it keeps is kept in the app's own database: the devices it holds a
 * way to, as the server has them; that way's secrets, sealed; what each
 * device's session keeps; the gateway's memory; what is owed to the
 * server; and what the server last said (`heard`). A restart loses none of
 * it, and with the server away the app still reaches what it holds, and
 * shows the rest as the server last said it — read only, and saying so.
 */

/** How often what is owed is sent, and how often the server is asked what this app holds. */
const SEND_MS = 20_000;
const REFRESH_MS = 5 * 60_000;
/** At most this many of each kind are kept owed, the newest: a server away for weeks does not fill a phone. */
const KEEP_OWED = { readings: 10_000, event: 1000, audit: 1000, store: 1000 } as const;
/** At most this many readings go up in one call. */
const READINGS_PER_CALL = 2000;
/** What the server refuses for good — no such device, not this app's, too large — is not sent again. */
const REFUSED_FOR_GOOD = new Set(['not-found', 'forbidden', 'conflict', 'invalid', 'too-large', 'not-allowed']);

const APP_ID = 'holding.app';
const POLICY = 'holding.policy';

export type HoldingOptions = {
  /** The server's home, as the person signed in on this app asks it. */
  home: KraftverkApi;
  /** This app's own database for it, its schema prepared: where what the holding keeps is kept. */
  database: SqlDatabase;
  /** How the secrets of the ways it holds are sealed at rest: this app's key. */
  secrets: SecretsAtRest;
  /** What this app has installed, and its transports where it runs. */
  installed: Installed;
  /** What this app is called in "held by …", and where it runs. */
  app: { name: string; platform: 'web' | 'native' };
  /** Every write to hardware refused: until someone allows writes from this app. A simulated device reaches no hardware. */
  readOnly: () => boolean;
  /** For a setup helper that calls a vendor's API once — fetching a key. */
  http: ScopedHttp;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** How often what is owed is sent: a test's own. */
  sendEveryMs?: number;
};

/** What goes up with a device's readings: the way it was read by, who it said it is, and what it is when it says so itself. */
type ReadingsOwed = { connectionId: string; identity: string | null; readings: Reading[]; description?: DeviceView['description']; info?: DeviceView['info'] };
type EventOwed = { connectionId: string; event: DeviceEventMessage };
type StoreOwed = { connectionId: string; key: string; value: unknown };

export class Holding {
  readonly home: KraftverkApi;
  readonly db: SqlDatabase;
  readonly installed: Installed;
  readonly readOnly: () => boolean;
  readonly app: HoldingOptions['app'];

  readonly state: AppState;
  readonly catalog: DeviceCatalog;
  readonly connections: ConnectionStore;
  readonly queue: SendQueue;
  /** What the server last said, by what was asked: shown while it cannot be reached. */
  readonly heard: LastHeard;
  readonly bus = new LiveBus();
  readonly sessions: SessionManager;
  readonly gateway: ActionGateway;
  readonly setup: SetupService;
  /** The tokens a person's yes to a tool that cannot be undone is sent back with. */
  readonly yes = new Confirmations();
  /** Everything the server answers, with what this app holds wrapped in. */
  readonly api: KraftverkApi;

  /** The server's last word on each device: what the gateway checks against for one this app does not hold. */
  #seen = new Map<SavedDeviceId, DeviceView>();
  /** The devices whose way this app should hold now: its own, while nothing above it reaches them. */
  #holdNow = new Set<SavedDeviceId>();
  /** Per device and reading, the minute last owed: history keeps one a minute. */
  #owedMinute = new Map<string, number>();
  #describedOwed = new Map<string, string>();
  #log: NonNullable<HoldingOptions['log']>;
  #timers: ReturnType<typeof setInterval>[] = [];
  #sending: Promise<void> | null = null;
  #sendEveryMs: number;

  constructor(options: HoldingOptions) {
    const db = options.database;
    this.home = options.home;
    this.db = db;
    this.installed = options.installed;
    this.readOnly = options.readOnly;
    this.app = options.app;
    this.#sendEveryMs = options.sendEveryMs ?? SEND_MS;
    this.#log = options.log ?? ((level, message) => console[level === 'info' ? 'log' : level](message));
    const { types, protocols, transports } = options.installed;

    this.state = new AppState(db);
    this.catalog = new DeviceCatalog(db);
    this.connections = new ConnectionStore(db, options.secrets);
    this.queue = new SendQueue(db);
    this.heard = new LastHeard(db);
    const { catalog, connections, queue } = this;

    const record = (entry: AuditRecord) => this.owe('audit', null, entry);
    this.sessions = new SessionManager({
      platform: transports.platform,
      owner: 'client',
      types,
      protocols,
      transports,
      // Every way kept here is this app's own; it is held while nothing above it reaches the device.
      connections: (deviceId) => (this.#holdNow.has(deviceId) ? connections.forDevice(deviceId) : []),
      holds: () => true,
      secret: (connectionId, field) => connections.secret(connectionId, field),
      secretFields: (connectionId) => connections.secretFields(connectionId),
      onConnected: (connectionId) => connections.touch(connectionId),
      store: (deviceId) => this.#storeOf(deviceId),
      readOnly: options.readOnly,
      // Frames nobody has described are for a server started to bring up a unit, never for an app.
      allowRawFrames: false,
      record,
      // Kept by the server, as its own devices' are: sent with the readings.
      onEvent: (deviceId, event) => {
        const connection = this.sessions.inUse(deviceId);
        if (connection) this.owe('event', deviceId, { connectionId: connection.id, event } satisfies EventOwed);
      },
      bus: this.bus,
      log: (message) => this.#log('info', `[holding] ${message}`),
    });
    const { sessions } = this;

    /** The same gateway the home runs, over what this app holds — and the server's word on what it does not, to verify a switch against. */
    this.gateway = new ActionGateway({
      device: (id) => {
        const seen = this.#seen.get(id);
        const held = catalog.active(id);
        if (held && this.#holdNow.has(id)) return { name: held.name, session: sessions.get(id), description: sessions.description(held), offline: sessions.health(held).detail };
        return seen ? { name: seen.name, session: viewSession(seen), description: seen.description, offline: seen.health.detail } : null;
      },
      linksFrom: (id, part) =>
        (this.#seen.get(id)?.links ?? []).filter((link) => link.role === 'source' && link.part === part).map((link) => ({ kind: link.kind, target: { device: link.other.id, part: link.other.part } })),
      isReadOnly: (id) => options.readOnly() && !sessions.simulated(id),
      readOnlyReason: 'Writes from this app are off: allow them in App settings',
      record,
      ledger: databaseLedger(db),
      policyValues: () => this.policyValues(),
    });

    // A way this app holds is set up here, over its own radio: the server judges what it finds, and keeps the device.
    this.setup = new SetupService({ db, record, types, protocols, transports, catalog, connections, links: new LinkStore(db), sessions, http: options.http });
    this.api = holdingApi(this);
  }

  /** This app, as the server knows it; null until it has said who it is. */
  get appId(): ClientId | null {
    const kept = this.state.get(APP_ID);
    return kept ? asClientId(kept) : null;
  }

  /**
   * Starts holding: the transports this app runs, who it is to the server,
   * what it holds there — or, with the server away, what it held when it
   * last heard — and sending what is owed.
   */
  async start(): Promise<void> {
    await this.installed.transports.startAll(this.transportsHere());
    await this.register().catch((error: unknown) => this.#log('warn', `[holding] the server did not hear who this app is: ${(error as Error).message}`));
    const list = await this.refresh();
    if (!list) {
      // Away: what this app held when it last heard, it holds still.
      this.#holdNow = new Set(this.catalog.list().map((device) => device.id));
      await this.sessions.sync(this.catalog.list());
    }
    await this.kept('policy', () => this.home.policy.list())
      .then(({ answer }) => this.keepPolicy(answer))
      .catch(() => undefined);
    const send = setInterval(() => void this.send(), this.#sendEveryMs);
    const refresh = setInterval(() => void this.refresh(), REFRESH_MS);
    unref(send);
    unref(refresh);
    this.#timers = [send, refresh];
  }

  async stop(): Promise<void> {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.setup.stop();
    await this.send().catch(() => undefined);
    await Promise.allSettled([this.sessions.closeAll(), this.installed.transports.stopAll()]);
  }

  /** The transports this app can hold a way over where it runs. */
  transportsHere(): string[] {
    const { transports } = this.installed;
    return transports.definitions().filter((definition) => definition.platforms.includes(transports.platform)).map((definition) => definition.id);
  }

  /** Says who this app is to the server, and what it reaches devices over. Every start, under the id it was given before. */
  async register(): Promise<ClientId> {
    const known = this.appId;
    const app = await this.home.apps.register({ ...(known ? { id: known } : {}), name: this.app.name, platform: this.app.platform, transports: this.transportsHere() });
    this.state.set(APP_ID, app.id);
    return app.id;
  }

  /** Asks the server what it has, keeps what it said, and holds what is this app's to hold. Null when it cannot be asked. */
  async refresh(): Promise<DeviceView[] | null> {
    try {
      const list = await this.home.devices.list();
      this.heard.keep('devices', list);
      await this.hold(list);
      return list;
    } catch {
      return null;
    }
  }

  /**
   * Asks the server, and keeps what it answers; with the server out of
   * reach, what it last answered, and when — or, never heard, the refusal.
   * Anything else the server says no to is said as it is.
   */
  async kept<T>(what: string, ask: () => Promise<T>): Promise<{ answer: T; heardAt: string | null }> {
    try {
      const answer = await ask();
      this.heard.keep(what, answer);
      return { answer, heardAt: null };
    } catch (error) {
      const last = error instanceof ApiError && error.kind === 'unavailable' ? this.heard.get<T>(what) : null;
      if (!last) throw error;
      return { answer: last.body, heardAt: last.heardAt };
    }
  }

  /**
   * A device as the server last said it, while it cannot be reached: what it
   * read then, and its health saying so — unless this app holds it, and
   * says how it is now.
   */
  lastHeard(device: DeviceView): DeviceView {
    if (this.holds(device.id)) return device;
    return { ...device, health: { ...device.health, status: 'offline', detail: 'Your server cannot be reached: this is what it last said' }, connections: device.connections.map((connection) => ({ ...connection, reachable: null })) };
  }

  /**
   * Holds, of what the server listed, what is this app's: a device with a
   * way this app holds is kept here as the server has it, and that way is
   * held while nothing above it reaches the device (`toHold`). A device it
   * no longer has a way to is let go, with what was kept for it.
   */
  async hold(list: readonly DeviceView[]): Promise<void> {
    const me = this.appId;
    this.#seen = new Map(list.map((device) => [device.id, device]));
    const mine = list.filter((device) => device.connections.some((connection) => this.#mine(connection, me)));
    const keep = new Set(mine.map((device) => device.id));
    for (const kept of this.catalog.list()) {
      if (keep.has(kept.id)) continue;
      await this.sessions.close(kept.id);
      this.catalog.deleteForever(kept.id);
    }
    for (const device of mine) {
      this.catalog.mirror(recordOf(device));
      const ways = device.connections.filter((connection) => this.#mine(connection, me));
      for (const gone of this.connections.forDevice(device.id)) if (!ways.some((way) => way.id === gone.id)) this.connections.remove(gone.id);
      for (const way of ways) this.connections.mirror({ ...way, deviceId: device.id, createdAt: device.addedAt });
    }
    this.#holdNow = new Set(mine.filter((device) => toHold(device, me)).map((device) => device.id));
    await this.sessions.sync(this.catalog.list());
  }

  /** Whether a way is this app's own. */
  #mine(connection: ConnectionView, me: ClientId | null): boolean {
    return (connection.heldBy.kind === 'client' || connection.heldBy.kind === 'this-app') && connection.heldBy.id === me;
  }

  /** Whether this app holds a device now: a session of its own is open for it, or about to be. */
  holds(deviceId: SavedDeviceId): boolean {
    return this.#holdNow.has(deviceId) && this.catalog.active(deviceId) !== null;
  }

  /** Whether a way is one this app holds. */
  owns(connectionId: string): boolean {
    return this.connections.get(connectionId) !== null;
  }

  /**
   * A device as the server says it, with what this app knows first: a way
   * this app holds is said to be its own, with the secrets it keeps; and
   * while it holds the device, its readings, health and tools are this
   * app's, read just now.
   */
  view(device: DeviceView): DeviceView {
    const me = this.appId;
    const connections = device.connections.map((connection) =>
      this.#mine(connection, me) ? { ...connection, heldBy: { kind: 'this-app' as const, id: me!, name: connection.heldBy.kind === 'home' ? this.app.name : connection.heldBy.name }, secrets: this.connections.secretFields(connection.id) } : connection
    );
    const held = this.catalog.active(device.id);
    if (!held || !this.#holdNow.has(device.id)) return { ...device, connections };
    const session = this.sessions.get(device.id);
    const health = this.sessions.health(held);
    const inUse = this.sessions.inUse(device.id) ?? this.connections.forDevice(device.id)[0] ?? null;
    return {
      ...device,
      readings: session?.readings() ?? device.readings,
      health,
      tools: session ? toolsOf(this.installed.types.get(device.typeId)?.tools, session).map(({ name, spec }) => ({ name, ...spec })) : device.tools,
      // What this app holds, it knows first: whether its own way reaches the device.
      connections: withInUse(
        connections.map((connection) => (connection.id === inUse?.id ? { ...connection, reachable: health.status === 'connected' } : connection)),
        inUse?.id ?? null
      ),
    };
  }

  /** A way's secrets, kept here and never sent: write-only, and held to what its method declares. */
  async setSecrets(connectionId: string, secrets: Record<string, string>): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new ApiError('not-found', 'No such connection');
    this.connections.setSecrets(connectionId, secrets);
    // Reopened, so the new key is used now.
    await this.sessions.close(connection.deviceId);
    await this.sessions.sync(this.catalog.list());
  }

  /** Lets go of a device the server no longer has, or no longer has a way of this app's to. */
  async forget(deviceId: SavedDeviceId): Promise<void> {
    await this.sessions.close(deviceId);
    if (this.catalog.get(deviceId)) this.catalog.deleteForever(deviceId);
    this.#holdNow.delete(deviceId);
  }

  /** Writes allowed or refused again: sessions reopen under the new rule. */
  async reopen(): Promise<void> {
    for (const device of this.catalog.list()) await this.sessions.close(device.id);
    await this.sessions.sync(this.catalog.list());
  }

  /** How much is a load, and the other values the home decides: the server's, kept for when it cannot be asked. */
  policyValues(): PolicyValues {
    try {
      return JSON.parse(this.state.get(POLICY) ?? '{}') as PolicyValues;
    } catch {
      return {};
    }
  }

  keepPolicy(values: readonly PolicyValueView[]): void {
    this.state.set(POLICY, JSON.stringify(Object.fromEntries(values.map((value) => [value.name, value.value]))));
  }

  // --- what is owed to the server -------------------------------------------------

  /** Owed to the server, kept until it has it. */
  owe(kind: 'readings' | 'event' | 'audit' | 'store', deviceId: string | null, body: unknown): void {
    // The server adds who sent it: what it is about goes as it is.
    const owed = kind === 'audit' ? (({ actor: _actor, ...entry }: AuditRecord) => entry)(body as AuditRecord) : body;
    this.queue.add(kind, deviceId, owed);
    this.queue.trim(kind, KEEP_OWED[kind]);
  }

  /** What a device's session keeps: here, and owed to the server, which keeps it with the device. */
  #storeOf(deviceId: SavedDeviceId): DeviceStore {
    const here = deviceStore(this.db, deviceId);
    const owe = (key: string, value: unknown) => {
      const connection = this.sessions.inUse(deviceId) ?? this.connections.forDevice(deviceId)[0];
      if (connection) this.owe('store', deviceId, { connectionId: connection.id, key, value } satisfies StoreOwed);
    };
    return {
      get: (key) => here.get(key),
      set: (key, value) => {
        here.set(key, value);
        owe(key, value);
      },
      delete: (key) => {
        here.delete(key);
        owe(key, null);
      },
    };
  }

  /** What each device this app holds has read since it was last owed: one a minute per reading, as history keeps it. */
  #collect(): void {
    for (const deviceId of this.sessions.opened()) {
      const session = this.sessions.get(deviceId);
      const connection = this.sessions.inUse(deviceId);
      const record = this.catalog.active(deviceId);
      if (!session || !connection || !record) continue;
      const readings = session.readings().filter((reading) => {
        if (!reading.at || reading.value === null) return false;
        const minute = Math.floor(Date.parse(reading.at) / 60_000);
        const key = `${deviceId}:${reading.key}`;
        if (this.#owedMinute.get(key) === minute) return false;
        this.#owedMinute.set(key, minute);
        return true;
      });
      // Only a device's own description goes: its type's the server has from when it was added.
      const own = this.sessions.describedBy(record) === 'device' ? this.sessions.description(record) : null;
      const said = own ? JSON.stringify(own) : null;
      const describe = said !== null && said !== this.#describedOwed.get(deviceId);
      if (!readings.length && !describe) continue;
      if (describe) this.#describedOwed.set(deviceId, said);
      this.owe('readings', deviceId, {
        connectionId: connection.id,
        identity: session.identity?.().id ?? null,
        readings,
        ...(describe ? { description: own!, info: this.sessions.info(record) } : {}),
      } satisfies ReadingsOwed);
    }
  }

  /**
   * Sends what is owed, in order: the timeline, each device's readings and
   * events together, what sessions kept. What the server cannot take now
   * waits for the next time; what it refuses for good is let go. One send at
   * a time; one asked for while another runs waits for it.
   */
  send(): Promise<void> {
    this.#sending ??= this.#send().finally(() => {
      this.#sending = null;
    });
    return this.#sending;
  }

  async #send(): Promise<void> {
    this.#collect();
    const me = this.appId ?? (await this.register().catch(() => null));
    if (!me) return;
    const owed = this.queue.next(1000);
    /** Sent, or refused for good: true; the server away: false, and the rest waits. */
    const attempt = async (ids: number[], work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work();
        this.queue.done(ids);
        return true;
      } catch (error) {
        if (error instanceof ApiError && REFUSED_FOR_GOOD.has(error.kind)) {
          this.#log('warn', `[holding] the server refused what this app sent: ${error.message}`);
          this.queue.done(ids);
          return true;
        }
        return false;
      }
    };

    const audit = owed.filter((each) => each.kind === 'audit');
    if (audit.length && !(await attempt(audit.map((each) => each.id), () => this.home.held.audit(me, audit.map((each) => each.body as never))))) return;

    const byDevice = new Map<string, typeof owed>();
    for (const each of owed) if ((each.kind === 'readings' || each.kind === 'event') && each.deviceId) byDevice.set(each.deviceId, [...(byDevice.get(each.deviceId) ?? []), each]);
    for (const [deviceId, rows] of byDevice) {
      const sending: typeof rows = [];
      let count = 0;
      for (const row of rows) {
        const size = row.kind === 'readings' ? (row.body as ReadingsOwed).readings.length : 1;
        if (sending.length && count + size > READINGS_PER_CALL) break;
        sending.push(row);
        count += size;
      }
      const readings = sending.filter((row) => row.kind === 'readings').map((row) => row.body as ReadingsOwed);
      const events = sending.filter((row) => row.kind === 'event').map((row) => (row.body as EventOwed).event);
      const last = (readings.at(-1) ?? null) as ReadingsOwed | null;
      const described = [...readings].reverse().find((each) => each.description);
      const connectionId = last?.connectionId ?? (sending.at(-1)!.body as EventOwed).connectionId;
      const sent = await attempt(
        sending.map((row) => row.id),
        () =>
          this.home.held.readings(deviceId as SavedDeviceId, {
            clientId: me,
            connectionId,
            identity: [...readings].reverse().find((each) => each.identity)?.identity ?? null,
            readings: readings.flatMap((each) => each.readings),
            ...(described?.description ? { description: described.description, info: described.info ?? null } : {}),
            ...(events.length ? { events: events.map((event) => ({ id: event.id, part: event.part, data: event.data as never, at: event.at })) } : {}),
          })
      );
      if (!sent) return;
    }

    for (const row of owed.filter((each) => each.kind === 'store' && each.deviceId)) {
      const { connectionId, key, value } = row.body as StoreOwed;
      if (!(await attempt([row.id], () => this.home.held.keep(row.deviceId as SavedDeviceId, key, { clientId: me, connectionId, value })))) return;
    }
  }
}

/**
 * A device this app does not hold, as the gateway sees it: what the server
 * says it reads. Enough to verify a switch against a station the server
 * holds — its mains presence is a standard meaning, whoever reads it. It
 * takes no commands from here.
 */
function viewSession(device: DeviceView): DeviceSession {
  return {
    health: () => device.health,
    readings: () => device.readings,
    command: async () => ({ accepted: false, error: 'This app does not hold that device' }),
    close: async () => {},
  };
}

/** A device as the server has it, as it is kept here. */
function recordOf(device: DeviceView): DeviceRecord {
  return {
    id: device.id,
    key: device.key,
    typeId: device.typeId,
    identity: device.identity,
    name: device.name,
    config: device.config,
    addedAt: device.addedAt,
    removedAt: device.removedAt,
    description: device.description,
    descriptionSource: device.descriptionSource,
    info: device.info,
    picture: device.picture === 'type:0' ? null : device.picture,
  };
}

/** Whether a way can be held by this app where it runs: its transport has an entry here, its protocol is installed, and it is not kept to a server. */
export function holdableHere(installed: Installed, method: Parameters<typeof placesOf>[0]): boolean {
  if (isSimulated(method) || method.serverOnly) return false;
  const { transports, protocols } = installed;
  return placesOf(method, transports.definition(method.transport)).includes(transports.platform) && Boolean(protocols.get(method.protocol)?.bindings[method.transport]);
}

/** What an app holds for a server's home, made from what the place gives it: `start()` it, ask its `api`, `stop()` it. */
export const createHolding = (options: HoldingOptions): Holding => new Holding(options);
