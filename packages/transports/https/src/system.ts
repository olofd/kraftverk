import type { Transport, TransportFactory } from '@kraftverk/device-sdk';

import definition, { httpChannel } from './index.ts';

/** HTTPS from the server: the platform's `fetch`, one origin per channel. */
const createHttpsTransport: TransportFactory = (): Transport => ({
  definition,
  available: () => ({ ok: true }),
  async start() {},
  async stop() {},
  async open(address, options) {
    return httpChannel(address, fetch, options.alsoOrigins);
  },
});

export default createHttpsTransport;
