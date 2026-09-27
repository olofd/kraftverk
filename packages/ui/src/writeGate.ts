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
 *   first.
 * - Any read asked for before the write finished is discarded when it arrives,
 *   however late. `epoch` moves on every write's start and end, and `fresh`
 *   says whether an answer's epoch is still the current one.
 * - The write's own answer — a readback, never an echo of what was asked — is
 *   what the screen shows afterwards.
 *
 * Deliberately free of React, so it is tested on its own and used by every
 * provider the same way.
 */

export type WriteSnapshot<Key extends string> = {
  /** Moves whenever a write starts or ends. */
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

  /** The current state, replaced rather than mutated, for `useSyncExternalStore`. */
  snapshot = (): WriteSnapshot<Key> => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Whether an answer to a read asked for at `askedAt` may be shown.
   *
   * Not if any write started or ended since it was asked: the device may have
   * answered before the write reached it. And not while a write is in flight,
   * because the write's own readback is on its way and is the better answer.
   */
  fresh(askedAt: number): boolean {
    return askedAt === this.#snapshot.epoch && this.#snapshot.pending.size === 0;
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

    this.#update((pending) => {
      for (const key of keys) pending.set(key, values[key]);
    });
    try {
      return await write();
    } finally {
      this.#update((pending) => {
        for (const key of keys) pending.delete(key);
      });
    }
  }

  #update(change: (pending: Map<Key, unknown>) => void): void {
    const pending = new Map(this.#snapshot.pending);
    change(pending);
    this.#snapshot = { epoch: this.#snapshot.epoch + 1, pending };
    for (const listener of this.#listeners) listener();
  }
}
