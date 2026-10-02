import type { AuditSubject } from './audit.ts';
import type { Channel, ChannelKind, OpenOptions } from './channel.ts';
import type { Platform } from './node.ts';
import type { ConfigValues } from './schema.ts';

/*
  Transports: what moves bytes or messages and finds devices — every socket
  and radio, one implementation for each place it can run — and what it sees
  while finding them.
*/

/** Whether something can be used here and now, and if not, a sentence saying why. */
export type Availability = { ok: true } | { ok: false; reason: string };

/**
 * Something a transport can see: a peripheral advertising, a client on the
 * broker, a broadcast on the home network.
 *
 * Not a device — evidence that something is reachable. It becomes one only
 * when a person adds it, and it is never stored (docs/DATA-MODEL.md §3).
 */
export type Sighting = {
  transport: string;
  /** What the transport knows it by, and what `open` takes: a MAC, an IP, a browser's handle. */
  address: string;
  /** When it was last heard. */
  seenAt: string;
  /** What it calls itself, when it says. */
  name?: string;
  /** Bluetooth signal strength. */
  rssi?: number;
  /**
   * The transport's evidence, for a protocol to recognise it by: advertised
   * services, the protocol a broker client speaks, a broadcast's bytes (hex).
   * Plain data, so it can cross from the server to the app.
   */
  facts: Readonly<Record<string, unknown>>;
};

/** What a protocol makes of a sighting it recognises as one of its own. */
export type Recognised = {
  /** A name to list it under. */
  name: string;
  /** The device's own permanent id, when the sighting already carries it. */
  identity?: string;
  /** The model, when the sighting says. */
  model?: string;
  /** A second line: a protocol version, an address. */
  detail?: string;
  /**
   * Connection settings the sighting already reveals, applied to the draft
   * when it is chosen: a device's id and protocol version.
   */
  config?: ConfigValues;
};

/** What a transport should look for on a protocol's behalf. */
export type SightingFilter = {
  /** Bluetooth: advertised GATT services. */
  services?: readonly string[];
  /** Bluetooth: advertised name prefixes, for choosers that cannot match otherwise. */
  namePrefixes?: readonly string[];
  /** Home network: UDP ports devices broadcast on. */
  udpPorts?: readonly number[];
};

/** What a transport is, as data: the same on every platform. */
export type TransportDefinition = {
  /** `mqtt`, `ble`, `lan`, `https`. Stable forever: connections name it. */
  id: string;
  /** How people say it, in a sentence: "Wi-Fi", "Bluetooth", "the home network". */
  label: string;
  channel: ChannelKind;
  /**
   * An address means one physical thing, so only one device may claim it.
   * True for a broker client, a peripheral, an IP; false for a web API.
   */
  exclusive: boolean;
  /**
   * A device on it is reached only within range of whoever holds it — a
   * radio's, as Bluetooth's: what it reaches depends on where the holder
   * is, not on which network it is on. A way over it stays with the phone
   * near the device when a home moves to a server (docs/PLAN-SHARED-CORE.md,
   * phase 6); a way over any other moves with the home.
   */
  nearby: boolean;
  /** Where it has an implementation. */
  platforms: readonly Platform[];
  /**
   * How setup finds a device on it, per platform: a live `list`, the
   * platform's own `chooser` (a browser's Bluetooth picker), or `none` — the
   * address is typed or fixed, as a web API's is.
   */
  discovery: Partial<Record<Platform, 'list' | 'chooser' | 'none'>>;
};

/**
 * One transport, running on one platform.
 *
 * Started on demand by its platform's host, at most once per process, and
 * shared by every connection over it: there is one radio and one broker.
 */
export type Transport = {
  readonly definition: TransportDefinition;
  /** Whether it can be used here, now — and if not, why, in words a person can act on. */
  available(): Availability;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** What can be seen, as a live list. Returns how to stop watching. */
  watch?(filter: SightingFilter, listener: (sightings: readonly Sighting[]) => void): () => void;
  /** The platform's own chooser, for platforms that show one. Null when it is dismissed. */
  choose?(filter: SightingFilter): Promise<Sighting | null>;
  /**
   * A channel to one device. Lenient: a device out of range is a channel that
   * is not connected yet and keeps trying, not a failure.
   */
  open(address: string, options: OpenOptions): Promise<Channel>;
  /** Values setup instructions may show: the broker's address and port. */
  values?(): Readonly<Record<string, string>>;
  /** Read-only diagnostics, by name. */
  diagnostics?: Readonly<Record<string, (query: Readonly<Record<string, string>>) => Promise<unknown>>>;
};

/** What a platform's host hands a transport it starts. */
export type TransportContext = {
  /** The process's environment: a transport reads its own settings from it. */
  env: Readonly<Record<string, string | undefined>>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /**
   * Records something security-relevant in the audit timeline: a command the
   * broker refused, a client that presented the wrong secret.
   */
  audit(entry: { kind: string; actor: string; summary: string; detail?: unknown } & AuditSubject): void;
  /** What this transport keeps between runs, its own and no other transport's. */
  store: TransportStore;
};

/**
 * What a transport keeps between runs: a Bluetooth bond, a Matter fabric, a
 * broker's credentials. Small text values under keys of its choosing, scoped
 * to it by the host — the server's database, an app's own storage — so one
 * transport can neither read nor clobber another's.
 */
export type TransportStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
};

/** A store kept in memory: for tests, and a host with nowhere else to keep one. */
export function memoryTransportStore(): TransportStore {
  const kept = new Map<string, string>();
  return { get: (key) => kept.get(key) ?? null, set: (key, value) => void kept.set(key, value), delete: (key) => void kept.delete(key) };
}

/**
 * What a transport package's entry for one platform exports by default: how
 * to make the transport, given its context.
 */
export type TransportFactory = (context: TransportContext) => Transport;
