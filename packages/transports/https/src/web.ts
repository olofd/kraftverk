import type { Transport, TransportFactory } from '@kraftverk/device-sdk';

import definition, { httpChannel } from './index.ts';

/**
 * HTTPS from the app, in a browser or on a phone: the same one-origin channel
 * over the platform's `fetch`. A browser still applies its own rules — an API
 * that sends no CORS headers cannot be reached from a page — and an error says
 * so rather than being hidden.
 */
const createHttpsTransport: TransportFactory = (): Transport => ({
  definition,
  available: () => ({ ok: true }),
  async start() {},
  async stop() {},
  async open(address) {
    return httpChannel(address);
  },
});

export default createHttpsTransport;
