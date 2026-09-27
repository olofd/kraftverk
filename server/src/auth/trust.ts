import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Whether a request comes from the home network — and so, when the owner has
 * chosen to trust it, needs no login.
 *
 * The obvious rule, "the caller's address is private", is the dangerous one.
 * Through a reverse proxy every request arrives from the proxy, and the proxy
 * is on the LAN: DSM's reverse proxy and the web container both are. Judge
 * those by address and the whole internet looks like the living room.
 *
 * So the decision is made by *which door* a request came through, and only
 * falls back to the address for a caller that connected directly:
 *
 * - **Through the web container.** It has two entrances, and stamps every
 *   request with the one it used: `lan` or `public`, overwriting whatever the
 *   client sent. DSM's reverse proxy is pointed at the public one. The stamp is
 *   believed only from the web container itself, recognised by address.
 * - **Directly** — dev on this machine, or port 3333 on the LAN. Trusted when
 *   the address is private and nothing says a proxy was involved: a request
 *   carrying forwarding headers came through some proxy this server does not
 *   know, and a proxy it does not know could be forwarding the internet.
 *
 * Everything ambiguous is untrusted. The cost of being wrong in that direction
 * is a login prompt; in the other, it is the station.
 */

export type Exposure = 'lan' | 'public';

/** The stamp the web container puts on every request it forwards. */
export const EXPOSURE_HEADER = 'x-kraftverk-exposure';
/** The client address the web container saw, for rate limits and the audit log only. */
export const CLIENT_IP_HEADER = 'x-kraftverk-client-ip';

/** Headers that mean "a proxy handled this" when a proxy we know did not. */
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', EXPOSURE_HEADER];

export type TrustInput = {
  /** The address of whatever opened the TCP connection. */
  socketIp: string | null;
  headers: Headers;
  /** Addresses of the web container, the one proxy whose stamp is believed. */
  proxies: ReadonlySet<string>;
};

export type Trust = {
  /** On the home network, by the rules above. Whether that is enough to skip the login is a setting. */
  onHomeNetwork: boolean;
  /** The address to rate-limit and to write in the audit log. Never a basis for trust on its own. */
  clientIp: string | null;
  /** Why, in words, for the app to show and for tests to pin. */
  reason: string;
};

export function assessTrust({ socketIp, headers, proxies }: TrustInput): Trust {
  const socket = normaliseIp(socketIp);

  if (socket && proxies.has(socket)) {
    const exposure = headers.get(EXPOSURE_HEADER);
    const clientIp = normaliseIp(headers.get(CLIENT_IP_HEADER)) ?? socket;
    if (exposure === 'lan') {
      return { onHomeNetwork: true, clientIp, reason: 'Came through the web app’s home-network entrance' };
    }
    return {
      onHomeNetwork: false,
      clientIp,
      reason: exposure === 'public' ? 'Came through the web app’s public entrance' : 'Came through the web app without saying which entrance',
    };
  }

  const forwarded = FORWARDING_HEADERS.find((name) => headers.has(name));
  if (forwarded) {
    return { onHomeNetwork: false, clientIp: socket, reason: `Came through a proxy this server does not know (${forwarded})` };
  }
  if (!socket) return { onHomeNetwork: false, clientIp: null, reason: 'The caller’s address is unknown' };
  if (isPrivate(socket)) return { onHomeNetwork: true, clientIp: socket, reason: `Connected directly from ${socket}, a home-network address` };
  return { onHomeNetwork: false, clientIp: socket, reason: `Connected from ${socket}, which is not a home-network address` };
}

/** `::ffff:192.168.1.5` → `192.168.1.5`; brackets and zones dropped; anything unparseable → null. */
export function normaliseIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

/**
 * Private and loopback ranges: RFC 1918, loopback, and IPv6 unique-local.
 *
 * Deliberately not link-local, and not 100.64/10: carrier-grade NAT and VPN
 * overlays such as Tailscale live there, and whether those count as "home" is
 * not something to assume.
 */
export function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/**
 * The web container's addresses, kept current.
 *
 * Named, not numbered — `KRAFTVERK_TRUSTED_PROXIES=web` — because compose hands
 * out addresses as it pleases, and resolved again every half-minute because it
 * hands out a new one whenever the container is recreated. Literal addresses
 * are accepted too, for setups without Docker's DNS.
 */
export class ProxyDirectory {
  #names: string[];
  #addresses = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(spec: string | undefined) {
    this.#names = (spec ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  }

  get addresses(): ReadonlySet<string> {
    return this.#addresses;
  }

  async refresh(): Promise<void> {
    const next = new Set<string>();
    for (const name of this.#names) {
      const literal = normaliseIp(name);
      if (literal) {
        next.add(literal);
        continue;
      }
      try {
        for (const { address } of await lookup(name, { all: true })) {
          const ip = normaliseIp(address);
          if (ip) next.add(ip);
        }
      } catch {
        // Not resolvable right now — the web container may simply not be up
        // yet. It is then trusted for nothing, which is the safe way round.
      }
    }
    this.#addresses = next;
  }

  start(everyMs = 30_000): void {
    if (this.#names.length === 0 || this.#timer) return;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), everyMs);
    this.#timer.unref?.();
  }
}
