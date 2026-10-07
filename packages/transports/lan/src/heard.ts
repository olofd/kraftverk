import { matches, type Announcement, type Matcher, type Sighting } from '@kraftverk/device-sdk';

import type { DnsMessage } from './dns.ts';

/*
  What the home network has heard, by host (docs/PLAN-INTEGRATIONS.md §4.4):
  each broadcast, each mDNS service instance and each SSDP announcement a
  host made, kept for as long as it said it holds — a broadcast a minute,
  an mDNS record its TTL, an SSDP announcement its max-age — and gone when
  it says goodbye. Pure: what was heard goes in, sightings come out, so the
  same holds whether the sockets are this process's or the relay's.
*/

/** A broadcast not heard again in this long has left. Devices repeat theirs every few seconds. */
const BROADCAST_HELD_MS = 60_000;
/** The longest an mDNS or SSDP announcement is held without being heard again, whatever it said: a device that left without a goodbye leaves the list. */
const LONGEST_HELD_MS = 75 * 60_000;
/** How long an SSDP announcement holds when it does not say. */
const SSDP_DEFAULT_MS = 30 * 60_000;

type Held = { announcement: Announcement; at: number; until: number };

/** The service an mDNS name is an instance of, and the instance: `Living room._airplay._tcp.local`. */
const SERVICE = /^(?:(.*)\.)?(_[^.]+\._(?:tcp|udp))\.local$/i;

export class Heard {
  /** By host, then by what was said: each announcement, when it was heard, and until when it holds. */
  #hosts = new Map<string, Map<string, Held>>();
  /** mDNS's records, joined across messages: a device's SRV and its address may come apart from its PTR. */
  #srv = new Map<string, { port: number; target: string; until: number }>();
  #txt = new Map<string, { txt: Record<string, string>; until: number }>();
  #address = new Map<string, { address: string; until: number }>();
  /** Each instance a PTR named — by its name lowercased, as DNS compares names — as it was written, with the host that said it. */
  #instances = new Map<string, { name: string; service: string; from: string; until: number }>();

  constructor(private now: () => number = Date.now) {}

  #keep(host: string, key: string, announcement: Announcement, heldMs: number): void {
    const at = this.now();
    const said = this.#hosts.get(host) ?? new Map<string, Held>();
    said.set(key, { announcement, at, until: at + Math.min(heldMs, LONGEST_HELD_MS) });
    this.#hosts.set(host, said);
  }

  #forget(key: string): void {
    for (const said of this.#hosts.values()) said.delete(key);
  }

  /** A datagram on a UDP port a way is found by. */
  broadcast(from: string, port: number, payload: Uint8Array): void {
    this.#keep(from, `broadcast:${port}`, { kind: 'broadcast', port, payload: [...payload].map((byte) => byte.toString(16).padStart(2, '0')).join('') }, BROADCAST_HELD_MS);
  }

  /** An mDNS answer: what it says of each service instance, joined with what was said before, and kept by the host that is the instance. */
  mdns(from: string, message: DnsMessage): void {
    if (!message.response) return;
    const now = this.now();
    const until = (ttl: number) => now + ttl * 1000;
    for (const record of message.records) {
      const name = record.name.toLowerCase();
      if (record.type === 'A') this.#address.set(name, { address: record.address, until: until(record.ttl) });
      else if (record.type === 'SRV') this.#srv.set(name, { port: record.port, target: record.target.toLowerCase(), until: until(record.ttl) });
      else if (record.type === 'TXT') this.#txt.set(name, { txt: record.txt, until: until(record.ttl) });
    }
    for (const record of message.records) {
      if (record.type !== 'PTR' || !SERVICE.test(record.name)) continue;
      const instance = record.target.toLowerCase();
      // A goodbye: the instance has left.
      if (record.ttl === 0) {
        this.#instances.delete(instance);
        this.#forget(`mdns:${instance}`);
        continue;
      }
      this.#instances.set(instance, { name: record.target, service: SERVICE.exec(record.name)![2]!.toLowerCase(), from, until: until(record.ttl) });
    }
    // Every instance this message said anything of, as it stands now.
    for (const [instance, { name, service, from: said, until: held }] of this.#instances) {
      const touched = message.records.some((record) => record.name.toLowerCase() === instance || (record.type === 'PTR' && record.target.toLowerCase() === instance));
      if (!touched || held <= now) continue;
      const srv = this.#srv.get(instance);
      const host = (srv && this.#address.get(srv.target)?.address) ?? said;
      const label = labelOf(name, service);
      this.#forget(`mdns:${instance}`);
      this.#keep(host, `mdns:${instance}`, { kind: 'mdns', service, instance: label, port: srv?.port ?? 0, txt: this.#txt.get(instance)?.txt ?? {} }, held - now);
    }
  }

  /** An SSDP message: a NOTIFY on the multicast group, or the answer to a search. A search of someone else's is not an announcement. */
  ssdp(from: string, text: string): void {
    const [first, ...lines] = text.split(/\r?\n/);
    if (!first || /^M-SEARCH/i.test(first)) return;
    const headers = new Map<string, string>();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const st = headers.get('st') ?? headers.get('nt');
    const usn = headers.get('usn') ?? '';
    if (!st) return;
    const key = `ssdp:${st}:${usn}`;
    if (/byebye/i.test(headers.get('nts') ?? '')) {
      this.#forget(key);
      return;
    }
    const maxAge = Number(/max-age\s*=\s*(\d+)/i.exec(headers.get('cache-control') ?? '')?.[1]);
    this.#keep(from, key, { kind: 'ssdp', st, usn, location: headers.get('location') ?? '' }, Number.isFinite(maxAge) ? maxAge * 1000 : SSDP_DEFAULT_MS);
  }

  /**
   * Every host that said something one of the matchers looks for, with
   * everything it said that still holds: a device announcing five ways is
   * one sighting. What has stopped holding is let go as it is read.
   */
  sightings(matchers: readonly Matcher[]): Sighting[] {
    const now = this.now();
    const sightings: Sighting[] = [];
    for (const [address, said] of this.#hosts) {
      for (const [key, held] of said) if (held.until <= now) said.delete(key);
      if (!said.size) {
        this.#hosts.delete(address);
        continue;
      }
      const all = [...said.values()];
      if (!all.some((held) => matchers.some((matcher) => matches(matcher, held.announcement)))) continue;
      sightings.push({ transport: 'lan', address, seenAt: new Date(Math.max(...all.map((held) => held.at))).toISOString(), heard: all.map((held) => held.announcement) });
    }
    for (const records of [this.#srv, this.#txt, this.#address, this.#instances] as Map<string, { until: number }>[]) {
      for (const [name, record] of records) if (record.until <= now) records.delete(name);
    }
    return sightings;
  }
}

/** An instance's own name, without its service: "Living room". */
function labelOf(instance: string, service: string): string {
  const suffix = `.${service}.local`;
  return instance.toLowerCase().endsWith(suffix) ? instance.slice(0, -suffix.length) : instance;
}
