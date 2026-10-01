import { describe, expect, test } from 'bun:test';

import { nextSaid } from './said';

/* An automation that has not run yet says what comes next — never what starts it as if it had happened. */

describe('what comes next', () => {
  test('a time is next, a repeat runs, a condition is waited for', () => {
    expect(nextSaid('At 07:00 on weekdays')).toBe('Next at 07:00 on weekdays');
    expect(nextSaid('Every day at 07:00')).toBe('Next at 07:00, every day');
    expect(nextSaid('Every 15 min')).toBe('Runs every 15 min');
    expect(nextSaid('When Station’s charge is below 15 % for 2 min')).toBe('Waiting: Station’s charge is below 15 % for 2 min');
    expect(nextSaid('On Station’s Mains lost')).toBe('On Station’s Mains lost');
  });
});
