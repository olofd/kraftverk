import { describe, expect, test } from 'bun:test';

import { ago, cadence, every, soon } from './words.ts';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const before = (ms: number) => new Date(NOW - ms).toISOString();
const after = (ms: number) => new Date(NOW + ms).toISOString();

describe('what a Find My device’s screen says of time', () => {
  test('how long ago it was located', () => {
    expect(ago(before(20_000), NOW)).toBe('just now');
    expect(ago(before(4 * 60_000), NOW)).toBe('4 min ago');
    expect(ago(before(125 * 60_000), NOW)).toBe('2 h 5 min ago');
    expect(ago(before(3 * 86_400_000), NOW)).toBe('3 days ago');
    // A clock a little ahead of the server's is not "in the future".
    expect(ago(after(5_000), NOW)).toBe('just now');
  });

  test('when it is looked for next, and how often — and why that often', () => {
    expect(soon(after(30_000), NOW)).toBe('any moment');
    expect(soon(after(11 * 60_000), NOW)).toBe('in about 11 min');
    expect(every(60)).toBe('every minute');
    expect(every(900)).toBe('every 15 min');
    expect(cadence(after(11 * 60_000), 900, NOW)).toBe('Looks again in about 11 min · every 15 min while it is still');
    expect(cadence(after(40_000), 60, NOW)).toBe('Looks again any moment · every minute while this page is open');
    expect(cadence(after(90_000), 120, NOW)).toBe('Looks again in about 2 min · every 2 min while it moves');
    expect(cadence(null, null, NOW)).toBeNull();
  });
});
