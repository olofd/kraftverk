import { describe, expect, test } from 'bun:test';

import { automationId, savedDeviceId } from '@kraftverk/device-sdk';

import { Attention, UNATTENDED_AFTER_MS } from './attention.ts';
import { FRESH_PAST_LOOK_MS, keepWatchedFresh } from './freshness.ts';

const PLUG = savedDeviceId('d-plug');
const STATION = savedDeviceId('d-station');
const CHARGING = automationId('a-charging');

describe('what the people using kraftverk are looking at', () => {
  test('each app says what its screen shows; what is attended is all of it, until an app closes', () => {
    const attention = new Attention();
    const phone = attention.open('olof');
    const laptop = attention.open('anna');
    phone.report({ type: 'view', screen: 'device', showing: [{ kind: 'device', id: PLUG }] });
    laptop.report({ type: 'view', screen: 'home', showing: [{ kind: 'device', id: PLUG }, { kind: 'device', id: STATION }, { kind: 'automation', id: CHARGING }] });
    expect(attention.attended('device')).toEqual(new Set([PLUG, STATION]));
    expect(attention.attended('automation')).toEqual(new Set([CHARGING]));
    expect(attention.watched({ kind: 'device', id: STATION })).toBe(true);
    expect(attention.viewers().map((viewer) => [viewer.person, viewer.screen])).toEqual([
      ['olof', 'device'],
      ['anna', 'home'],
    ]);

    // A screen changed: what it shows now replaces what it showed.
    laptop.report({ type: 'view', screen: 'automations', showing: [] });
    expect(attention.attended('device')).toEqual(new Set([PLUG]));
    // Closed: nothing of it is attended.
    phone.close();
    expect(attention.watched({ kind: 'device', id: PLUG })).toBe(false);
    expect(attention.viewers()).toHaveLength(1);
  });

  test('an app that says nothing for ten minutes is not attended — a page left open in a tab — until it says something again', () => {
    let now = 1_000_000;
    const attention = new Attention(() => now);
    const tab = attention.open(null);
    tab.report({ type: 'view', screen: 'device', showing: [{ kind: 'device', id: PLUG }] });
    now += UNATTENDED_AFTER_MS - 1;
    expect(attention.watched({ kind: 'device', id: PLUG })).toBe(true);
    now += 1;
    expect(attention.watched({ kind: 'device', id: PLUG })).toBe(false);
    // Still open, and listed: only not attended.
    expect(attention.viewers()).toHaveLength(1);
    tab.report({ type: 'view', screen: 'device', showing: [{ kind: 'device', id: PLUG }] });
    expect(attention.watched({ kind: 'device', id: PLUG })).toBe(true);
  });

  test('whoever listens is told when an app says what it shows, or closes; one listener failing stops no other', () => {
    const attention = new Attention();
    let told = 0;
    const logged: unknown[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    attention.onChange(() => {
      throw new Error('a broken listener');
    });
    const stop = attention.onChange(() => void (told += 1));
    const app = attention.open(null);
    app.report({ type: 'view', screen: 'home', showing: [] });
    app.close();
    app.close();
    expect(told).toBe(2);
    stop();
    attention.open(null).report({ type: 'view', screen: 'home', showing: [] });
    expect(told).toBe(2);
    console.error = error;
    // The broken one, each time: said, and nothing else stopped.
    expect(logged).toHaveLength(3);
  });
});

describe('a device someone is looking at is read more often', () => {
  test('at once when it is opened, renewed on a clock while it is looked at, and never for a device nobody looks at', async () => {
    const attention = new Attention();
    const wished: { device: string; until: number }[] = [];
    const stop = keepWatchedFresh(attention, (device, until) => void wished.push({ device, until }));
    const app = attention.open(null);
    app.report({ type: 'view', screen: 'home', showing: [] });
    expect(wished).toEqual([]);

    const before = Date.now();
    app.report({ type: 'view', screen: 'device', showing: [{ kind: 'device', id: PLUG }, { kind: 'automation', id: CHARGING }] });
    expect(wished.map((wish) => wish.device)).toEqual([PLUG]);
    expect(wished[0]!.until).toBeGreaterThanOrEqual(before + FRESH_PAST_LOOK_MS);
    expect(wished[0]!.until).toBeLessThanOrEqual(Date.now() + FRESH_PAST_LOOK_MS);

    // Left: nothing more is wished; what was lapses by itself.
    app.close();
    const count = wished.length;
    app.report({ type: 'view', screen: 'device', showing: [{ kind: 'device', id: STATION }] });
    expect(wished).toHaveLength(count);
    stop();
  });
});
