import { Platform } from 'react-native';

import type { CapabilityImpl, CapabilityName, DeviceSession, DeviceStore, SavedDeviceId } from '@kraftverk/device-sdk';
import { ActionGateway, type AuditEntry } from '@kraftverk/gateway';
import { Failover } from '@kraftverk/holder';
import { fetchDeviceStore, registerClient, type DeviceView } from '@kraftverk/api-client';

import { readPreference, writePreference } from '../lib/preferences';
import type { Mode } from '../state/ServersProvider';
import { LocalCatalog } from './local';
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
 * it reads. Enough to verify a switch against a station the server holds — its
 * mains presence is a standard measurement, whoever reads it.
 */
function viewSession(device: DeviceView): DeviceSession {
  const byMetric = (metric: string) => {
    const key = device.measurements.find((spec) => spec.metric === metric)?.key;
    return key ? (device.readings.find((reading) => reading.key === key) ?? null) : null;
  };
  const acInput: CapabilityImpl['acInput'] = {
    read: () => {
      const present = byMetric('grid.present');
      if (!present?.at) return null;
      const watts = byMetric('power.in.ac');
      return { present: typeof present.value === 'boolean' ? present.value : present.value === null ? null : present.value !== 0, watts: typeof watts?.value === 'number' ? watts.value : null, at: present.at };
    },
  };
  return {
    health: () => device.health,
    readings: () => device.readings,
    capability: (<N extends CapabilityName>(name: N) => (name === 'acInput' && device.capabilities.includes('acInput') ? acInput : null) as CapabilityImpl[N] | null) as DeviceSession['capability'],
    close: async () => {},
  };
}

export class AppRuntime {
  readonly registry: AppRegistry;
  readonly sessions: HeldSessions;
  readonly local = new LocalCatalog();
  readonly gateway: ActionGateway;
  readonly uplink: Uplink | null;
  clientId: string | null = null;
  #allowWrites = false;
  #listeners = new Set<() => void>();
  #view = new Map<string, DeviceView>();
  #stores = new Map<string, Record<string, unknown>>();
  /** The holder core's failover: the same two minutes as the server. */
  #failover = new Failover();
  #failoverTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private options: { mode: Mode; server: string | null }) {
    const audit = (entry: Omit<AuditEntry, 'actor'>) => {
      if (this.uplink) this.uplink.audit({ at: entry.at, kind: entry.kind, resource: entry.resource, summary: entry.summary, detail: entry.detail });
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
                // Who it says it is, so a device saved before it answered learns its identity (§4.3).
                return session ? [{ deviceId: held.deviceId, connectionId: held.connection.id, identity: session.identity?.().id ?? null, readings: session.readings() }] : [];
              }),
          })
        : null;
    this.sessions = new HeldSessions({
      registry: this.registry,
      readOnly: () => !this.#allowWrites,
      emit: (held, event) => audit({ at: new Date().toISOString(), kind: `device.${event.level}`, resource: held.deviceId, summary: `${held.name}: ${event.message}`, detail: event.data }),
      onConnected: (held) => {
        if (options.mode === 'local') this.local.touch(held.connection.id);
      },
      onMismatch: (held, said) =>
        audit({ at: new Date().toISOString(), kind: 'device.mismatch', resource: held.deviceId, summary: `${held.name}'s connection from this app reaches ${said} instead`, detail: { expected: held.identity } }),
      onChange: () => this.#changed(),
      failover: this.#failover,
    });
    this.gateway = new ActionGateway({
      device: (id: SavedDeviceId) => {
        const held = this.sessions.held(id);
        if (held) return { name: held.name, session: this.sessions.get(id), offline: this.sessions.health(id)?.detail ?? 'Not connected' };
        const seen = this.#view.get(id);
        return seen ? { name: seen.name, session: viewSession(seen), offline: seen.health.detail } : null;
      },
      feeds: (id) => (this.#view.get(id)?.links.find((link) => link.kind === 'feeds' && link.role === 'source')?.other.id as SavedDeviceId | undefined) ?? null,
      isReadOnly: () => !this.#allowWrites,
      record: (entry) => audit(entry),
      memory: { get: (key) => readPreference(`kraftverk.gateway.${key}`), set: (key, value) => writePreference(`kraftverk.gateway.${key}`, value) },
    });
    this.uplink?.start();
    if (options.mode === 'local') this.#failoverTimer = setInterval(() => this.#failOver(), 15_000);
  }

  get mode(): Mode {
    return this.options.mode;
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
   * The secrets of a connection this app holds: kept here and never sent
   * anywhere (docs/ARCHITECTURE.md §4.3). In local mode the local catalog
   * keeps them with the connection; for a server, this app keeps them itself.
   */
  heldSecrets(connectionId: string): Record<string, string> {
    if (this.options.mode === 'local') return this.local.secrets(connectionId);
    return this.#serverSecrets()[connectionId] ?? {};
  }

  setHeldSecrets(connectionId: string, secrets: Record<string, string>): void {
    if (this.options.mode === 'local') {
      this.local.setSecrets(connectionId, secrets);
    } else if (this.options.server) {
      const all = this.#serverSecrets();
      writePreference(`kraftverk.secrets.${this.options.server}`, JSON.stringify({ ...all, [connectionId]: { ...(all[connectionId] ?? {}), ...secrets } }));
    }
    this.#changed();
  }

  #serverSecrets(): Record<string, Record<string, string>> {
    try {
      return this.options.server ? (JSON.parse(readPreference(`kraftverk.secrets.${this.options.server}`) ?? '{}') as Record<string, Record<string, string>>) : {};
    } catch {
      return {};
    }
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
