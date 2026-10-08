import type { ShownThing, ViewReport } from '@kraftverk/api-contract';

/*
  What the people using kraftverk are looking at, now.

  Each app with the live stream open says what its screen shows (a
  `ViewReport`): which screen, and the things on it. The server keeps it here
  while the stream is open, and nowhere else — it is about now, not a
  history. Whatever wants to know asks: whether anyone attends to a thing,
  everything attended to, who is looking. What follows from it is each
  asker's own judgement — a device someone looks at read more often, a cloud
  account polled faster while its page is open — so an app says what it
  shows, never what to do.

  An app that says nothing for a while is taken for unattended: a page left
  open in a tab overnight is not someone watching. Using the app says so
  again, at most once a minute.
*/

/** An app that has said nothing for this long is not attended. */
export const UNATTENDED_AFTER_MS = 10 * 60_000;

/** The id a kind of shown thing has: a device's, an automation's. */
type IdOf<K extends ShownThing['kind']> = Extract<ShownThing, { kind: K }>['id'];

/** One app with the stream open, as it last said. */
export type Viewer = {
  readonly id: number;
  /** Who is signed in on it. */
  readonly person: string | null;
  readonly openedAt: number;
  screen: string | null;
  showing: readonly ShownThing[];
  /** When it last said what it shows. */
  saidAt: number;
};

/** An app's place in the register: what it says, until it closes. */
export type ViewerHandle = {
  report(view: ViewReport): void;
  close(): void;
};

export class Attention {
  readonly #viewers = new Map<number, Viewer>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  #next = 1;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** An app opened the stream: it is looking at nothing yet. */
  open(person: string | null): ViewerHandle {
    const id = this.#next++;
    const at = this.#now();
    this.#viewers.set(id, { id, person, openedAt: at, screen: null, showing: [], saidAt: at });
    return {
      report: (view) => {
        const viewer = this.#viewers.get(id);
        if (!viewer) return;
        viewer.screen = view.screen;
        viewer.showing = view.showing;
        viewer.saidAt = this.#now();
        this.#changed();
      },
      close: () => {
        if (this.#viewers.delete(id)) this.#changed();
      },
    };
  }

  /** Every app with the stream open, attended or not, as it last said. */
  viewers(): readonly Readonly<Viewer>[] {
    return [...this.#viewers.values()].map((viewer) => ({ ...viewer }));
  }

  /** The ids of everything of a kind an attended app shows. */
  attended<K extends ShownThing['kind']>(kind: K): Set<IdOf<K>> {
    const ids = new Set<string>();
    for (const viewer of this.#attendedViewers()) for (const thing of viewer.showing) if (thing.kind === kind) ids.add(thing.id);
    return ids as Set<IdOf<K>>;
  }

  /** The devices an attended app shows up close: their own page open, not one of many in a list. */
  attendedClose(): Set<Extract<ShownThing, { kind: 'device' }>['id']> {
    const ids = new Set<string>();
    for (const viewer of this.#attendedViewers()) for (const thing of viewer.showing) if (thing.kind === 'device' && thing.close) ids.add(thing.id);
    return ids as Set<Extract<ShownThing, { kind: 'device' }>['id']>;
  }

  /** Whether an attended app shows it. */
  watched(thing: ShownThing): boolean {
    return this.#attendedViewers().some((viewer) => viewer.showing.some((shown) => shown.kind === thing.kind && shown.id === thing.id));
  }

  /**
   * Told when an app says what it shows, or closes. An app falling quiet
   * tells nothing: it is judged when asked, so an asker that acts on what is
   * attended asks again on its own clock.
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #attendedViewers(): Viewer[] {
    const since = this.#now() - UNATTENDED_AFTER_MS;
    return [...this.#viewers.values()].filter((viewer) => viewer.saidAt > since);
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[attention] A listener failed:', error);
      }
    }
  }
}
