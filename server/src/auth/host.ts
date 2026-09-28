import type { MiddlewareHandler } from 'hono';
import { isIP } from 'node:net';

/**
 * Refuses requests addressed to a name this server does not answer to.
 *
 * The attack this stops is DNS rebinding. A page on `evil.example` makes its
 * own name resolve to this machine's LAN address. The browser then considers
 * requests to it same-origin — no CORS, no preflight, custom headers allowed —
 * and they arrive from the victim's own LAN address.
 *
 * It cannot ride a session: browsers keep cookies by host name, and this
 * server's cookie is not `evil.example`'s. What it *can* do is act as the home
 * network — and the home network is what may create the first account. On a
 * fresh server, a rebinding page in any browser on the LAN could claim it.
 *
 * The only thing that gives the game away is the `Host` header: it still says
 * `evil.example`, because that is the name the browser thinks it is talking to.
 *
 * So a request must name this server as one of:
 *
 * - an IP address — `192.168.1.140:8080`, `127.0.0.1`. Rebinding needs a
 *   name; an address cannot be rebound.
 * - `localhost`, or a `.local`/`.localhost` name — resolved on this network
 *   by mDNS or the machine itself, never by an attacker's DNS.
 * - a single-label name — a Docker service such as `kraftverk`, or a
 *   Windows machine name. Resolved through local search domains only.
 * - a name listed in `KRAFTVERK_ALLOWED_HOSTS`, or the host of an origin in
 *   `ALLOWED_ORIGINS` — the public DDNS name, say. Configured where the
 *   deployment is, not in this repository.
 */

export function allowedHosts(env: Record<string, string | undefined> = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const entry of (env.KRAFTVERK_ALLOWED_HOSTS ?? '').split(',')) {
    const host = entry.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  for (const entry of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    try {
      hosts.add(new URL(entry.trim()).hostname.toLowerCase());
    } catch {
      // Not an origin; `*` and the like are handled, and refused, elsewhere.
    }
  }
  return hosts;
}

/** The name from a `Host` header, without its port or IPv6 brackets. */
export function hostName(header: string | undefined | null): string | null {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : null;
  }
  // One colon is a port; more than one, unbracketed, is not a valid Host.
  const parts = value.split(':');
  if (parts.length > 2) return null;
  return parts[0] || null;
}

/**
 * A name only this network can resolve: an address, `localhost`, a `.local`
 * or `.localhost` name, or a single label. Anything else is a name from public
 * DNS — which is how the internet addresses a server, and never how the home
 * network has to.
 */
export function isLocalName(host: string): boolean {
  if (isIP(host)) return true;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return true;
  return /^[a-z0-9-]+$/.test(host); // single label
}

export function hostAllowed(header: string | undefined | null, configured: ReadonlySet<string>): boolean {
  const host = hostName(header);
  if (!host) return false;
  return isLocalName(host) || configured.has(host);
}

export function hostGuard(configured: ReadonlySet<string> = allowedHosts()): MiddlewareHandler {
  return async (c, next) => {
    if (!hostAllowed(c.req.header('host'), configured)) {
      return c.json(
        {
          error:
            'This server does not answer to that name. If it is yours — a DDNS name, say — add it to ' +
            'KRAFTVERK_ALLOWED_HOSTS on the server.',
        },
        421
      );
    }
    await next();
  };
}
