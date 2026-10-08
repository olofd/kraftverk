import { REAL_CLOCK, type Actor, type Clock, type ClockTimer } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';
import type { ModeAxis } from '@kraftverk/api-contract';
import { MODE_AXES, type ModeStore, type PlaceStore } from '@kraftverk/store';

/*
  A home's modes, kept (docs/PLAN-WORLD-MODEL.md §8.10): which mode each home
  is in on each axis, said on the bus the moment it changes — set by a
  person, an automation or presence, or come round on the clock, as a
  vacation planned ahead does. What ended more than two years ago is let go.
*/

/** How often the clock is looked at: a mode planned ahead begins within this. */
const LOOK_EVERY_MS = 30_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
/** How long a home's modes are kept. */
export const MODES_KEPT_DAYS = 2 * 365;

export type ModesDeps = {
  store: ModeStore;
  places: Pick<PlaceStore, 'homes'>;
  bus: Pick<LiveBus, 'publish'>;
  clock?: Clock;
};

export class Modes {
  readonly #deps: ModesDeps;
  readonly #clock: Clock;
  /** What each home was last seen in, by home and axis: a mode's key, or null for none set. */
  readonly #seen = new Map<string, string | null>();
  #timer: ClockTimer | null = null;
  #pruneTimer: ClockTimer | null = null;

  constructor(deps: ModesDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? REAL_CLOCK;
  }

  start(): void {
    // What each home is in as it starts is what it was: nothing changed by starting.
    this.look(this.#clock.now(), false);
    this.#timer ??= this.#clock.setInterval(() => this.look(), LOOK_EVERY_MS);
    this.#pruneTimer ??= this.#clock.setInterval(() => this.prune(), PRUNE_EVERY_MS);
  }

  stop(): void {
    this.#clock.clear(this.#timer);
    this.#clock.clear(this.#pruneTimer);
    this.#timer = null;
    this.#pruneTimer = null;
  }

  /** A home's mode on an axis now: its key, or null when none is set. */
  now(homeId: string, axis: ModeAxis): string | null {
    const kept = this.#deps.store.at(homeId, axis, new Date(this.#clock.now()).toISOString());
    return kept ? (this.#deps.store.get(kept.modeId)?.key ?? null) : null;
  }

  /**
   * A home set to a mode — by its id or its key — from now unless said, for
   * good or until a time; said on the bus at once when that is now.
   */
  set(homeId: string, mode: string, by: Actor, from?: string, until?: string | null): void {
    const { store } = this.#deps;
    const found = store.get(mode) ?? store.byKey(mode);
    if (!found || found.removedAt) throw new Error(`There is no mode "${mode}"`);
    store.set(homeId, found.id, by, from ?? new Date(this.#clock.now()).toISOString(), until ?? null);
    this.look();
  }

  /** Every home, each axis: a change since the last look said on the bus. */
  look(now = this.#clock.now(), say = true): void {
    const at = new Date(now).toISOString();
    for (const home of this.#deps.places.homes()) {
      for (const axis of MODE_AXES) {
        const id = `${home.id} ${axis}`;
        const mode = this.now(home.id, axis);
        const was = this.#seen.get(id);
        this.#seen.set(id, mode);
        if (!say || was === undefined || was === mode || mode === null) continue;
        this.#deps.bus.publish({ kind: 'mode', homeId: home.id, axis, mode, previous: was, at });
      }
    }
  }

  prune(now = this.#clock.now()): void {
    this.#deps.store.prune(new Date(now - MODES_KEPT_DAYS * 86_400_000).toISOString());
  }
}
