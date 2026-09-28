/**
 * What every holder keeps an eye on while a device is open: whether it still
 * reaches the device it was added as, and whether its connection has been
 * down long enough to try the next one (docs/DATA-MODEL.md §4).
 */

/** A connection down this long falls back to the device's next one, when it has one. */
export const FAILOVER_MS = 2 * 60_000;

/**
 * What a device saying who it is means for the device it was added as:
 * nothing yet, the same one, the first time it has said (learn it), or a
 * different device — nothing it says is this device's.
 */
export function identityVerdict(expected: string | null, said: string | null | undefined): 'unknown' | 'same' | 'learnt' | 'mismatch' {
  if (!said) return 'unknown';
  if (!expected) return 'learnt';
  return said.toLowerCase() === expected.toLowerCase() ? 'same' : 'mismatch';
}

/**
 * When each connection went down, and which have been passed over for a
 * while. A connection passed over is not chosen again until the time is up,
 * unless it is the only one.
 */
export class Failover {
  #down = new Map<string, number>();
  #avoid = new Map<string, number>();

  constructor(private options: { afterMs?: number; now?: () => number } = {}) {}

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Records whether a connection reaches its device now. */
  note(connectionId: string, connected: boolean): void {
    if (connected) this.#down.delete(connectionId);
    else if (!this.#down.has(connectionId)) this.#down.set(connectionId, this.#now());
  }

  /** How long it has been down, in ms, or null while it is up. */
  downFor(connectionId: string): number | null {
    const since = this.#down.get(connectionId);
    return since === undefined ? null : this.#now() - since;
  }

  /**
   * Whether to give up on this connection now: down too long, and the device
   * has another to try. Passes it over for a while when it says yes.
   */
  due(connectionId: string, hasAnother: boolean): boolean {
    const after = this.options.afterMs ?? FAILOVER_MS;
    const down = this.downFor(connectionId);
    if (down === null || down <= after || !hasAnother) return false;
    this.#avoid.set(connectionId, this.#now() + after);
    this.#down.delete(connectionId);
    return true;
  }

  /** Whether this connection is being passed over after failing. */
  avoided(connectionId: string): boolean {
    return (this.#avoid.get(connectionId) ?? 0) > this.#now();
  }

  forget(connectionId: string): void {
    this.#down.delete(connectionId);
  }
}
