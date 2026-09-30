import { Platform } from 'react-native';

import type { DeviceSession, DeviceStore, PolicyValues, SavedDeviceId } from '@kraftverk/device-sdk';
import { ActionGateway, type GatewayLedger } from '@kraftverk/gateway';
import { Failover } from '@kraftverk/holder';
import { fetchDeviceStore, registerClient, type AuditUpload, type DeviceView } from '@kraftverk/api-client';

import { readPreference, writePreference } from '../lib/preferences';
import type { Mode } from '../state/ServersProvider';
import { LocalCatalog } from './local';
import { legacySecrets, SecretVault } from './vault';
import { AppRegistry } from './registry';
import { HeldSessions, type HeldDevice } from './sessions';
import { Uplink } from './uplink';

/**
 * This app as a holder of connections (docs/ARCHITECTURE.md, step 12).
 *
 * The same pieces the server runs, in the app: the installed device types,
 * protocols and transports; a session for each connection this app holds;
 * and the action gateway's rules, applied here to what this app switches. In
 * server mode it registers itself, and sends its readings, audit entries and
 * store writes up; in local mode it keeps its own devices.
 *
 * Writes from this app start refused, every launch, and are allowed only by
 * someone who says so: a phone should not be the easiest way to switch mains.
 */

const clientKey = (server: string) => `kraftverk.client.${server}`;
const storeKey = (deviceId: string) => `kraftverk.store.${deviceId}`;

/** What this app is called in "held by …": the browser, or the phone. */
function clientName(): string {
  if (Platform.OS !== 'web') return Platform.OS === 'ios' ? 'This iPhone' : 'This Android phone';
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const system = /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'a Mac' : /Android/.test(agent) ? 'Android' : /Linux/.test(agent) ? 'Linux' : null;
  return system ? `${browser} on ${system}` : browser;
}

/**
 * A device this app does not hold, as the gateway sees it: what the list says
 * it reads, with the description it was served with. Enough to verify a switch
 * against a station the server holds — its mains presence is a standard
 * meaning, whoever reads it. It takes no commands from here.
 */
function viewSession(device: DeviceView): DeviceSession {
  return {
    health: () => device.health,
    readings: () => device.readings,
    command: async () => ({ accepted: false, error: 'This app does not hold that device' }),
    close: async () => {},
  };
}

