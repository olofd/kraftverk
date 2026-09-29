import { describe, expect, test } from 'bun:test';

import { checkValue, enumLabel, type EnumValue } from './values.ts';

/*
  One value system for attributes, command arguments, event data and config.
  What it takes, what it refuses, and what it says when it refuses.
*/

const MODES: EnumValue = { type: 'enum', options: [{ value: 'eco', label: 'Eco' }, { value: 'boost', label: 'Boost' }] };

describe('checking a value', () => {
  test('a number within its range is kept; outside it, the range is named', () => {
    const percent = { type: 'number', min: 0, max: 100 } as const;
    expect(checkValue(percent, 42)).toEqual({ ok: true, value: 42 });
    expect(checkValue(percent, 101)).toEqual({ ok: false, problem: 'must be at most 100' });
    expect(checkValue(percent, -1)).toEqual({ ok: false, problem: 'must be at least 0' });
  });

  test('a number typed as text is taken; empty text and a boolean are not numbers', () => {
    expect(checkValue({ type: 'number' }, '7.5')).toEqual({ ok: true, value: 7.5 });
    expect(checkValue({ type: 'number' }, '')).toEqual({ ok: false, problem: 'must be a number' });
    expect(checkValue({ type: 'number' }, true)).toEqual({ ok: false, problem: 'must be a number' });
  });

  test('an integer must be whole', () => {
    expect(checkValue({ type: 'number', integer: true }, 2.5)).toEqual({ ok: false, problem: 'must be a whole number' });
  });

  test('an enum takes only its options, and says which they are', () => {
    expect(checkValue(MODES, 'eco')).toEqual({ ok: true, value: 'eco' });
    expect(checkValue(MODES, 'turbo')).toEqual({ ok: false, problem: 'must be one of: eco, boost' });
  });

  test('a boolean is true or false, never a truthy string', () => {
    expect(checkValue({ type: 'boolean' }, false)).toEqual({ ok: true, value: false });
    expect(checkValue({ type: 'boolean' }, 'true')).toEqual({ ok: false, problem: 'must be true or false' });
  });

  test('an enum value is shown by its label, or as itself when it is not an option', () => {
    expect(enumLabel(MODES, 'boost')).toBe('Boost');
    expect(enumLabel(MODES, 'new-firmware-mode')).toBe('new-firmware-mode');
  });
});
