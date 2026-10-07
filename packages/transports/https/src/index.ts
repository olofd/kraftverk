import type { HttpChannel, TransportDefinition } from '@kraftverk/device-sdk';

/**
 * The internet, over HTTPS: how a service — a weather forecast, a price feed —
 * is reached. What the transport is, the same everywhere.
 *
 * Not exclusive: two weather devices may use the same API. And scoped: a
 * channel reaches exactly one origin, its address, so a device type that asked
 * for api.open-meteo.com cannot quietly call anywhere else.
 */
const definition: TransportDefinition = {
  id: 'https',
  label: 'the internet',
  channel: 'http',
  exclusive: false,
  nearby: false,
  platforms: ['system', 'web', 'native'],
  discovery: { system: 'none', web: 'none', native: 'none' },
  finds: [],
  background: false,
};

export default definition;

/** Where an address points: an HTTPS origin, and nothing else. */
export function originOf(address: string): string {
  const url = new URL(address);
  if (url.protocol !== 'https:') throw new Error(`${address} is not an HTTPS address`);
  return url.origin;
}

/**
 * Whether a URL is one a channel may reach: its own origin, a declared one,
 * or under a declared pattern — `https://*.icloud.com`, any host under that
 * domain, over HTTPS on its own port: a service whose hosts are numbered,
 * and told at sign-in (`p42-fmipweb.icloud.com`).
 */
function allows(declared: readonly string[], url: URL): boolean {
  return declared.some((each) => {
    if (!each.startsWith('https://*.')) return each === url.origin;
    const domain = each.slice('https://*.'.length);
    return url.protocol === 'https:' && url.port === '' && url.hostname.endsWith(`.${domain}`);
  });
}

/** A declared origin, or a pattern of them: an HTTPS origin with `*.` before its domain. */
const declaredOf = (address: string): string => {
  if (!address.includes('*')) return originOf(address);
  if (/^https:\/\/\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(address)) return address;
  throw new Error(`${address} is not a domain to reach every host under: https://*.example.com`);
};

/**
 * A channel to one origin — and to the few its protocol declares beside it —
 * over whatever `fetch` the platform has. The same on every platform, which is
 * why each platform's entry is two lines.
 */
export function httpChannel(address: string, fetcher: typeof fetch = fetch, alsoOrigins: readonly string[] = []): HttpChannel {
  const origin = originOf(address);
  const allowed = new Set([origin, ...alsoOrigins.map(declaredOf)]);
  let connected = true;
  const listeners = new Set<(connected: boolean) => void>();
  const set = (next: boolean) => {
    if (next === connected) return;
    connected = next;
    for (const listener of [...listeners]) listener(next);
  };

  return {
    kind: 'http',
    get connected() {
      return connected;
    },
    onConnectedChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async fetch(path, init) {
      const url = new URL(path, origin);
      if (!allows([...allowed], url)) throw new Error(`${url.origin} is not ${[...allowed].join(' or ')}, which is all this connection may reach`);
      const { timeoutMs = 10_000, ...rest } = init ?? {};
      try {
        const response = await fetcher(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
        set(true);
        return response;
      } catch (error) {
        // Unreachable, as opposed to answering with an error status.
        set(false);
        throw error;
      }
    },
    describe: () => ({ origin, ...(allowed.size > 1 ? { alsoOrigins: [...allowed].filter((other) => other !== origin) } : {}), connected }),
    async close() {
      listeners.clear();
    },
  };
}
