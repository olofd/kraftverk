import { describe, expect, test } from 'bun:test';

import type { Reading } from '@kraftverk/device-sdk';

import { FRESH_AGAIN_MS, ReadingChanges } from '../src/bus.ts';

/*
  What a stream passes on of a device's readings: what moved, and — the
  value the same — a time that moved enough, so "located a minute ago" stays
  true while a plug polled every two seconds sends nothing new.
*/

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const reading = (key: string, value: Reading['value'], ms: number): Reading => ({ key, value, at: at(ms) });

describe('reading changes', () => {
  test('a value that moved is passed on; the same value polled again is not, until its time moved a minute', () => {
    const changes = new ReadingChanges();
    expect(changes.since('d', [reading('power', 5, 0)])).toHaveLength(1);
    expect(changes.since('d', [reading('power', 5, 2_000)])).toHaveLength(0);
    expect(changes.since('d', [reading('power', 6, 4_000)])).toHaveLength(1);
    // Located afresh at the same place, a minute on: its new time is news.
    expect(changes.since('d', [reading('power', 6, 4_000 + FRESH_AGAIN_MS)])).toEqual([reading('power', 6, 4_000 + FRESH_AGAIN_MS)]);
    // Forgotten, everything is new again.
    changes.forget('d');
    expect(changes.since('d', [reading('power', 6, 4_000 + FRESH_AGAIN_MS)])).toHaveLength(1);
  });
});
