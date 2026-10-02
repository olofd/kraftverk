import type {
  Availability,
  ByteChannel,
  Channel,
  ChannelKind,
  ChannelMessage,
  HttpChannel,
  MessageChannel,
  OpenOptions,
  Sighting,
  SightingFilter,
  Transport,
  TransportContext,
  TransportDefinition,
  TransportFactory,
  TransportStore,
} from '@kraftverk/device-sdk';

import { thrownAgain } from './api.ts';
import { counter, failureOf, hear, type Failure, type MessageEnd } from './end.ts';

/*
  A transport over a message port (docs/PLAN-SHARED-CORE.md, "SQLite in the
  app"): run on one side — a browser's page, where Web Bluetooth, a chooser
  and a person's tap are — and the same `Transport` on the other, where the
  hub is. Starting and stopping it, what it sees, its chooser, and each
  channel it opens, with every byte, message and HTTP answer both ways. What
  it says on its timeline and in its log goes to the hub's.

  What it keeps between runs (`TransportStore`) is kept where it runs: a
  store is read as it is asked, which cannot wait for an answer across.
*/

/** What the side running it says of it, kept on the other: `available()`, `values()` and the rest are asked without waiting. */
type State = {
  available: Availability;
  values: Readonly<Record<string, string>> | null;
  diagnostics: string[];
  watch: boolean;
  choose: boolean;
};

type Request = { via: string; kind: 'call'; id: number; op: string; args: unknown[] };
type ToRunning =
  | Request
  | { via: string; kind: 'watch'; watch: number; filter: SightingFilter }
  | { via: string; kind: 'unwatch'; watch: number }
  | { via: string; kind: 'subscribe'; channel: number; subscription: number; filter: string }
  | { via: string; kind: 'unsubscribe'; channel: number; subscription: number };
