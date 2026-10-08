import type { Actor, AuditSubject } from './audit.ts';
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
 * One thing a device was heard saying about itself, typed by how it was
 * said. Plain data, so it can cross from the server to the app.
 *
 * - `broadcast`: a UDP datagram on the home network, its bytes in hex.
 * - `advert`: a Bluetooth advertisement — its name, its services (full
 *   128-bit UUIDs, lowercase) and its manufacturer data, by company id
 *   (decimal) to bytes in hex.
 * - `client`: a client of a message broker, by the protocol the broker
 *   recognised it speaking (null when none did), and whether it is
 *   connected now.
 * - `mdns`: a DNS-SD service on the home network: its type
 *   (`_http._tcp`), its instance name, its port, and its TXT records.
 * - `ssdp`: a UPnP announcement: its search target, its unique name, and
 *   where its description is.
 */
export type Announcement =
  | { kind: 'broadcast'; port: number; payload: string }
  | { kind: 'advert'; name: string | null; services: readonly string[]; manufacturer: Readonly<Record<string, string>> }
  | { kind: 'client'; protocol: string | null; online: boolean }
  | { kind: 'mdns'; service: string; instance: string; port: number; txt: Readonly<Record<string, string>> }
  | { kind: 'ssdp'; st: string; usn: string; location: string };

/** How a device can be heard: what a transport says it finds (`TransportDefinition.finds`). */
export type AnnouncementKind = Announcement['kind'];

export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = ['broadcast', 'advert', 'client', 'mdns', 'ssdp'];

/**
 * What a way is found by (docs/PLAN-INTEGRATIONS.md §4.4): one announcement
 * it answers to, declared as data beside its transport. Matched without
 * running the integration's code — its protocol's `recognise` only confirms
 * what a matcher picked out. Every field given must hold; a way with several
 * matchers is found by any of them. A text ending in `*` matches what starts
 * with the rest.
 *
 * - `broadcast`: datagrams on a UDP port — 6667, say.
 * - `advert`: an advertised service, a name, or manufacturer data under a
 *   company id.
 * - `client`: a broker client the broker recognised speaking a protocol.
 * - `mdns`: a service type, with TXT records that say what model it is.
 * - `ssdp`: a search target.
 */
export type Matcher =
  | { kind: 'broadcast'; port: number }
  | { kind: 'advert'; service?: string; name?: string; manufacturer?: number }
  | { kind: 'client'; protocol: string }
  | { kind: 'mdns'; service: string; txt?: Readonly<Record<string, string>> }
  | { kind: 'ssdp'; st: string };

/**
 * Something a transport can see: a peripheral advertising, a client on the
 * broker, a host on the home network announcing itself.
 *
 * Not a device — evidence that something is reachable. It becomes one only
 * when a person adds it, and it is never stored (docs/DATA-MODEL.md §3).
 * Gathered by address: whatever one host says — a broadcast, three mDNS
 * services — is one sighting, heard several ways.
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
  /** Everything it was heard saying, the latest of each kind and service. At least one. */
  heard: readonly Announcement[];
};

/** Its announcements of one kind. */
export function heardAs<K extends AnnouncementKind>(sighting: Sighting, kind: K): Extract<Announcement, { kind: K }>[] {
  return sighting.heard.filter((announcement): announcement is Extract<Announcement, { kind: K }> => announcement.kind === kind);
}

/** Whether a text matches a pattern: equal, ignoring case, or — for a pattern ending in `*` — starting with the rest. */
const like = (text: string | null | undefined, pattern: string): boolean => {
  const value = (text ?? '').toLowerCase();
  const wanted = pattern.toLowerCase();
  return wanted.endsWith('*') ? value.startsWith(wanted.slice(0, -1)) : value === wanted;
};

/**
 * A GATT UUID in its full 128-bit form, lowercase: what an advert's services
 * are kept as, and what a matcher's service is compared in. A 16-bit `fff0`
 * and its long form are the same service.
 */
export const fullUuid = (uuid: string): string => {
  const plain = uuid.toLowerCase();
  if (/^[0-9a-f]{4}$/.test(plain)) return `0000${plain}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{32}$/.test(plain)) return `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`;
  return plain;
};

/** Whether one announcement is what a matcher looks for. */
export function matches(matcher: Matcher, announcement: Announcement): boolean {
  switch (matcher.kind) {
    case 'broadcast':
      return announcement.kind === 'broadcast' && announcement.port === matcher.port;
    case 'advert':
      return (
        announcement.kind === 'advert' &&
        (matcher.service === undefined || announcement.services.some((service) => fullUuid(service) === fullUuid(matcher.service!))) &&
        (matcher.name === undefined || like(announcement.name, matcher.name)) &&
        (matcher.manufacturer === undefined || String(matcher.manufacturer) in announcement.manufacturer)
      );
    case 'client':
      return announcement.kind === 'client' && announcement.protocol === matcher.protocol;
    case 'mdns':
      return (
        announcement.kind === 'mdns' &&
        like(announcement.service, matcher.service) &&
        Object.entries(matcher.txt ?? {}).every(([key, pattern]) => key in announcement.txt && like(announcement.txt[key], pattern))
      );
    case 'ssdp':
      return announcement.kind === 'ssdp' && like(announcement.st, matcher.st);
  }
}

/** Whether a sighting is what any of the matchers look for. */
export const sightingMatches = (matchers: readonly Matcher[], sighting: Sighting): boolean =>
  matchers.some((matcher) => sighting.heard.some((announcement) => matches(matcher, announcement)));

/** What a matcher is, in a line: for a package's checks and its README. */
export function matcherSaid(matcher: Matcher): string {
  switch (matcher.kind) {
    case 'broadcast':
      return `a broadcast on UDP ${matcher.port}`;
    case 'advert':
      return `a Bluetooth advert${matcher.service ? ` with service ${matcher.service}` : ''}${matcher.name ? ` named ${matcher.name}` : ''}${matcher.manufacturer !== undefined ? ` from company ${matcher.manufacturer}` : ''}`;
    case 'client':
      return `a broker client speaking ${matcher.protocol}`;
    case 'mdns':
      return `the mDNS service ${matcher.service}${matcher.txt ? ` (${Object.entries(matcher.txt).map(([key, value]) => `${key}=${value}`).join(', ')})` : ''}`;
    case 'ssdp':
      return `the SSDP target ${matcher.st}`;
  }
}

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
  /** How devices on it are heard: what a way over it may declare it is found by. Empty for one nothing announces itself on. */
  finds: readonly AnnouncementKind[];
  /**
   * Watching it costs nothing — it only hears what is said anyway: broadcasts
   * on the home network, the broker's own clients — so a home watches it
   * all the time and offers what it finds without being asked. False for a
   * radio that must scan, which is watched only while someone looks.
   */
  background: boolean;
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
  /**
   * What can be seen, as a live list, listening for what the matchers name —
   * the UDP ports, the mDNS services. It may list more than they match: the
   * hub matches again. Returns how to stop watching.
   */
  watch?(matchers: readonly Matcher[], listener: (sightings: readonly Sighting[]) => void): () => void;
  /** The platform's own chooser, for platforms that show one, offering what the matchers match — everything, given none. Null when it is dismissed. */
  choose?(matchers: readonly Matcher[]): Promise<Sighting | null>;
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
  audit(entry: { kind: string; actor: Actor; summary: string; detail?: unknown } & AuditSubject): void;
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
