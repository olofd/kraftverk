import type { PictureRef } from '@kraftverk/api-client';
import { linkKindSpec, type ConfigValues, type LinkEnd, type LinkKind } from '@kraftverk/device-sdk';

import { readPreference, writePreference } from '../lib/preferences';

/** Where a connection's secrets are kept: the app's vault — sealed, never in this catalog's plaintext. */
export type SecretStore = {
  get(connectionId: string): Record<string, string>;
  set(connectionId: string, secrets: Record<string, string>): void;
  delete(connectionId: string): void;
};

/** Secrets in memory only: for tests, and wherever nothing can be sealed. */
export function memorySecrets(): SecretStore {
  const kept = new Map<string, Record<string, string>>();
  return {
    get: (connectionId) => kept.get(connectionId) ?? {},
    set: (connectionId, secrets) => void kept.set(connectionId, { ...(kept.get(connectionId) ?? {}), ...secrets }),
    delete: (connectionId) => void kept.delete(connectionId),
  };
}

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

export type LocalDevice = {
  id: string;
  typeId: string;
  name: string;
  identity: string | null;
  config: ConfigValues;
  addedAt: string;
  /** Which picture to show; absent until its owner picks one, and its type's first is shown. */
  picture?: PictureRef;
};
export type LocalConnection = { id: string; deviceId: string; method: string; transport: string; address: string; config: ConfigValues; priority: number; lastConnectedAt: string | null };
/** A fact about the house between two parts, as the server keeps one. */
export type LocalLink = { id: string; kind: LinkKind; source: LinkEnd; target: LinkEnd };

type Stored = {
  devices: LocalDevice[];
  connections: LocalConnection[];
  links: LocalLink[];
  /** Plaintext, from before the vault: moved into it on first load, and gone from here. */
  secrets?: Record<string, Record<string, string>>;
  stores: Record<string, Record<string, unknown>>;
};

const KEY = 'kraftverk.local';

const sameEnd = (a: LinkEnd, b: LinkEnd) => a.device === b.device && a.part === b.part;

/** Whether a new link takes an old one's place: the same one again, or one of a kind with one target per source part. */
const replaces = (link: LocalLink, old: LocalLink): boolean =>
  link.kind === old.kind && sameEnd(link.source, old.source) && (linkKindSpec(link.kind).onePerSource || sameEnd(link.target, old.target));
const empty = (): Stored => ({ devices: [], connections: [], links: [], stores: {} });
const id = (prefix: string) => `${prefix}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;

export class LocalCatalog {
  #data: Stored;
  #listeners = new Set<() => void>();

  constructor(private vault: SecretStore = memorySecrets()) {
    this.#data = LocalCatalog.#read();
    const legacy = this.#data.secrets;
    if (legacy) {
      for (const [connectionId, secrets] of Object.entries(legacy)) vault.set(connectionId, secrets);
      const { secrets: _plaintext, ...rest } = this.#data;
      this.#data = rest;
      writePreference(KEY, JSON.stringify(this.#data));
    }
  }

  static #read(): Stored {
    try {
      const parsed = JSON.parse(readPreference(KEY) ?? 'null') as Partial<Stored> | null;
      const stored = { ...empty(), ...(parsed ?? {}) };
      // Links kept before they joined parts are set aside, as the server sets aside an older database.
      return { ...stored, links: stored.links.filter((link) => Boolean(link.source?.part && link.target?.part)) };
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
    return deviceId ? this.#data.links.filter((link) => link.source.device === deviceId || link.target.device === deviceId) : this.#data.links;
  }

  secrets(connectionId: string): Record<string, string> {
    return this.vault.get(connectionId);
  }

  /** Changes a connection's secrets: a plug's local key can change every time it is paired again. */
  setSecrets(connectionId: string, secrets: Record<string, string>): void {
    this.vault.set(connectionId, secrets);
    for (const listener of this.#listeners) listener();
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
    links?: { kind: LinkKind; part: string; other: LinkEnd; role: 'source' | 'target' }[];
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
    const links = (input.links ?? []).map((link): LocalLink => {
      const mine = { device: device.id, part: link.part };
      return { id: id('l'), kind: link.kind, source: link.role === 'source' ? mine : link.other, target: link.role === 'source' ? link.other : mine };
    });
    this.#data = {
      ...this.#data,
      devices: existing ? this.#data.devices : [...this.#data.devices, device],
      connections: [...this.#data.connections, connection],
      links: [...this.#data.links.filter((old) => !links.some((link) => replaces(link, old))), ...links],
    };
    if (Object.keys(input.connection.secrets).length) this.vault.set(connection.id, input.connection.secrets);
    this.#write();
    return device;
  }

  rename(deviceId: string, name: string): void {
    this.#data = { ...this.#data, devices: this.#data.devices.map((device) => (device.id === deviceId ? { ...device, name } : device)) };
    this.#write();
  }

  setPicture(deviceId: string, picture: PictureRef): void {
    this.#data = { ...this.#data, devices: this.#data.devices.map((device) => (device.id === deviceId ? { ...device, picture } : device)) };
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
    this.vault.delete(connectionId);
    this.#data = { ...this.#data, connections: this.#data.connections.filter((connection) => connection.id !== connectionId) };
    this.#write();
  }

  /** Deletes a device outright: in local mode there is no history to keep. */
  remove(deviceId: string): void {
    const gone = new Set(this.connections(deviceId).map((connection) => connection.id));
    const { [deviceId]: _store, ...stores } = this.#data.stores;
    this.#data = {
      devices: this.#data.devices.filter((device) => device.id !== deviceId),
      connections: this.#data.connections.filter((connection) => connection.deviceId !== deviceId),
      links: this.#data.links.filter((link) => link.source.device !== deviceId && link.target.device !== deviceId),
      stores,
    };
    for (const connectionId of gone) this.vault.delete(connectionId);
    this.#write();
  }

  addLink(kind: LinkKind, source: LinkEnd, target: LinkEnd): LocalLink {
    const link: LocalLink = { id: id('l'), kind, source, target };
    this.#data = { ...this.#data, links: [...this.#data.links.filter((old) => !replaces(link, old)), link] };
    this.#write();
    return link;
  }

  removeLink(linkId: string): void {
    this.#data = { ...this.#data, links: this.#data.links.filter((link) => link.id !== linkId) };
    this.#write();
  }
}
