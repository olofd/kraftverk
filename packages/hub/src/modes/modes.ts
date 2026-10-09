import { MODE_AXES, REAL_CLOCK, SYSTEM, type Actor, type Clock, type ClockTimer, type ModeAxis } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';
import type { ModeStore, PlaceStore } from '@kraftverk/store';

/*
  A home's modes, kept (docs/PLAN-WORLD-MODEL.md §8.10): which mode each home
  is in on each axis, said on the bus as it begins — set by a person, an
  automation or presence, or come round on the clock, as a vacation planned
  ahead does, looked at the moment the next one is due. What began while
  nobody listened is said when the home starts again. Every home is in a mode
  on each axis — home, and day, until something says otherwise. What ended
  more than two years ago is let go.
*/

/** The longest the clock is left unlooked at, whatever is planned: a clock set back is caught up within it. */
const LOOK_AT_LEAST_EVERY_MS = 5 * 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
/** How long a home's modes are kept. */
const MODES_KEPT_DAYS = 2 * 365;
/** What a home is in on each axis before anything says otherwise. */
const FIRST_MODES: Readonly<Record<ModeAxis, string>> = { presence: 'home', day: 'day' };

export type ModesDeps = {
  store: ModeStore;
  places: Pick<PlaceStore, 'homes'>;
  bus: Pick<LiveBus, 'publish'>;
  clock?: Clock;
};

export class Modes {
  readonly #deps: ModesDeps;
  readonly #clock: Clock;
  #timer: ClockTimer | null = null;
  #pruneTimer: ClockTimer | null = null;
  #started = false;

  constructor(deps: ModesDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? REAL_CLOCK;
  }

  start(): void {
    this.#started = true;
    this.look();
    this.#pruneTimer ??= this.#clock.setInterval(() => this.prune(), PRUNE_EVERY_MS);
  }

  stop(): void {
    this.#started = false;
    this.#clock.clear(this.#timer);
    this.#clock.clear(this.#pruneTimer);
    this.#timer = null;
    this.#pruneTimer = null;
  }

  /** A home's mode on an axis now: its key, or null when none is set. */
  now(homeId: string, axis: ModeAxis): string | null {
    const kept = this.#deps.store.at(homeId, axis, this.#iso());
    return kept ? (this.#deps.store.get(kept.modeId)?.key ?? null) : null;
  }

  /**
   * A home set to a mode — by its id or its key — from now unless said, for
   * good or until a time; said on the bus at once when that is now, with the
   * automations whose runs led to it (`cause`, outermost first): what lets an
   * automation tell a change it caused itself.
   */
  set(homeId: string, mode: string, by: Actor, from?: string, until?: string | null, cause: readonly string[] = []): void {
    const { store } = this.#deps;
    const found = store.get(mode) ?? store.byKey(mode);
    if (!found || found.removedAt) throw new Error(`There is no mode "${mode}"`);
    store.set(homeId, found.id, by, from ?? this.#iso(), until ?? null);
    this.look(cause);
  }

  /** A mode planned ahead let go: what was before it lasts on. Whether there was one. */
  cancel(homeId: string, axis: ModeAxis, since: string): boolean {
    const gone = this.#deps.store.cancel(homeId, axis, since, this.#iso());
    if (gone) this.look();
    return gone;
  }

  /**
   * Every home, each axis: a home in no mode given its first, said as it
   * is; a mode other than the one last said, said — once, from that one —
   * and the clock looked at again when the next is due.
   */
  look(cause: readonly string[] = []): void {
    const { store, places, bus } = this.#deps;
    const at = this.#iso();
    for (const home of places.homes()) {
      for (const axis of MODE_AXES) {
        let now = store.at(home.id, axis, at);
        if (!now) {
          store.set(home.id, FIRST_MODES[axis], SYSTEM, at);
          now = store.at(home.id, axis, at)!;
          store.saidNow(home.id, axis, now.modeId, at);
        }
        const said = store.said(home.id, axis);
        if (said === now.modeId) continue;
        store.saidNow(home.id, axis, now.modeId, at);
        // Never said before — a home restored, a database new: what it is in is no change.
        if (said === null) continue;
        const mode = store.get(now.modeId)?.key;
        if (!mode) continue;
        bus.publish({ kind: 'mode', homeId: home.id, axis, mode, previous: store.get(said)?.key ?? null, by: now.by, cause: now.by.kind === 'automation' ? cause : [], at: now.since });
      }
    }
    this.#again(at);
  }

  prune(now = this.#clock.now()): void {
    this.#deps.store.prune(new Date(now - MODES_KEPT_DAYS * 86_400_000).toISOString());
  }

  /** The next look: when the next interval begins or ends, at the latest a few minutes on. */
  #again(at: string): void {
    if (!this.#started) return;
    this.#clock.clear(this.#timer);
    const next = this.#deps.store.nextChange(at);
    const wait = next ? Math.min(LOOK_AT_LEAST_EVERY_MS, Date.parse(next) - this.#clock.now()) : LOOK_AT_LEAST_EVERY_MS;
    this.#timer = this.#clock.setTimeout(() => this.look(), Math.max(0, wait) + 5);
  }

  #iso(): string {
    return new Date(this.#clock.now()).toISOString();
  }
}
