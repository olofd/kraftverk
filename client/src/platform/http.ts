import type { ScopedHttp } from '@kraftverk/device-sdk';

/**
 * `fetch` with a timeout it cannot do without, for a setup helper that
 * calls a vendor's API once — fetching a key — in a home the app keeps
 * itself. Never for reaching a device: that is a transport's job. Its own
 * timer rather than `AbortSignal.timeout`, which a phone may not have.
 */
export const appHttp: ScopedHttp = (url, init = {}) => {
  const { timeoutMs = 15_000, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${new URL(url).host} did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return fetch(url, { ...rest, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });
};
