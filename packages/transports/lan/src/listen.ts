import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import type { Matcher, Sighting } from '@kraftverk/device-sdk';

import { ptrQuery, readMessage } from './dns.ts';
import { Heard } from './heard.ts';

/*
  Hearing the home network: what a way is found by, listened for — the UDP
  ports devices broadcast on, mDNS (224.0.0.251:5353) asked for each
  service type wanted, SSDP (239.255.255.250:1900) searched for each
  target — and what is heard kept by host (heard.ts). Each socket opened
  while something wants it, and shared. On the server's own network, as in
  development; or in the relay, the one service on the home network, for a
  server in a container (relay.ts).
*/

/** What hearing is, wherever it happens: wanted, asked, told of. */
export type Hearing = {
  /** Listens for what these matchers look for, until the returned function is called. */
  want(matchers: readonly Matcher[]): () => void;
  /** Every host heard saying what one of the matchers looks for. */
  sightings(matchers: readonly Matcher[]): Sighting[];
  /** Told when something new was heard. */
  onHeard(listener: () => void): () => void;
  stop(): void;
};

const MDNS = { address: '224.0.0.251', port: 5353 } as const;
const SSDP = { address: '239.255.255.250', port: 1900 } as const;
/** When a service type is asked for again after it is first wanted, then every five minutes while it is: answers to a query can be lost, and devices come and go. */
const ASK_AFTER_MS = [2_000, 10_000] as const;
const ASK_EVERY_MS = 5 * 60_000;

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Counts who wants a thing: started with the first, stopped with the last. */
class Wanted<K> {
  #users = new Map<K, { users: number; stop: () => void }>();
  constructor(private start: (key: K) => () => void) {}
  add(key: K): void {
    const held = this.#users.get(key);
    if (held) held.users += 1;
    else this.#users.set(key, { users: 1, stop: this.start(key) });
  }
  remove(key: K): void {
    const held = this.#users.get(key);
    if (!held) return;
    held.users -= 1;
    if (held.users > 0) return;
    this.#users.delete(key);
    held.stop();
  }
  stopAll(): void {
    for (const held of this.#users.values()) held.stop();
    this.#users.clear();
  }
}

/** Asks now, a little later, and then every few minutes, until stopped. */
function asking(ask: () => void): () => void {
  ask();
  const timers = ASK_AFTER_MS.map((ms) => setTimeout(ask, ms));
  const every = setInterval(ask, ASK_EVERY_MS);
  return () => {
    for (const timer of timers) clearTimeout(timer);
    clearInterval(every);
  };
}

/**
 * This machine's own IPv4 addresses on its networks: a group is joined, and
 * a question asked, on each. A machine has several — Wi-Fi and a cable, a
 * container's bridge, a VPN — and a group joined without naming one lands on
 * whichever the system picks, which may not be the home network's.
 */
const interfaceAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((each) => each && each.family === 'IPv4' && !each.internal)
    .map((each) => each!.address);

/** Sockets that have bound: a question asked of one that has not yet is asked once it has. */
const ready = new WeakSet<Socket>();

/** Sends a multicast question out of every interface, so it is heard on the home network whichever that is. */
function sendEverywhere(socket: Socket | null, message: Uint8Array, port: number, group: string, failed: (error: Error) => void): void {
  if (!socket) return;
  if (!ready.has(socket)) {
    socket.once('listening', () => sendEverywhere(socket, message, port, group, failed));
    return;
  }
  for (const address of interfaceAddresses()) {
    try {
      socket.setMulticastInterface(address);
      socket.send(message, port, group, (error) => error && failed(error));
    } catch (error) {
      failed(error as Error);
    }
  }
}

/** Closes a socket, whatever state it is in. */
const close = (socket: Socket) => {
  try {
    socket.close();
  } catch {
    /* already closed */
  }
};

/** Hearing with this process's own sockets. */
export function hearDirectly(log: Log): Hearing {
  const heard = new Heard();
  const listeners = new Set<() => void>();
  const told = () => {
    for (const listener of [...listeners]) listener();
  };

  /** A socket bound to a port shared with whatever else listens on it — another tool on 6667, the system's own mDNS responder on 5353 — and joined to a group if it is multicast. */
  const bound = (port: number, what: string, group: string | null, heardBy: (data: Uint8Array, from: string) => void): Socket => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (data, remote) => {
      try {
        heardBy(new Uint8Array(data), remote.address);
        told();
      } catch {
        // What came in is anyone's: what is not an announcement is not heard.
      }
    });
    socket.on('error', (error) => log('warn', `[lan] ${what}: ${error.message}`));
    socket.bind(port, () => {
      ready.add(socket);
      if (!group) return;
      socket.setMulticastTTL(255);
      for (const address of interfaceAddresses()) {
        try {
          socket.addMembership(group, address);
        } catch (error) {
          log('warn', `[lan] ${what}: could not join ${group} on ${address}: ${(error as Error).message}`);
        }
      }
    });
    return socket;
  };

  const ports = new Wanted<number>((port) => {
    const socket = bound(port, `UDP ${port}`, null, (data, from) => heard.broadcast(from, port, data));
    return () => close(socket);
  });

  // mDNS: one socket on the group, kept while any service type is wanted; each type asked for while it is.
  let mdns: Socket | null = null;
  const mdnsSocket = new Wanted<'mdns'>(() => {
    mdns = bound(MDNS.port, 'mDNS', MDNS.address, (data, from) => heard.mdns(from, readMessage(data)));
    return () => {
      if (mdns) close(mdns);
      mdns = null;
    };
  });
  const services = new Wanted<string>((service) => {
    mdnsSocket.add('mdns');
    const stop = asking(() => sendEverywhere(mdns, ptrQuery([`${service}.local`]), MDNS.port, MDNS.address, (error) => log('warn', `[lan] Asking for ${service}: ${error.message}`)));
    return () => {
      stop();
      mdnsSocket.remove('mdns');
    };
  });

  // SSDP: announcements on the group, and a socket of its own to search from — answers come back to it, not to the group.
  let search: Socket | null = null;
  const ssdpSockets = new Wanted<'ssdp'>(() => {
    const group = bound(SSDP.port, 'SSDP', SSDP.address, (data, from) => heard.ssdp(from, new TextDecoder().decode(data)));
    search = bound(0, 'SSDP search', null, (data, from) => heard.ssdp(from, new TextDecoder().decode(data)));
    return () => {
      close(group);
      if (search) close(search);
      search = null;
    };
  });
  const targets = new Wanted<string>((st) => {
    ssdpSockets.add('ssdp');
    const message = new TextEncoder().encode(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP.address}:${SSDP.port}`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${st}`, '', ''].join('\r\n'));
    const stop = asking(() => sendEverywhere(search, message, SSDP.port, SSDP.address, (error) => log('warn', `[lan] Searching for ${st}: ${error.message}`)));
    return () => {
      stop();
      ssdpSockets.remove('ssdp');
    };
  });

  /** What one matcher needs listened for, and asked. A target with a wildcard is searched for as everything, and matched as it is. */
  const keysOf = (matcher: Matcher): { ports?: number; services?: string; targets?: string } | null => {
    if (matcher.kind === 'broadcast') return { ports: matcher.port };
    if (matcher.kind === 'mdns') return { services: matcher.service.toLowerCase() };
    if (matcher.kind === 'ssdp') return { targets: matcher.st.includes('*') ? 'ssdp:all' : matcher.st };
    return null;
  };

  return {
    want(matchers) {
      const keys = matchers.map(keysOf).filter((key) => key !== null);
      for (const key of keys) {
        if (key.ports !== undefined) ports.add(key.ports);
        if (key.services) services.add(key.services);
        if (key.targets) targets.add(key.targets);
      }
      return () => {
        for (const key of keys) {
          if (key.ports !== undefined) ports.remove(key.ports);
          if (key.services) services.remove(key.services);
          if (key.targets) targets.remove(key.targets);
        }
      };
    },
    sightings: (matchers) => heard.sightings(matchers),
    onHeard(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop() {
      for (const each of [targets, services, ports, ssdpSockets, mdnsSocket] as Wanted<unknown>[]) each.stopAll();
      listeners.clear();
    },
  };
}
