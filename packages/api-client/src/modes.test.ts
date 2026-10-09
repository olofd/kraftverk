import { describe, expect, test } from 'bun:test';

import { plannedProblem, typedTime } from './modes.ts';

describe('a time typed to plan a mode', () => {
  test('a day, or a day and a time, on this clock', () => {
    expect(typedTime('2026-10-12')).toBe(new Date(2026, 9, 12).toISOString());
    expect(typedTime(' 2026-10-12 08:30 ')).toBe(new Date(2026, 9, 12, 8, 30).toISOString());
  });

  test('a day there is not is refused, not rolled over', () => {
    expect(typedTime('2026-02-31')).toBeNull();
    expect(typedTime('2026-13-01')).toBeNull();
    expect(typedTime('2026-10-12 24:00')).toBeNull();
    expect(typedTime('next week')).toBeNull();
  });

  test('a plan ends after it begins', () => {
    expect(plannedProblem('2026-10-12', '')).toBeNull();
    expect(plannedProblem('2026-10-12', '2026-10-19')).toBeNull();
    expect(plannedProblem('2026-10-12', '2026-10-12')).toBe('It ends before it begins');
    expect(plannedProblem('2026-02-30', '')).toContain('From');
    expect(plannedProblem('', '')).toBeNull();
  });
});