type ToHub =
  | { via: string; kind: 'answer'; id: number; value: unknown }
  | { via: string; kind: 'refused'; id: number; failure: Failure }
  | { via: string; kind: 'state'; state: State }
  | { via: string; kind: 'sightings'; watch: number; sightings: readonly Sighting[] }
  | { via: string; kind: 'connected'; channel: number; connected: boolean; describe: Record<string, unknown> | null }
  | { via: string; kind: 'data'; channel: number; bytes: Uint8Array }
  | { via: string; kind: 'message'; channel: number; subscription: number; message: ChannelMessage }
  | { via: string; kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { via: string; kind: 'audit'; entry: Parameters<TransportContext['audit']>[0] };

/** A channel as it was opened: what the hub's side needs to stand in for it. */
type Opened = { channel: number; kind: ChannelKind; connected: boolean; describe: Record<string, unknown> | null; resets: boolean };

/** An HTTP request and its answer, as they cross: a body is text or bytes, never a stream. */
type HttpAsked = { path: string; method?: string; headers: [string, string][]; body: string | Uint8Array | null; timeoutMs?: number; redirect?: RequestInit['redirect'] };
type HttpAnswered = { status: number; statusText: string; headers: [string, string][]; body: Uint8Array | null };

const STATE_EVERY_MS = 2000;
/** Statuses whose answer has no body: a `Response` refuses one. */
const NO_BODY = new Set([101, 204, 205, 304]);

const headerPairs = (headers: RequestInit['headers'] | Headers | undefined): [string, string][] => {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map((pair): [string, string] => [String(pair[0]), String(pair[1])]);
  if (typeof (headers as Headers).forEach === 'function') {
    const pairs: [string, string][] = [];
    (headers as Headers).forEach((value, name) => pairs.push([name, value]));
    return pairs;
  }
  return Object.entries(headers as Record<string, string>);
};

const bodyOf = (body: RequestInit['body']): string | Uint8Array | null => {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  return body.toString();
};

// --- where it runs ------------------------------------------------------------------

/**
 * Runs the transport `factory` makes, here, for a hub on the other end of
 * `end` (`transportOver` there). Returns how to stop serving it, which
 * stops the transport and closes every channel it opened.
 */
export function serveTransport(end: MessageEnd, factory: TransportFactory, here: { env?: TransportContext['env']; store: TransportStore }, via: string): () => void {
  const send = (message: ToHub) => end.postMessage(message);
  const channels = new Map<number, { channel: Channel; stops: (() => void)[]; subscriptions: Map<number, () => void> }>();
  const watches = new Map<number, () => void>();
  const nextChannel = counter();
  let transport: Transport | null = null;
  let said = '';
  let poll: ReturnType<typeof setInterval> | null = null;

  const stateOf = (running: Transport): State => ({
    available: running.available(),
    values: running.values?.() ?? null,
    diagnostics: Object.keys(running.diagnostics ?? {}),
    watch: typeof running.watch === 'function',
    choose: typeof running.choose === 'function',
  });
  /** What it is now, said when it changed: whether it can be used comes and goes with a radio. */
  const sayState = (force = false) => {
    if (!transport) return;
    const state = stateOf(transport);
    const text = JSON.stringify(state);
    if (!force && text === said) return;
    said = text;
    send({ via, kind: 'state', state });
  };

  const made = (): Transport => {
    if (transport) return transport;
    transport = factory({
      env: here.env ?? {},
      store: here.store,
      log: (level, message) => send({ via, kind: 'log', level, message }),
      audit: (entry) => send({ via, kind: 'audit', entry }),
    });
    poll = setInterval(() => sayState(), STATE_EVERY_MS);
    return transport;
  };

  const opened = (channel: Channel): Opened => {
    const id = nextChannel();
    const stops = [channel.onConnectedChange((connected) => send({ via, kind: 'connected', channel: id, connected, describe: channel.describe?.() ?? null }))];
    if (channel.kind === 'bytes') stops.push(channel.onData((bytes) => send({ via, kind: 'data', channel: id, bytes })));
    channels.set(id, { channel, stops, subscriptions: new Map() });
    return { channel: id, kind: channel.kind, connected: channel.connected, describe: channel.describe?.() ?? null, resets: channel.kind === 'bytes' && typeof channel.reset === 'function' };
  };

  const channel = (id: unknown) => {
    const found = channels.get(id as number);
    if (!found) throw new Error('That connection is closed');
    return found;
  };

  const ops: Record<string, (...args: never[]) => unknown> = {
    create: () => stateOf(made()),
    start: async () => {
      await made().start();
      return stateOf(made());
    },
    stop: async () => {
      await transport?.stop();
      return transport ? stateOf(transport) : null;
    },
    choose: async (filter: SightingFilter) => {
      const chooser = made().choose;
      if (!chooser) throw new Error(`${made().definition.label} has no chooser here`);
      return chooser.call(transport, filter);
    },
    open: async (address: string, options: OpenOptions) => opened(await made().open(address, options)),
    diagnostic: (name: string, query: Readonly<Record<string, string>>) => {
      const diagnostic = made().diagnostics?.[name];
      if (!diagnostic) throw new Error(`No diagnostic called "${name}"`);
      return diagnostic(query);
    },
    write: (id: number, bytes: Uint8Array) => (channel(id).channel as ByteChannel).write(bytes),
    reset: (id: number) => (channel(id).channel as ByteChannel).reset?.(),
    publish: (id: number, topic: string, payload: Uint8Array) => (channel(id).channel as MessageChannel).publish(topic, payload),
    fetch: async (id: number, asked: HttpAsked): Promise<HttpAnswered> => {
      const response = await (channel(id).channel as HttpChannel).fetch(asked.path, {
        ...(asked.method ? { method: asked.method } : {}),
        headers: asked.headers,
        body: asked.body,
        ...(asked.timeoutMs ? { timeoutMs: asked.timeoutMs } : {}),
        ...(asked.redirect ? { redirect: asked.redirect } : {}),
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: headerPairs(response.headers),
        body: NO_BODY.has(response.status) ? null : new Uint8Array(await response.arrayBuffer()),
      };
    },
    close: async (id: number) => {
      const found = channels.get(id);
      if (!found) return;
      channels.delete(id);
      for (const stop of found.stops) stop();
      for (const stop of found.subscriptions.values()) stop();
      await found.channel.close();
    },
  };

  const answer = async (request: Request) => {
    try {
      const op = ops[request.op];
      if (!op) throw new Error(`A transport has no "${request.op}"`);
      send({ via, kind: 'answer', id: request.id, value: await (op as (...args: unknown[]) => unknown)(...request.args) });
    } catch (error) {
      send({ via, kind: 'refused', id: request.id, failure: failureOf(error) });
    }
    sayState();
  };

  const stopHearing = hear<ToRunning>(end, via, (message) => {
    switch (message.kind) {
      case 'call':
        void answer(message);
        return;
      case 'watch': {
        const watch = made().watch;
        if (!watch) return;
        watches.set(message.watch, watch.call(transport, message.filter, (sightings) => send({ via, kind: 'sightings', watch: message.watch, sightings })));
        return;
      }
      case 'unwatch':
        watches.get(message.watch)?.();
        watches.delete(message.watch);
        return;
      case 'subscribe': {
        const found = channels.get(message.channel);
        if (!found || found.channel.kind !== 'messages') return;
        found.subscriptions.set(
          message.subscription,
          found.channel.subscribe(message.filter, (received) => send({ via, kind: 'message', channel: message.channel, subscription: message.subscription, message: received }))
        );
        return;
      }
      case 'unsubscribe':
        channels.get(message.channel)?.subscriptions.get(message.subscription)?.();
        channels.get(message.channel)?.subscriptions.delete(message.subscription);
        return;
    }
  });

  return () => {
    stopHearing();
    if (poll) clearInterval(poll);
    for (const stop of watches.values()) stop();
    for (const id of [...channels.keys()]) void ops.close!(id as never);
    void transport?.stop().catch(() => undefined);
  };
}

// --- where the hub is ------------------------------------------------------------------

/**
 * The transport run on the other end of `end` (`serveTransport` there), as
 * a factory a hub installs: `{ definition, create: transportOver(...) }`.
 * Its definition is known here, as every definition is (the generated
 * registry's); everything else it is, it says.
 */
export function transportOver(definition: TransportDefinition, end: MessageEnd, via: string): TransportFactory {
  return (context) => {
    const send = (message: ToRunning) => end.postMessage(message);
    const nextCall = counter();
    const nextWatch = counter();
    const nextSubscription = counter();
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const watches = new Map<number, (sightings: readonly Sighting[]) => void>();
    const channels = new Map<number, { connected: boolean; describe: Record<string, unknown> | null; onConnected: Set<(connected: boolean) => void>; onData: Set<(bytes: Uint8Array) => void>; subscriptions: Map<number, (message: ChannelMessage) => void> }>();
    let state: State | null = null;

    hear<ToHub>(end, via, (message) => {
      switch (message.kind) {
        case 'answer':
        case 'refused': {
          const waiting = pending.get(message.id);
          if (!waiting) return;
          pending.delete(message.id);
          if (message.kind === 'answer') waiting.resolve(message.value);
          else waiting.reject(thrownAgain(message.failure));
          return;
        }
        case 'state':
          state = message.state;
          return;
        case 'sightings':
          watches.get(message.watch)?.(message.sightings);
          return;
        case 'connected': {
          const known = channels.get(message.channel);
          if (!known) return;
          known.connected = message.connected;
          known.describe = message.describe;
          for (const listener of [...known.onConnected]) listener(message.connected);
          return;
        }
        case 'data':
          for (const listener of [...(channels.get(message.channel)?.onData ?? [])]) listener(message.bytes);
          return;
        case 'message':
          channels.get(message.channel)?.subscriptions.get(message.subscription)?.(message.message);
          return;
        case 'log':
          context.log(message.level, message.message);
          return;
        case 'audit':
          context.audit(message.entry);
          return;
      }
    });

    const call = <T>(op: string, ...args: unknown[]) =>
      new Promise<T>((resolve, reject) => {
        const id = nextCall();
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        send({ via, kind: 'call', id, op, args });
      });
    const withState = async (op: string, ...args: unknown[]) => {
      const answered = await call<State | null>(op, ...args);
      if (answered) state = answered;
    };

    /** A channel opened there, standing in for it here. */
    const channelOf = (opened: Opened): Channel => {
      /** Whether it is connected is read as it is asked: never copied, or it would stay what it was. */
      const live = <C extends Channel>(made: Omit<C, 'connected'>): C => Object.defineProperty(made, 'connected', { get: () => known.connected, enumerable: true }) as C;
      const known = { connected: opened.connected, describe: opened.describe, onConnected: new Set<(connected: boolean) => void>(), onData: new Set<(bytes: Uint8Array) => void>(), subscriptions: new Map<number, (message: ChannelMessage) => void>() };
      channels.set(opened.channel, known);
      const base = {
        onConnectedChange: (listener: (connected: boolean) => void) => {
          known.onConnected.add(listener);
          return () => void known.onConnected.delete(listener);
        },
        close: async () => {
          channels.delete(opened.channel);
          await call('close', opened.channel);
        },
        describe: () => known.describe ?? {},
      };
      if (opened.kind === 'bytes') {
        return live<ByteChannel>({
          ...base,
          kind: 'bytes',
          write: (bytes: Uint8Array) => call<void>('write', opened.channel, bytes),
          onData: (listener: (bytes: Uint8Array) => void) => {
            known.onData.add(listener);
            return () => void known.onData.delete(listener);
          },
          ...(opened.resets ? { reset: () => call<void>('reset', opened.channel) } : {}),
        });
      }
      if (opened.kind === 'messages') {
        return live<MessageChannel>({
          ...base,
          kind: 'messages',
          publish: (topic: string, payload: Uint8Array) => call<void>('publish', opened.channel, topic, payload),
          subscribe: (filter: string, listener: (message: ChannelMessage) => void) => {
            const subscription = nextSubscription();
            known.subscriptions.set(subscription, listener);
            send({ via, kind: 'subscribe', channel: opened.channel, subscription, filter });
            return () => {
              known.subscriptions.delete(subscription);
              send({ via, kind: 'unsubscribe', channel: opened.channel, subscription });
            };
          },
        });
      }
      return live<HttpChannel>({
        ...base,
        kind: 'http',
        fetch: async (path: string, init: RequestInit & { timeoutMs?: number } = {}) => {
          const asked: HttpAsked = {
            path,
            ...(init.method ? { method: init.method } : {}),
            headers: headerPairs(init.headers),
            body: bodyOf(init.body),
            ...(init.timeoutMs ? { timeoutMs: init.timeoutMs } : {}),
            ...(init.redirect ? { redirect: init.redirect } : {}),
          };
          const answered = await call<HttpAnswered>('fetch', opened.channel, asked);
          return new Response(answered.body, { status: answered.status, statusText: answered.statusText, headers: answered.headers });
        },
      });
    };

    const transport: Transport = {
      definition,
      available: () => state?.available ?? { ok: false, reason: `${definition.label} is starting` },
      start: async () => {
        await withState('create');
        await withState('start');
      },
      stop: () => withState('stop'),
      values: () => state?.values ?? {},
      // A live list and a chooser are what the side running it has: until it has said, neither.
      get watch() {
        if (!state?.watch) return undefined;
        return (filter: SightingFilter, listener: (sightings: readonly Sighting[]) => void) => {
          const watch = nextWatch();
          watches.set(watch, listener);
          send({ via, kind: 'watch', watch, filter });
          return () => {
            watches.delete(watch);
            send({ via, kind: 'unwatch', watch });
          };
        };
      },
      get choose() {
        if (!state?.choose) return undefined;
        return (filter: SightingFilter) => call<Sighting | null>('choose', filter);
      },
      open: async (address, options) => channelOf(await call<Opened>('open', address, options)),
      get diagnostics() {
        return Object.fromEntries((state?.diagnostics ?? []).map((name) => [name, (query: Readonly<Record<string, string>>) => call<unknown>('diagnostic', name, query)]));
      },
    };
    return transport;
  };
}
