import type { ScopedHttp } from '@kraftverk/device-sdk';

/**
 * `fetch` with a mandatory timeout, for a setup helper that calls a vendor's
 * API once — fetching a key. Never for reaching a device: that is a
 * transport's job, and the `https` transport scopes each channel to one origin.
 */
export const scopedHttp: ScopedHttp = (url, init = {}) => {
  const { timeoutMs = 15_000, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout;
  return fetch(url, { ...rest, signal });
};
