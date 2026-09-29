import { describe, expect, test } from 'bun:test';

import { checkValue, enumLabel, valueTypeProblems, type EnumValue, type ValueOf, type ValueType } from './values.ts';

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

  test('a time is an instant, kept in UTC', () => {
    expect(checkValue({ type: 'timestamp' }, '2026-09-29T09:00:00+02:00')).toEqual({ ok: true, value: '2026-09-29T07:00:00.000Z' });
    expect(checkValue({ type: 'timestamp' }, '29 September')).toEqual({ ok: false, problem: 'must be a time, like 2026-09-29T07:00:00Z' });
    expect(checkValue({ type: 'timestamp' }, '2026-09-29')).toMatchObject({ ok: false });
  });

  test('a list and an object are checked all the way down, saying where', () => {
    const hour = {
      type: 'object',
      fields: { at: { type: 'timestamp' }, cloud: { type: 'number', min: 0, max: 100 } },
      required: ['at'],
    } as const satisfies ValueType;
    const forecast = { type: 'list', of: hour } as const satisfies ValueType;
    expect(checkValue(forecast, [{ at: '2026-09-29T07:00:00Z', cloud: 40 }, { at: '2026-09-29T08:00:00Z' }])).toEqual({
      ok: true,
      value: [
        { at: '2026-09-29T07:00:00.000Z', cloud: 40 },
        { at: '2026-09-29T08:00:00.000Z', cloud: null },
      ],
    });
    expect(checkValue(forecast, [{ at: '2026-09-29T07:00:00Z', cloud: 140 }])).toEqual({ ok: false, problem: '[0].cloud must be at most 100' });
    expect(checkValue(forecast, [{ cloud: 4 }])).toEqual({ ok: false, problem: '[0].at must be given' });
    expect(checkValue(forecast, [{ at: '2026-09-29T07:00:00Z', rain: 1 }])).toEqual({ ok: false, problem: '[0] has no field "rain"' });
    expect(checkValue(forecast, 'sunny')).toEqual({ ok: false, problem: 'must be a list' });

    // And TypeScript reads the same declaration: the answer's type is derived from it.
    const typed: ValueOf<typeof forecast> = [{ at: '2026-09-29T07:00:00Z', cloud: null }];
    expect(typed[0]!.at).toBe('2026-09-29T07:00:00Z');
  });

  test('a declared type with a mistake in it says where', () => {
    expect(valueTypeProblems('answer', { type: 'list', of: { type: 'object', fields: {} } })).toEqual(['answer[] is an object with no fields']);
    expect(valueTypeProblems('answer', { type: 'object', fields: { a: { type: 'boolean' } }, required: ['b'] })).toEqual(['answer requires "b", which it does not have']);
  });

  test('an enum value is shown by its label, or as itself when it is not an option', () => {
    expect(enumLabel(MODES, 'boost')).toBe('Boost');
    expect(enumLabel(MODES, 'new-firmware-mode')).toBe('new-firmware-mode');
  });
});
