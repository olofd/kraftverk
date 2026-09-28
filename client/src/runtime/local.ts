import type { ConfigValues } from '@kraftverk/device-sdk';

import { readPreference, writePreference } from '../lib/preferences';

/**
 * The devices this app keeps for itself, in local mode (docs/DATA-MODEL.md §6).
 *
 * The same shape the server stores — a device, its connections, their
 * secrets, its links, its store — kept in this app's own storage. There is no
 * history here, and nothing runs while the app is closed: that is what a
 * server is for. Removing a device deletes it, because there is no history to
 * keep.
 *
 * In a browser this is `localStorage`, which is not a keychain: a key saved
 * here is readable by anything that can read this origin's storage.
 */

export type LocalDevice = { id: string; typeId: string; name: string; identity: string | null; config: ConfigValues; addedAt: string };
export type LocalConnection = { id: string; deviceId: string; method: string; transport: string; address: string; config: ConfigValues; priority: number; lastConnectedAt: string | null };
export type LocalLink = { id: string; kind: string; sourceId: string; targetId: string };

type Stored = {
  devices: LocalDevice[];
  connections: LocalConnection[];
  links: LocalLink[];
  secrets: Record<string, Record<string, string>>;
  stores: Record<string, Record<string, unknown>>;
};

const KEY = 'kraftverk.local';
const empty = (): Stored => ({ devices: [], connections: [], links: [], secrets: {}, stores: {} });
const id = (prefix: string) => `${prefix}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;

export class LocalCatalog {
  #data: Stored;
  #listeners = new Set<() => void>();

  constructor() {
    this.#data = LocalCatalog.#read();
  }

  static #read(): Stored {
    try {
      const parsed = JSON.parse(readPreference(KEY) ?? 'null') as Partial<Stored> | null;
      return { ...empty(), ...(parsed ?? {}) };
    } catch {
      return empty();
    }
  }

  #write(): void {
    writePreference(KEY, JSON.stringify(this.#data));
    for (const listener of this.#listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  devices(): LocalDevice[] {
    return this.#data.devices;
  }

  device(deviceId: string): LocalDevice | null {
    return this.#data.devices.find((device) => device.id === deviceId) ?? null;
  }

  byIdentity(identity: string): LocalDevice | null {
    return this.#data.devices.find((device) => device.identity === identity) ?? null;
  }

  connections(deviceId: string): LocalConnection[] {
    return this.#data.connections.filter((connection) => connection.deviceId === deviceId).sort((a, b) => a.priority - b.priority);
  }

  links(deviceId?: string): LocalLink[] {
    return deviceId ? this.#data.links.filter((link) => link.sourceId === deviceId || link.targetId === deviceId) : this.#data.links;
  }

  secrets(connectionId: string): Record<string, string> {
    return this.#data.secrets[connectionId] ?? {};
  }

  /** Replaces a connection's secrets: a Tuya plug's local key changes every time it is paired again. */
  setSecrets(connectionId: string, secrets: Record<string, string>): void {
    this.#data = { ...this.#data, secrets: { ...this.#data.secrets, [connectionId]: { ...this.secrets(connectionId), ...secrets } } };
    writePreference(KEY, JSON.stringify(this.#data));
  }

  store(deviceId: string): Record<string, unknown> {
    return this.#data.stores[deviceId] ?? {};
  }

  setStore(deviceId: string, key: string, value: unknown): void {
    const store = { ...this.store(deviceId) };
    if (value === undefined || value === null) delete store[key];
    else store[key] = value;
    this.#data = { ...this.#data, stores: { ...this.#data.stores, [deviceId]: store } };
    writePreference(KEY, JSON.stringify(this.#data));
  }

  /** Adds a device with its first connection, or another connection to one it has. */
  save(input: {
    device: { id?: string; typeId: string; name: string; identity: string | null; config: ConfigValues };
    connection: { method: string; transport: string; address: string; config: ConfigValues; secrets: Record<string, string> };
    links?: { kind: string; other: string; role: 'source' | 'target' }[];
  }): LocalDevice {
    const existing = input.device.id ? this.device(input.device.id) : null;
    const device: LocalDevice = existing ?? {
      id: id('d'),
      typeId: input.device.typeId,
      name: input.device.name,
      identity: input.device.identity,
      config: input.device.config,
      addedAt: new Date().toISOString(),
    };
    const siblings = this.connections(device.id);
    if (siblings.some((connection) => connection.method === input.connection.method)) {
      throw new Error(`${device.name} is already reached this way`);
    }
    const connection: LocalConnection = {
      id: id('c'),
      deviceId: device.id,
      method: input.connection.method,
      transport: input.connection.transport,
      address: input.connection.address,
      config: input.connection.config,
      priority: siblings.length ? Math.max(...siblings.map((c) => c.priority)) + 1 : 0,
      lastConnectedAt: null,
    };
    const links = (input.links ?? []).map((link): LocalLink => ({
      id: id('l'),
      kind: link.kind,
      sourceId: link.role === 'source' ? device.id : link.other,
      targetId: link.role === 'source' ? link.other : device.id,
    }));
    this.#data = {
      ...this.#data,
      devices: existing ? this.#data.devices : [...this.#data.devices, device],
      connections: [...this.#data.connections, connection],
      // One feeds link per source: a new one replaces the old.
      links: [...this.#data.links.filter((old) => !links.some((link) => link.kind === old.kind && link.sourceId === old.sourceId)), ...links],
      secrets: Object.keys(input.connection.secrets).length ? { ...this.#data.secrets, [connection.id]: input.connection.secrets } : this.#data.secrets,
    };
    this.#write();
    return device;
  }

  rename(deviceId: string, name: string): void {
    this.#data = { ...this.#data, devices: this.#data.devices.map((device) => (device.id === deviceId ? { ...device, name } : device)) };
    this.#write();
  }

  setIdentity(deviceId: string, identity: string): void {
    this.#data = { ...this.#data, devices: this.#data.devices.map((device) => (device.id === deviceId ? { ...device, identity } : device)) };
    this.#write();
  }

  touch(connectionId: string): void {
    this.#data = {
      ...this.#data,
      connections: this.#data.connections.map((connection) => (connection.id === connectionId ? { ...connection, lastConnectedAt: new Date().toISOString() } : connection)),
    };
    writePreference(KEY, JSON.stringify(this.#data));
  }

  prefer(connectionId: string): void {
    const chosen = this.#data.connections.find((connection) => connection.id === connectionId);
    if (!chosen) return;
    const order = [chosen, ...this.connections(chosen.deviceId).filter((connection) => connection.id !== connectionId)];
    this.#data = {
      ...this.#data,
      connections: this.#data.connections.map((connection) => {
        const index = order.findIndex((candidate) => candidate.id === connection.id);
        return index < 0 ? connection : { ...connection, priority: index };
      }),
    };
    this.#write();
  }

  removeConnection(connectionId: string): void {
    const { [connectionId]: _gone, ...secrets } = this.#data.secrets;
    this.#data = { ...this.#data, connections: this.#data.connections.filter((connection) => connection.id !== connectionId), secrets };
    this.#write();
  }

  /** Deletes a device outright: in local mode there is no history to keep. */
  remove(deviceId: string): void {
    const gone = new Set(this.connections(deviceId).map((connection) => connection.id));
    const { [deviceId]: _store, ...stores } = this.#data.stores;
    this.#data = {
      devices: this.#data.devices.filter((device) => device.id !== deviceId),
      connections: this.#data.connections.filter((connection) => connection.deviceId !== deviceId),
      links: this.#data.links.filter((link) => link.sourceId !== deviceId && link.targetId !== deviceId),
      secrets: Object.fromEntries(Object.entries(this.#data.secrets).filter(([connectionId]) => !gone.has(connectionId))),
      stores,
    };
    this.#write();
  }

  addLink(kind: string, sourceId: string, targetId: string): LocalLink {
    const link: LocalLink = { id: id('l'), kind, sourceId, targetId };
    this.#data = { ...this.#data, links: [...this.#data.links.filter((old) => !(old.kind === kind && old.sourceId === sourceId)), link] };
    this.#write();
    return link;
  }

  removeLink(linkId: string): void {
    this.#data = { ...this.#data, links: this.#data.links.filter((link) => link.id !== linkId) };
    this.#write();
  }
}
