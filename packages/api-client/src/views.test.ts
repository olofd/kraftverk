import { describe, expect, test } from 'bun:test';

import type { ShownThing, ViewReport } from '@kraftverk/api-contract';

import { createViews, SAY_AGAIN_AFTER_MS, SETTLE_MS } from './views';

/** A clock the test moves by hand. */
function handClock() {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  return {
    clock: {
      now: () => now,
      later: (run: () => void, ms: number) => {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return timer;
      },
      cancel: (timer: unknown) => void (timers = timers.filter((candidate) => candidate !== timer)),
    },
    pass(ms: number) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.run();
    },
  };
}

const plug: ShownThing = { kind: 'device', id: 'd-plug' as never };
const station: ShownThing = { kind: 'device', id: 'd-station' as never };

describe('what the app tells the server its screen shows', () => {
  test('a screen opening is said once, when it settles: its route and everything its parts show, each once', () => {
    const said: ViewReport[] = [];
    const { clock, pass } = handClock();
    const views = createViews((view) => void said.push(view), clock);
    views.screen('device/[id]');
    views.show([plug]);
    views.show([plug, station]);
    expect(said).toEqual([]);
    pass(SETTLE_MS);
    expect(said).toEqual([{ type: 'view', screen: 'device/[id]', showing: [plug, station] }]);
  });

  test('a part let go is said; nothing that did not change is said again', () => {
    const said: ViewReport[] = [];
    const { clock, pass } = handClock();
    const views = createViews((view) => void said.push(view), clock);
    const release = views.show([plug]);
    pass(SETTLE_MS);
    release();
    pass(SETTLE_MS);
    expect(said.map((view) => view.showing)).toEqual([[plug], []]);
    // Shown and let go within the settling: nothing changed, nothing said.
    views.show([station])();
    pass(SETTLE_MS);
    expect(said).toHaveLength(2);
  });

  test('using the app says it again, at most once a minute, so the server knows someone is there', () => {
    const said: ViewReport[] = [];
    const { clock, pass } = handClock();
    const views = createViews((view) => void said.push(view), clock);
    views.show([plug]);
    pass(SETTLE_MS);
    views.used();
    expect(said).toHaveLength(1);
    pass(SAY_AGAIN_AFTER_MS);
    views.used();
    views.used();
    expect(said).toHaveLength(2);
    expect(said[1]).toEqual(said[0]!);
  });

  test('what it shows now is there for a stream that opens, and counts as said', () => {
    const said: ViewReport[] = [];
    const { clock, pass } = handClock();
    const views = createViews((view) => void said.push(view), clock);
    expect(views.current()).toEqual({ type: 'view', screen: 'home', showing: [] });
    views.used();
    expect(said).toEqual([]);
    pass(SAY_AGAIN_AFTER_MS);
    views.used();
    expect(said).toHaveLength(1);
  });
});
