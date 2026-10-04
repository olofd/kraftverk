/**
 * Time, as a port (docs/ARCHITECTURE.md): what "now" is, and work done after
 * a while or every so often. Everything that keeps time — the automation
 * engine's holds and ticks, the gateway's pause between switches and how
 * fresh a reading must be, a holder's looks at its devices, a simulator's
 * battery — reads the one clock its home was started with, so the home keeps
 * one time.
 *
 * The real clock is real time. A scaled clock runs faster — a day in minutes
 * — so a home of simulated devices can be lived through in a test: allowed
 * only where nothing reaches hardware, because every pause that protects a
 * relay is that much shorter too.
 */

/** A timer a clock started: what it is cleared with. */
export type ClockTimer = { readonly clock: 'timer' };

export interface Clock {
  /** Now, on this clock: milliseconds since 1970, as `Date.now()`. */
  now(): number;
  /** Runs `task` once, `ms` of this clock's time from now. */
  setTimeout(task: () => void, ms: number): ClockTimer;
  /** Runs `task` every `ms` of this clock's time. */
  setInterval(task: () => void, ms: number): ClockTimer;
  /** Stops a timer it started; one already done or cleared is no matter. */
  clear(timer: ClockTimer | null | undefined): void;
  /** How many times faster than real time it runs: 1, real time. */
  readonly rate: number;
}

type Native = ReturnType<typeof setTimeout>;

/** A native timer, as a clock's: unreferenced, so a timer alone never keeps a process up. */
const wrap = (native: Native): ClockTimer => {
  (native as { unref?: () => void }).unref?.();
  return native as unknown as ClockTimer;
};

const clearNative = (timer: ClockTimer | null | undefined): void => {
  if (!timer) return;
  clearTimeout(timer as unknown as Native);
  clearInterval(timer as unknown as Native);
};

/** Real time. */
export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (task, ms) => wrap(setTimeout(task, Math.max(0, ms))),
  setInterval: (task, ms) => wrap(setInterval(task, Math.max(1, ms))),
  clear: clearNative,
  rate: 1,
};

/** The shortest real time between two runs of a scaled clock's repeating work: faster would only load the machine. */
export const SHORTEST_INTERVAL_MS = 10;

/**
 * A clock `rate` times faster than real time, starting from the real now: at
 * 1000, a minute passes in 60 ms, and a 2-minute hold in 120. Repeating work
 * runs at most every `SHORTEST_INTERVAL_MS` of real time — so what is looked
 * at every second at 1000 is looked at every 10 s of its time.
 */
export function scaledClock(rate: number): Clock {
  if (!(Number.isFinite(rate) && rate >= 1)) throw new Error(`A clock runs at 1 or faster, not ${rate}`);
  if (rate === 1) return REAL_CLOCK;
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * rate,
    setTimeout: (task, ms) => wrap(setTimeout(task, Math.max(0, ms / rate))),
    setInterval: (task, ms) => wrap(setInterval(task, Math.max(SHORTEST_INTERVAL_MS, ms / rate))),
    clear: clearNative,
    rate,
  };
}

/** A pause of `ms` on a clock. */
export const sleep = (clock: Clock, ms: number): Promise<void> => new Promise((resolve) => clock.setTimeout(resolve, ms));
