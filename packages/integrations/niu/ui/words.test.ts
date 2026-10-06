import { describe, expect, test } from 'bun:test';

import type { Value } from '@kraftverk/device-sdk';

import { ago } from '../src/report.ts';
import { doingOf, levelTone, reportLine, span } from './words.ts';

const reading = (values: Record<string, Value>) => (key: string): Value => values[key] ?? null;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const before = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('what it is doing', () => {
  test('charging says when it will be full; full says so', () => {
    expect(doingOf(reading({ charging: true, soc: 55, minutesToFull: 158, range: 30 }))).toMatchObject({ title: 'Charging', detail: 'Full in about 2 h 38 min', tone: 'success', moving: true });
    expect(doingOf(reading({ charging: true, soc: 100 })).detail).toBe('Full');
  });

  test('parked says how far it goes, and that nothing moves', () => {
    expect(doingOf(reading({ charging: false, online: true, poweredOn: false, soc: 70, range: 38.4 }))).toEqual({ title: 'Parked', detail: 'About 38 km of range', tone: 'muted', moving: false });
  });

  test('switched on, and nothing yet', () => {
    expect(doingOf(reading({ poweredOn: true, charging: false, range: 20 }))).toMatchObject({ title: 'Switched on', moving: true });
    expect(doingOf(reading({})).title).toBe('Nothing reported yet');
  });
});

describe('when it reported', () => {
  const parked = doingOf(reading({ charging: false, soc: 70 }));
  const charging = doingOf(reading({ charging: true, soc: 40 }));

  test('parked, an old report still holds, and says why', () => {
    expect(reportLine(before(5), parked, NOW)).toEqual({ text: 'Reported to NIU 5 minutes ago', stale: false });
    expect(reportLine(before(3 * 24 * 60), parked, NOW)).toEqual({ text: 'Reported to NIU 3 days ago · parked, so its charge still holds', stale: false });
  });

  test('charging, a report older than NIU’s rhythm may have moved on', () => {
    expect(reportLine(before(2), charging, NOW).stale).toBe(false);
    expect(reportLine(before(45), charging, NOW)).toEqual({ text: 'Reported to NIU 45 minutes ago · NIU has heard nothing since, so it may have moved on', stale: true });
  });

  test('none yet', () => {
    expect(reportLine(null, parked, NOW)).toEqual({ text: 'It has not reported to NIU yet', stale: false });
  });
});

test('spans, ages and levels in words', () => {
  expect([span(45), span(120), span(158)]).toEqual(['45 min', '2 h', '2 h 38 min']);
  expect([ago(before(0), NOW), ago(before(1), NOW), ago(before(90), NOW), ago(before(3 * 24 * 60), NOW)]).toEqual(['just now', '1 minute ago', '2 hours ago', '3 days ago']);
  expect([levelTone(10), levelTone(25), levelTone(80), levelTone(null)]).toEqual(['danger', 'warning', 'normal', 'normal']);
});
