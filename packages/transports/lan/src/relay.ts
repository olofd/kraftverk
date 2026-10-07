import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';

import { sightingMatches, type Matcher, type Sighting } from '@kraftverk/device-sdk';

import type { Hearing } from './listen.ts';

/*
  The relay (docs/DOCKER.md): the one service of a home's on its home
  network, for a server in a container, which mDNS, SSDP and broadcasts do
  not reach. This is the whole of what passes between the two, and nothing
  else does:

    relay → server   {"kind":"hello","token":"…"}     who it is, first
    server → relay   {"kind":"watch","matchers":[…]}  what to listen for, whenever it changes
    relay → server   {"kind":"sightings","sightings":[…]}  what it hears, by host

  One JSON message a line, over one TCP connection the relay makes to the
  server, on a port the host publishes on its loopback address only. The
  relay listens and asks — an mDNS query, an SSDP search — and passes on
  what it hears: it opens nothing to a device, holds no secret but its
  token, and runs no integration's code. The server still makes every
  connection to a device itself.
*/

type ToServer = { kind: 'hello'; token: string } | { kind: 'sightings'; sightings: readonly Sighting[] };
type ToRelay = { kind: 'watch'; matchers: readonly Matcher[] };

/** The longest line either end reads: a home's sightings, many times over. */
const LINE_MAX = 4 * 1024 * 1024;
/** How often the relay says what it hears though nothing new was: what has left drops off. */
const RESAY_MS = 15_000;
/** How long the relay waits before connecting again, at most. */
const BACKOFF_MAX_MS = 30_000;

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Reads a socket a line at a time, each a JSON message; a line too long, or not JSON, ends the connection. */
function lines(socket: Socket, heard: (message: unknown) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    if (buffered.length > LINE_MAX) {
      socket.destroy(new Error('A line too long'));
      return;
    }
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      try {
        heard(JSON.parse(line));
      } catch {
        socket.destroy(new Error('Not a message'));
        return;
      }
    }
  });
}

const say = (socket: Socket, message: ToServer | ToRelay) => socket.write(`${JSON.stringify(message)}\n`);

/** The token the two ends share: read from its file, or made and written there the first time. Only the server makes it. */
export function relayToken(file: string, make: boolean): string | null {
  try {
    const token = readFileSync(file, 'utf8').trim();
    if (token) return token;
  } catch {
    /* not there yet */
  }
  if (!make) return null;
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o640 });
  return token;
}

const sameToken = (given: unknown, token: string): boolean => {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
};

/** Whether what a relay sent is sightings of the home network, as the SDK has them — anything else is not taken. */
const areSightings = (value: unknown): value is Sighting[] =>
  Array.isArray(value) &&
  value.every((each) => {
    const sighting = each as Partial<Sighting>;
    return sighting && sighting.transport === 'lan' && typeof sighting.address === 'string' && typeof sighting.seenAt === 'string' && Array.isArray(sighting.heard);
  });

/**
 * The server's end: hearing the home network through the relay. Listens for
 * it on `port`; tells it, whenever that changes, everything anything here is
 * watching for; and keeps what it says it hears. Until a relay connects,
 * nothing is heard — and said, once.
 */
export function hearThroughRelay(options: { port: number; token: string; log: Log; host?: string }): Hearing & { connected(): boolean; listening: Promise<number> } {
  const wanted = new Map<number, readonly Matcher[]>();
  const listeners = new Set<() => void>();
  let relayed: Sighting[] = [];
  let relay: Socket | null = null;
  let next = 0;

  const union = (): Matcher[] => {
    const seen = new Set<string>();
    return [...wanted.values()].flat().filter((matcher) => {
      const key = JSON.stringify(matcher);
      return seen.has(key) ? false : (seen.add(key), true);
    });
  };
  const tellRelay = () => relay && say(relay, { kind: 'watch', matchers: union() });
  const told = () => {
    for (const listener of [...listeners]) listener();
  };

  const server = createServer((socket) => {
    let known = false;
    // A relay that does not say who it is, soon, is let go.
    const timeout = setTimeout(() => socket.destroy(), 5_000);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timeout);
      if (relay !== socket) return;
      relay = null;
      relayed = [];
      told();
      options.log('warn', '[lan] The relay went away: nothing on the home network is heard until it is back');
    });
    lines(socket, (message) => {
      const said = message as ToServer;
      if (!known) {
        if (said.kind !== 'hello' || !sameToken(said.token, options.token)) {
          options.log('warn', '[lan] Refused a relay that did not give the token');
          socket.destroy();
          return;
        }
        known = true;
        clearTimeout(timeout);
        // One relay: a new one takes the place of the one before.
        relay?.destroy();
        relay = socket;
        options.log('info', '[lan] The relay is connected: the home network is heard through it');
        tellRelay();
        return;
      }
      if (said.kind === 'sightings' && areSightings(said.sightings)) {
        relayed = said.sightings;
        told();
      }
    });
  });
  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : options.port);
    });
  });
  listening.catch((error: Error) => options.log('error', `[lan] Could not listen for the relay on ${options.port}: ${error.message}`));

  return {
    listening,
    connected: () => relay !== null,
    want(matchers) {
      const id = next++;
      wanted.set(id, matchers);
      tellRelay();
      return () => {
        wanted.delete(id);
        tellRelay();
      };
    },
    sightings: (matchers) => relayed.filter((sighting) => sightingMatches(matchers, sighting)),
    onHeard(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop() {
      relay?.destroy();
      server.close();
      listeners.clear();
    },
  };
}

/**
 * The relay's end: connects to the server, says who it is, and listens for
 * what it is told to with `hearing` — its own sockets, on the home network —
 * passing on what it hears. Connects again, waiting longer each time, when
 * the connection drops. Returns how to stop.
 */
export function relayTo(options: { host: string; port: number; token: () => string | null; hearing: Hearing; log: Log; connected?: (connected: boolean) => void }): () => void {
  let stopped = false;
  let socket: Socket | null = null;
  let backoff = 1_000;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    const token = options.token();
    if (!token) {
      // The server makes the token when it first starts: until then, there is nothing to say who this is with.
      retry = setTimeout(connect, 2_000);
      return;
    }
    let matchers: readonly Matcher[] = [];
    let release = () => {};
    let pending: ReturnType<typeof setTimeout> | null = null;
    const current = createConnection({ host: options.host, port: options.port });
    socket = current;
    const send = () => {
      pending = null;
      if (!current.destroyed) say(current, { kind: 'sightings', sightings: options.hearing.sightings(matchers) });
    };
    // Heard things come in bursts: half a second of them is said at once.
    const stopHearing = options.hearing.onHeard(() => {
      pending ??= setTimeout(send, 500);
    });
    const resay = setInterval(send, RESAY_MS);

    current.on('connect', () => {
      backoff = 1_000;
      say(current, { kind: 'hello', token });
      options.log('info', `[relay] Connected to the server at ${options.host}:${options.port}`);
    });
    lines(current, (message) => {
      const said = message as ToRelay;
      if (said.kind !== 'watch' || !Array.isArray(said.matchers)) return;
      // Told what to listen for: the server took its token, and this is the relay it hears through.
      options.connected?.(true);
      release();
      matchers = said.matchers;
      release = options.hearing.want(matchers);
      send();
    });
    current.on('error', (error) => options.log('warn', `[relay] ${error.message}`));
    current.on('close', () => {
      options.connected?.(false);
      release();
      stopHearing();
      clearInterval(resay);
      if (pending) clearTimeout(pending);
      if (stopped) return;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    });
  };
  connect();

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    socket?.destroy();
  };
}
