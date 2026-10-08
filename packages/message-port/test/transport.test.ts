import { afterEach, expect, test } from 'bun:test';

import { memoryTransportStore, sightingMatches, type ByteChannel, type HttpChannel, type Sighting, type Transport, type TransportContext, type TransportDefinition } from '@kraftverk/device-sdk';

import { serveTransport, transportOver } from '../src/index.ts';
import { actor } from '@kraftverk/device-sdk';

/*
  A transport run on one side of a real MessageChannel — a page — and
  reached from the other — a hub in its worker — as if it were its own:
  starting, what it sees, its chooser, a byte channel both ways, an HTTP
  answer, and what it says on its timeline.
*/

const DEFINITION: TransportDefinition = { id: 'wire', label: 'the test wire', channel: 'bytes', exclusive: true, nearby: false, platforms: ['web'], discovery: { web: 'chooser' }, finds: ['advert'], background: false };
const SIGHTING: Sighting = { transport: 'wire', address: 'dev-1', seenAt: '2026-10-02T00:00:00Z', name: 'Lamp', heard: [{ kind: 'advert', name: 'Lamp', services: ['a002'], manufacturer: {} }] };

/** A transport as a page would run one: everything kept here, to see from the test. */
function pageTransport(context: TransportContext) {
  const written: Uint8Array[] = [];
  let dataListener: ((bytes: Uint8Array) => void) | null = null;
  let connectedListener: ((connected: boolean) => void) | null = null;
  let started = false;
  const transport: Transport = {
    definition: DEFINITION,
    available: () => (started ? { ok: true } : { ok: false, reason: 'Not started' }),
    start: async () => {
      started = true;
      context.audit({ kind: 'wire.started', actor: actor('person', 'wire'), summary: 'The wire started' });
    },
    stop: async () => void (started = false),
    choose: async (matchers) => (sightingMatches(matchers, SIGHTING) ? SIGHTING : null),
    watch: (_matchers, listener) => {
      listener([SIGHTING]);
      return () => {};
    },
    values: () => ({ broker: '192.0.2.10' }),
    open: async (address) => {
      if (address === 'web') {
        return {
          kind: 'http',
          connected: true,
          onConnectedChange: () => () => {},
          close: async () => {},
          fetch: async (path, init) => new Response(JSON.stringify({ path, method: init?.method ?? 'GET', body: init?.body ?? null }), { status: 201, headers: { 'content-type': 'application/json' } }),
        } satisfies HttpChannel;
      }
      return {
        kind: 'bytes',
        connected: false,
        onConnectedChange: (listener) => {
          connectedListener = listener;
          return () => {};
        },
        close: async () => {},
        write: async (bytes) => void written.push(bytes),
        onData: (listener) => {
          dataListener = listener;
          return () => {};
        },
      } satisfies ByteChannel;
    },
  };
  return { transport, written, push: (bytes: Uint8Array) => dataListener?.(bytes), connect: () => connectedListener?.(true) };
}

const open: MessagePort[] = [];
afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

const later = () => new Promise((resolve) => setTimeout(resolve, 10));

function wire() {
  const channel = new MessageChannel();
  open.push(channel.port1, channel.port2);
  let page: ReturnType<typeof pageTransport> | null = null;
  const stop = serveTransport(channel.port2, (context) => (page = pageTransport(context)).transport, { store: memoryTransportStore() }, 'transport:wire');
  const audited: unknown[] = [];
  const hub = transportOver(DEFINITION, channel.port1, 'transport:wire')({ env: {}, store: memoryTransportStore(), log: () => {}, audit: (entry) => void audited.push(entry) });
  return { hub, page: () => page!, audited, stop };
}

test('started there, available here — and what it says on its timeline is said here', async () => {
  const { hub, audited, stop } = wire();
  expect(hub.available()).toMatchObject({ ok: false });
  await hub.start();
  expect(hub.available()).toEqual({ ok: true });
  expect(hub.values?.()).toEqual({ broker: '192.0.2.10' });
  await later();
  expect(audited).toEqual([{ kind: 'wire.started', actor: actor('person', 'wire'), summary: 'The wire started' }]);
  stop();
});

test('its chooser and its live list, from the side that has them', async () => {
  const { hub, stop } = wire();
  await hub.start();
  expect(await hub.choose!([{ kind: 'advert', service: 'a002' }])).toEqual(SIGHTING);
  expect(await hub.choose!([{ kind: 'advert', service: 'ffff' }])).toBeNull();
  const seen: (readonly Sighting[])[] = [];
  hub.watch!([], (sightings) => seen.push(sightings));
  await later();
  expect(seen).toEqual([[SIGHTING]]);
  stop();
});

test('a byte channel both ways: written there, heard here, connected when it connects', async () => {
  const { hub, page, stop } = wire();
  await hub.start();
  const channel = (await hub.open('dev-1', {})) as ByteChannel;
  expect(channel.kind).toBe('bytes');
  expect(channel.connected).toBe(false);
  const heard: Uint8Array[] = [];
  const states: boolean[] = [];
  channel.onData((bytes) => heard.push(bytes));
  channel.onConnectedChange((connected) => states.push(connected));
  page().connect();
  await channel.write(new Uint8Array([1, 2, 3]));
  page().push(new Uint8Array([9, 8]));
  await later();
  expect(channel.connected).toBe(true);
  expect(states).toEqual([true]);
  expect(page().written).toEqual([new Uint8Array([1, 2, 3])]);
  expect(heard).toEqual([new Uint8Array([9, 8])]);
  await channel.close();
  stop();
});

test('an HTTP channel: the request goes, the answer comes back as a Response', async () => {
  const { hub, stop } = wire();
  await hub.start();
  const channel = (await hub.open('web', {})) as HttpChannel;
  const response = await channel.fetch('/forecast', { method: 'POST', body: 'hello', headers: { 'x-a': '1' } });
  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({ path: '/forecast', method: 'POST', body: 'hello' });
  stop();
});

test('what fails there is thrown here, in its words', async () => {
  const { hub, stop } = wire();
  await hub.start();
  expect(await hub.diagnostics?.nothing?.({})).toBeUndefined();
  const refused = await (hub.open('dev-1', {}) as Promise<ByteChannel>).then((channel) => channel.close()).then(() => (hub.open('dev-1', {}) as Promise<ByteChannel>)).then(async (channel) => {
    await channel.close();
    return channel.write(new Uint8Array([1])).catch((error: Error) => error.message);
  });
  expect(refused).toBe('That connection is closed');
  stop();
});