export class AppRuntime {
  readonly registry: AppRegistry;
  readonly sessions: HeldSessions;
  readonly vault: SecretVault;
  readonly local: LocalCatalog;
  readonly gateway: ActionGateway;
  readonly uplink: Uplink | null;
  clientId: string | null = null;
  #allowWrites = false;
  /** How much is a load, and the other values the home decides: the server's, or this app's own in local mode. */
  #policyValues: PolicyValues;
  #policyKey: string;
  #listeners = new Set<() => void>();
  #view = new Map<string, DeviceView>();
  #stores = new Map<string, Record<string, unknown>>();
  /** The holder core's failover: the same two minutes as the server. */
  #failover = new Failover();
  #failoverTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private options: { mode: Mode; server: string | null }) {
    // Sealed secrets, one vault per server and one for local mode. The plaintext an older version kept moves in.
    const place = options.mode === 'local' || !options.server ? 'local' : options.server;
    this.#policyKey = `kraftverk.policy.${place}`;
    this.#policyValues = JSON.parse(readPreference(this.#policyKey) ?? '{}') as PolicyValues;
    this.vault = new SecretVault({ storageKey: `kraftverk.vault.${place}`, ...(options.server ? legacySecrets(`kraftverk.secrets.${options.server}`) : {}) });
    this.local = new LocalCatalog(this.vault);
    // Sessions opened before the vault was read reopen with their secrets once it has been.
    void this.vault.ready().then(() => this.#changed());
    // The server adds who sent it; what it is about goes as it is.
    const audit = ({ actor: _actor, ...entry }: AuditUpload & { actor?: string }) => {
      if (this.uplink) this.uplink.audit(entry);
      else console.log(`[audit] ${entry.summary}`);
    };
    this.registry = new AppRegistry({
      env: {},
      log: (level, message) => console[level === 'info' ? 'log' : level](message),
      audit: (entry) => audit({ at: new Date().toISOString(), ...entry }),
    });
    this.uplink =
      options.mode === 'server' && options.server
        ? new Uplink({
            clientId: () => this.clientId,
            key: `kraftverk.uplink.${options.server}`,
            collect: () =>
              this.sessions.all().flatMap((held) => {
                const session = this.sessions.get(held.deviceId);
                if (!session) return [];
                // Who it says it is, so a device saved before it answered learns its identity (§4.3);
                // and what it is now, so a pack plugged in is kept on the server too.
                return [
                  {
                    deviceId: held.deviceId,
                    connectionId: held.connection.id,
                    identity: session.identity?.().id ?? null,
                    readings: session.readings(),
                    // Only a device's own: its type's, the server has from when it was added.
                    description: this.sessions.describedBy(held.deviceId) === 'device' ? this.sessions.description(held.deviceId) : null,
                    info: this.sessions.info(held.deviceId),
                  },
                ];
              }),
          })
        : null;
    this.sessions = new HeldSessions({
      registry: this.registry,
      readOnly: () => !this.#allowWrites,
      // Kept by the server as its own devices' events are; with no server, they are only heard.
      event: (held, event) => (this.uplink ? this.uplink.event(held.deviceId, held.connection.id, event) : console.log(`[event] ${held.name}: ${event.id}`)),
      onConnected: (held) => {
        if (options.mode === 'local') this.local.touch(held.connection.id);
      },
      onMismatch: (held, said) =>
        audit({ at: new Date().toISOString(), kind: 'device.mismatch', resourceKind: 'device', resource: held.deviceId, summary: `${held.name}'s connection from this app reaches ${said} instead`, detail: { expected: held.identity } }),
      onChange: () => this.#changed(),
      failover: this.#failover,
    });
    this.gateway = new ActionGateway({
      device: (id: SavedDeviceId) => {
        const held = this.sessions.held(id);
        const seen = this.#view.get(id);
        if (held) {
          const description = this.sessions.description(id) ?? seen?.description ?? { attributes: [] };
          return { name: held.name, session: this.sessions.get(id), description, offline: this.sessions.health(id)?.detail ?? 'Not connected' };
        }
        return seen ? { name: seen.name, session: viewSession(seen), description: seen.description, offline: seen.health.detail } : null;
      },
      linksFrom: (id, part) =>
        (this.#view.get(id)?.links ?? [])
          .filter((link) => link.role === 'source' && link.part === part)
          .map((link) => ({ kind: link.kind, target: { device: link.other.id, part: link.other.part } })),
      // Every hardware write, while writes from this app are off; a simulated device has no hardware.
      isReadOnly: (id) => !this.#allowWrites && !this.sessions.simulated(id),
      readOnlyReason: 'Writes from this app are off: allow them in App settings',
      record: (entry) => audit(entry),
      ledger: preferenceLedger,
      policyValues: () => this.#policyValues,
    });
    this.uplink?.start();
    if (options.mode === 'local') this.#failoverTimer = setInterval(() => this.#failOver(), 15_000);
  }

  get mode(): Mode {
    return this.options.mode;
  }

  get policyValues(): PolicyValues {
    return this.#policyValues;
  }

  /** What the home has set — from the server, or chosen here in local mode — kept for the next start. */
  setPolicyValues(values: PolicyValues): void {
    this.#policyValues = values;
    writePreference(this.#policyKey, JSON.stringify(values));
    this.#changed();
  }

  get allowWrites(): boolean {
    return this.#allowWrites;
  }

  /** Allows writes from this app, or refuses them again. Sessions reopen with the new rule. */
  setAllowWrites(allowed: boolean): void {
    this.#allowWrites = allowed;
    void this.sessions.sync(this.sessions.all());
    this.#changed();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** Says who this app is to the server, and what it can reach devices over. Every start. */
  async register(): Promise<string | null> {
    if (this.options.mode !== 'server' || !this.options.server) return null;
    const key = clientKey(this.options.server);
    const client = await registerClient({ id: readPreference(key) ?? undefined, name: clientName(), platform: Platform.OS === 'web' ? 'web' : 'native', transports: this.registry.held() });
    writePreference(key, client.id);
    this.clientId = client.id;
    this.#changed();
    void this.uplink?.flush();
    return client.id;
  }

  /**
   * The secrets of a connection this app holds: kept here, sealed, and never
   * sent anywhere (docs/ARCHITECTURE.md §4.3, step 21). One vault per server,
   * and one for local mode, which its catalog keeps its secrets in too.
   */
  heldSecrets(connectionId: string): Record<string, string> {
    return this.vault.get(connectionId);
  }

  setHeldSecrets(connectionId: string, secrets: Record<string, string>): void {
    this.vault.set(connectionId, secrets);
    this.#changed();
  }

  /** The devices the list shows, for what the gateway checks against. */
  setView(devices: readonly DeviceView[]): void {
    this.#view = new Map(devices.map((device) => [device.id, device]));
  }

  /** A device's store for a session this app holds: a copy here, kept with the holder's record. */
  storeFor(deviceId: string, connectionId: string): DeviceStore {
    if (this.options.mode === 'local') {
      return {
        get: <T>(key: string) => (this.local.store(deviceId)[key] as T | undefined) ?? null,
        set: (key, value) => this.local.setStore(deviceId, key, value),
        delete: (key) => this.local.setStore(deviceId, key, null),
      };
    }
    const values = () => {
      let cached = this.#stores.get(deviceId);
      if (!cached) {
        try {
          cached = JSON.parse(readPreference(storeKey(deviceId)) ?? '{}') as Record<string, unknown>;
        } catch {
          cached = {};
        }
        this.#stores.set(deviceId, cached);
      }
      return cached;
    };
    const save = (next: Record<string, unknown>) => {
      this.#stores.set(deviceId, next);
      writePreference(storeKey(deviceId), JSON.stringify(next));
    };
    return {
      get: <T>(key: string) => (values()[key] as T | undefined) ?? null,
      set: (key, value) => {
        save({ ...values(), [key]: value });
        this.uplink?.store(deviceId, connectionId, key, value);
      },
      delete: (key) => {
        const { [key]: _gone, ...rest } = values();
        save(rest);
        this.uplink?.store(deviceId, connectionId, key, null);
      },
    };
  }

  /** Brings the local copy of a device's store up to date before its session opens. */
  async refreshStore(deviceId: string): Promise<void> {
    if (this.options.mode !== 'server') return;
    const values = await fetchDeviceStore(deviceId).catch(() => null);
    if (values) {
      this.#stores.set(deviceId, values);
      writePreference(storeKey(deviceId), JSON.stringify(values));
    }
  }

  hold(devices: readonly HeldDevice[]): Promise<void> {
    return this.sessions.sync(devices);
  }

  /**
   * Local mode's half of the active-connection rule (docs/DATA-MODEL.md §4):
   * a connection down for two minutes, on a device with another, is passed
   * over for a while and the next one tried — as the server does with its own.
   */
  #failOver(): void {
    for (const held of this.sessions.all()) {
      if (this.#failover.due(held.connection.id, this.local.connections(held.deviceId).length > 1)) this.#changed();
    }
  }

  /** Whether a connection is being passed over after failing, in local mode. */
  avoided(connectionId: string): boolean {
    return this.#failover.avoided(connectionId);
  }

  async stop(): Promise<void> {
    if (this.#failoverTimer) clearInterval(this.#failoverTimer);
    this.uplink?.stop();
    await this.uplink?.flush();
    await this.sessions.closeAll();
    await this.registry.stopAll();
  }
}

/** The gateway's memory of the devices this app holds, in its own storage: a restart of the app is no way around the dwell. */
const preferenceLedger: GatewayLedger = {
  lastSwitch: (device, part) => millis(readPreference(`kraftverk.gateway.switched.${device}:${part}`)),
  switched: (device, part, at) => writePreference(`kraftverk.gateway.switched.${device}:${part}`, String(at)),
  lastWrite: (device, attribute) => millis(readPreference(`kraftverk.gateway.written.${device}:${attribute}`)),
  wrote: (device, attribute, at) => writePreference(`kraftverk.gateway.written.${device}:${attribute}`, String(at)),
};

function millis(kept: string | null): number | null {
  const value = kept === null ? Number.NaN : Number(kept);
  return Number.isFinite(value) ? value : null;
}
