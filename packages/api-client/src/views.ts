import type { ShownThing, ViewReport } from '@kraftverk/api-contract';

/*
  What this app's screen shows, as the home is told it (`ViewReport`,
  docs/API.md): the screen, by its route — `device/[id]`, never an id — and
  the things on it, each said by the part of the screen that shows it.

  A fact, not a request: the home judges what follows. Said when it
  changes, settled so a screen opening says it once; again when someone uses
  the app, at most once a minute, so the home knows it is still attended.
  Pure, so it is tested without a screen.
*/

/** Using the app says again what it shows, at most this often: the home takes ten minutes of silence for nobody there. */
export const SAY_AGAIN_AFTER_MS = 60_000;
/** Changes within this are said once. */
export const SETTLE_MS = 250;

export type Views = {
  /** The screen now, by its route. */
  screen(name: string): void;
  /** Part of a screen shows these, until the returned release. */
  show(things: readonly ShownThing[]): () => void;
  /** Someone used the app. */
  used(): void;
  /** What the screen shows now: said each time the stream opens. */
  current(): ViewReport;
};

type Clock = {
  now: () => number;
  later: (run: () => void, ms: number) => unknown;
  cancel: (timer: unknown) => void;
};

const SYSTEM_CLOCK: Clock = {
  now: Date.now,
  later: (run, ms) => setTimeout(run, ms),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const keyOf = (thing: ShownThing) => `${thing.kind}:${thing.id}`;

export function createViews(say: (view: ViewReport) => void, clock: Clock = SYSTEM_CLOCK): Views {
  let screen = 'home';
  const shown = new Map<number, readonly ShownThing[]>();
  let next = 1;
  let said: string | null = null;
  let saidAt = -Infinity;
  let pending: unknown = null;

  const current = (): ViewReport => {
    // Each thing once, however many parts of the screen show it — up close when any shows it so: a device's page over the list it was opened from.
    const things = new Map<string, ShownThing>();
    for (const list of shown.values()) {
      for (const thing of list) {
        const before = things.get(keyOf(thing));
        const close = (before && 'close' in before && before.close) || ('close' in thing && thing.close);
        things.set(keyOf(thing), close ? { ...thing, close: true } as ShownThing : thing);
      }
    }
    return { type: 'view', screen, showing: [...things.values()] };
  };
  const sayNow = () => {
    pending = null;
    const view = current();
    said = JSON.stringify(view);
    saidAt = clock.now();
    say(view);
  };
  // Said once things settle, and only if it changed.
  const changed = () => {
    if (pending !== null) clock.cancel(pending);
    pending = clock.later(() => {
      pending = null;
      if (JSON.stringify(current()) !== said) sayNow();
    }, SETTLE_MS);
  };

  return {
    screen(name) {
      if (name === screen) return;
      screen = name;
      changed();
    },
    show(things) {
      const id = next++;
      shown.set(id, things);
      changed();
      return () => {
        if (shown.delete(id)) changed();
      };
    },
    used() {
      if (pending === null && clock.now() - saidAt >= SAY_AGAIN_AFTER_MS) sayNow();
    },
    current() {
      const view = current();
      said = JSON.stringify(view);
      saidAt = clock.now();
      return view;
    },
  };
}
