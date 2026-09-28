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
  platforms: ['server', 'web', 'native'],
  discovery: { server: 'none', web: 'none', native: 'none' },
};

export default definition;

/** Where an address points: an HTTPS origin, and nothing else. */
export function originOf(address: string): string {
  const url = new URL(address);
  if (url.protocol !== 'https:') throw new Error(`${address} is not an HTTPS address`);
  return url.origin;
}

/**
 * A channel to one origin, over whatever `fetch` the platform has. The same on
 * every platform, which is why each platform's entry is two lines.
 */
export function httpChannel(address: string, fetcher: typeof fetch = fetch): HttpChannel {
  const origin = originOf(address);
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
      if (url.origin !== origin) throw new Error(`${url.origin} is not ${origin}, which is all this connection may reach`);
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
    describe: () => ({ origin, connected }),
    async close() {
      listeners.clear();
    },
  };
}
