/**
 * Writes to a device, from the moment they are asked for until the device says
 * they happened.
 *
 * A control that writes to hardware must not move until the hardware has
 * answered, and nothing read *before* that answer may move it either. Both
 * rules were broken, and a switch showed it: tapped off, it jumped back on and
 * then off again, because the telemetry poll kept running while the write was
 * in flight and its answer described the station as it was before the write.
 * A setting did the same whenever a poll the server answered before the write
 * arrived after it.
 *
 * So every write goes through one of these, whatever device and whatever link:
 *
 * - While it is in flight its keys are *pending*. The control shows the value
 *   that was asked for, and is locked: there is no second tap to race the
 *   first. Everything else keeps updating — the caller draws the pending values
 *   over whatever arrives, so a reading taken mid-write cannot move them.
 * - Any read asked for before a write *finished* is discarded when it arrives
 *   after, however late: it may describe the device before the write reached
 *   it. `epoch` counts finished writes, and `fresh` says whether any finished
 *   since an answer was asked for.
 * - The write's own answer — a readback, never an echo of what was asked — is
 *   what the screen shows afterwards.
 *
 * Only a write's end makes an answer stale, not its start or its duration.
 * Freezing every reading while anything was in flight stopped a whole screen
 * for as long as the slowest write — thirty seconds for a relay the station has
 * to confirm, during which the very reading being waited for could not show.
 *
 * Deliberately free of React, so it is tested on its own and used by every
 * provider the same way.
 */

export type WriteSnapshot<Key extends string> = {
  /** How many writes have finished. An answer asked for before the latest is stale. */
  readonly epoch: number;
  /** What was asked for, per key, while its write is in flight. */
  readonly pending: ReadonlyMap<Key, unknown>;
};

/** A write to something that is already being written. The control should have been locked. */
export class WriteInFlightError extends Error {}

export class WriteGate<Key extends string = string> {
  #snapshot: WriteSnapshot<Key> = { epoch: 0, pending: new Map() };
  #listeners = new Set<() => void>();

  get epoch(): number {
    return this.#snapshot.epoch;
  }

  get pending(): ReadonlyMap<Key, unknown> {
    return this.#snapshot.pending;
  }

  /** The current state, replaced rather than mutated, so every change is a new value to render. */
  snapshot = (): WriteSnapshot<Key> => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Whether an answer to a read asked for at `askedAt` may be shown.
   *
   * Not if a write finished since it was asked: the device may have answered
   * before the write reached it, and the write's own readback is the better
   * answer. One that arrives while a write is still in flight may be shown —
   * the caller draws the pending values over it.
   */
  fresh(askedAt: number): boolean {
    return askedAt === this.#snapshot.epoch;
  }

  /**
   * Runs one write, holding `values` as pending until it settles either way.
   *
   * Refused when any of those keys is already being written. The control
   * should be locked by then; refusing is what keeps two writes to one
   * register from being in flight together if one is not.
   */
  async run<T>(values: Partial<Record<Key, unknown>>, write: () => Promise<T>): Promise<T> {
    const keys = Object.keys(values) as Key[];
    const busy = keys.filter((key) => this.#snapshot.pending.has(key));
    if (busy.length) throw new WriteInFlightError(`Still waiting for the device to confirm ${busy.join(', ')}`);

    this.#update(false, (pending) => {
      for (const key of keys) pending.set(key, values[key]);
    });
    try {
      return await write();
    } finally {
      this.#update(true, (pending) => {
        for (const key of keys) pending.delete(key);
      });
    }
  }

  #update(finished: boolean, change: (pending: Map<Key, unknown>) => void): void {
    const pending = new Map(this.#snapshot.pending);
    change(pending);
    this.#snapshot = { epoch: this.#snapshot.epoch + (finished ? 1 : 0), pending };
    for (const listener of this.#listeners) listener();
  }
}
