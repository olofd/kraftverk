import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Matcher, Sighting } from '@kraftverk/device-sdk';

import { ptrQuery, readMessage, writeResponse } from './dns.ts';
import { Heard } from './heard.ts';
import type { Hearing } from './listen.ts';
import { hearThroughRelay, relayTo, relayToken } from './relay.ts';

/*
  Hearing the home network (docs/PLAN-INTEGRATIONS.md step 13): mDNS read
  from the wire, SSDP read from its text, each kept by the host that said
  it for as long as it holds — and the relay passing what it hears to a
  server in a container, over the one connection it is allowed. Made-up
  devices at 192.0.2.x.
*/

const until = async (holds: () => boolean, what: string) => {
  for (let tries = 0; tries < 100 && !holds(); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!holds()) throw new Error(`Waited for ${what}`);
};

describe('mDNS on the wire', () => {
  test('a query asks for each service type’s instances', () => {
    const query = readMessage(ptrQuery(['_airplay._tcp.local', '_hap._tcp.local']));
    expect(query).toEqual({ response: false, questions: ['_airplay._tcp.local', '_hap._tcp.local'], records: [] });
  });

  test('an answer is read back as its records, names compressed or not', () => {
    const answer = writeResponse([
      { type: 'PTR', name: '_airplay._tcp.local', ttl: 4500, target: 'Living room._airplay._tcp.local' },
      { type: 'SRV', name: 'Living room._airplay._tcp.local', ttl: 120, port: 7000, target: 'tv.local' },
      { type: 'TXT', name: 'Living room._airplay._tcp.local', ttl: 4500, txt: { model: 'AppleTV14,1' } },
      { type: 'A', name: 'tv.local', ttl: 120, address: '192.0.2.50' },
    ]);
    expect(readMessage(answer).records).toEqual([
      { type: 'PTR', name: '_airplay._tcp.local', ttl: 4500, target: 'Living room._airplay._tcp.local' },
      { type: 'SRV', name: 'Living room._airplay._tcp.local', ttl: 120, port: 7000, target: 'tv.local' },
      { type: 'TXT', name: 'Living room._airplay._tcp.local', ttl: 4500, txt: { model: 'AppleTV14,1' } },
      { type: 'A', name: 'tv.local', ttl: 120, address: '192.0.2.50' },
    ]);
    // What is not a message is refused, never half read.
    expect(() => readMessage(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => readMessage(new Uint8Array([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12]))).toThrow();
  });
});

describe('what a host said, kept by host', () => {
  const tv: Matcher = { kind: 'mdns', service: '_airplay._tcp', txt: { model: 'AppleTV*' } };

  test('an mDNS instance, at the address its SRV names, with what its TXT says — and gone when it says goodbye', () => {
    let now = 0;
    const heard = new Heard(() => now);
    // Its records come from a sleep proxy at .1: the instance is the TV's, at the address its host has.
    heard.mdns('192.0.2.1', readMessage(writeResponse([
      { type: 'PTR', name: '_airplay._tcp.local', ttl: 4500, target: 'Living room._airplay._tcp.local' },
      { type: 'SRV', name: 'Living room._airplay._tcp.local', ttl: 120, port: 7000, target: 'tv.local' },
      { type: 'TXT', name: 'Living room._airplay._tcp.local', ttl: 4500, txt: { model: 'AppleTV14,1' } },
      { type: 'A', name: 'tv.local', ttl: 120, address: '192.0.2.50' },
    ])));
    const [sighting] = heard.sightings([tv]);
    expect(sighting).toMatchObject({ transport: 'lan', address: '192.0.2.50', heard: [{ kind: 'mdns', service: '_airplay._tcp', instance: 'Living room', port: 7000, txt: { model: 'AppleTV14,1' } }] });
    expect(heard.sightings([{ kind: 'mdns', service: '_hap._tcp' }])).toEqual([]);

    now = 60_000;
    heard.mdns('192.0.2.50', readMessage(writeResponse([{ type: 'PTR', name: '_airplay._tcp.local', ttl: 0, target: 'Living room._airplay._tcp.local' }])));
    expect(heard.sightings([tv])).toEqual([]);
  });

  test('one host heard several ways is one sighting, with all it said; what has stopped holding drops off', () => {
    let now = 0;
    const heard = new Heard(() => now);
    heard.broadcast('192.0.2.74', 6667, new Uint8Array([0, 0, 0x55, 0xaa]));
    heard.ssdp('192.0.2.74', ['NOTIFY * HTTP/1.1', 'NT: urn:schemas-upnp-org:device:MediaRenderer:1', 'NTS: ssdp:alive', 'USN: uuid:1234::urn:schemas-upnp-org:device:MediaRenderer:1', 'LOCATION: http://192.0.2.74:1400/xml', 'CACHE-CONTROL: max-age=1800', '', ''].join('\r\n'));
    const [sighting] = heard.sightings([{ kind: 'ssdp', st: 'urn:schemas-upnp-org:device:MediaRenderer:*' }]);
    expect(sighting?.heard.map((said) => said.kind).sort()).toEqual(['broadcast', 'ssdp']);
    expect(sighting?.heard.find((said) => said.kind === 'ssdp')).toEqual({ kind: 'ssdp', st: 'urn:schemas-upnp-org:device:MediaRenderer:1', usn: 'uuid:1234::urn:schemas-upnp-org:device:MediaRenderer:1', location: 'http://192.0.2.74:1400/xml' });
    // A search someone else made is not an announcement.
    heard.ssdp('192.0.2.9', ['M-SEARCH * HTTP/1.1', 'ST: ssdp:all', '', ''].join('\r\n'));
    expect(heard.sightings([{ kind: 'ssdp', st: 'ssdp:all' }])).toEqual([]);

    // A minute on, the broadcast has not been heard again: only the announcement holds.
    now = 61_000;
    expect(heard.sightings([{ kind: 'broadcast', port: 6667 }])).toEqual([]);
    expect(heard.sightings([{ kind: 'ssdp', st: 'urn:schemas-upnp-org:device:MediaRenderer:*' }]).at(0)?.heard.map((said) => said.kind)).toEqual(['ssdp']);
  });
});

/** A hearing that hears what it is given: the relay's, played. */
function playedHearing(): Hearing & { wanted: readonly Matcher[]; hear(sightings: Sighting[]): void } {
  const listeners = new Set<() => void>();
  let heard: Sighting[] = [];
  const played = {
    wanted: [] as readonly Matcher[],
    want(matchers: readonly Matcher[]) {
      played.wanted = matchers;
      return () => (played.wanted = []);
    },
    sightings: (matchers: readonly Matcher[]) => heard.filter((sighting) => matchers.length > 0 && sighting.address.length > 0),
    onHeard(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop: () => listeners.clear(),
    hear(sightings: Sighting[]) {
      heard = sightings;
      for (const listener of listeners) listener();
    },
  };
  return played;
}

describe('the relay', () => {
  const plug: Sighting = { transport: 'lan', address: '192.0.2.74', seenAt: '2026-10-07T00:00:00.000Z', heard: [{ kind: 'broadcast', port: 6667, payload: '000055aa' }] };

  test('its token is made by the server, once, and only read by the relay', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'relay-')), 'relay', 'token');
    expect(relayToken(file, false)).toBeNull();
    const token = relayToken(file, true)!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(relayToken(file, true)).toBe(token);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
  });

  test('is told what to listen for, and passes on what it hears — to a server that knows its token', async () => {
    const logs: string[] = [];
    const server = hearThroughRelay({ port: 0, host: '127.0.0.1', token: 'a'.repeat(64), log: (_, message) => logs.push(message) });
    const port = await server.listening;
    const release = server.want([{ kind: 'broadcast', port: 6667 }]);
    let told = 0;
    server.onHeard(() => told++);

    const relayHearing = playedHearing();
    const stop = relayTo({ host: '127.0.0.1', port, token: () => 'a'.repeat(64), hearing: relayHearing, log: () => {} });
    await until(() => server.connected(), 'the relay to connect');
    await until(() => relayHearing.wanted.length === 1, 'the relay to be told what to listen for');
    expect(relayHearing.wanted).toEqual([{ kind: 'broadcast', port: 6667 }]);

    relayHearing.hear([plug]);
    await until(() => server.sightings([{ kind: 'broadcast', port: 6667 }]).length === 1, 'what it heard to arrive');
    expect(server.sightings([{ kind: 'broadcast', port: 6667 }])).toEqual([plug]);
    expect(server.sightings([{ kind: 'mdns', service: '_hap._tcp' }])).toEqual([]);
    expect(told).toBeGreaterThan(0);

    // Nothing more is wanted: the relay is told so.
    release();
    await until(() => relayHearing.wanted.length === 0, 'the relay to stop listening');
    stop();
    await until(() => !server.connected(), 'the relay to leave');
    expect(server.sightings([{ kind: 'broadcast', port: 6667 }])).toEqual([]);
    server.stop();
  });

  test('one without the token is refused, and hears nothing it could pass on', async () => {
    const logs: string[] = [];
    const server = hearThroughRelay({ port: 0, host: '127.0.0.1', token: 'a'.repeat(64), log: (_, message) => logs.push(message) });
    const port = await server.listening;
    const impostor = playedHearing();
    const stop = relayTo({ host: '127.0.0.1', port, token: () => 'b'.repeat(64), hearing: impostor, log: () => {} });
    await until(() => logs.some((message) => message.includes('Refused a relay')), 'the refusal');
    expect(server.connected()).toBe(false);
    expect(impostor.wanted).toEqual([]);
    stop();
    server.stop();
  });
});
