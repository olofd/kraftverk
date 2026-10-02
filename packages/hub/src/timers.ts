/**
 * Lets a timer not keep its process alive: a server's sweeper or sampler must
 * not hold a test run, or a stopping server, open. A browser's and a phone's
 * timers have no such thing, and need none.
 */
export function unref(timer: unknown): void {
  (timer as { unref?: () => void } | null)?.unref?.();
}
