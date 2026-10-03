import { describe, expect, test } from 'bun:test';

import type { AttributeSpec, Quantity } from '@kraftverk/device-sdk';

import { fixedRange, formatValue, isOld, shownAttributes, startsAtZero } from './measurement.ts';

/** An attribute the way these cases think of it: a quantity, a unit, a precision — or an on/off. */
const spec = (over: { key?: string; unit?: string; kind?: Quantity | 'on/off'; precision?: number; primary?: boolean; category?: AttributeSpec['category'] } = {}): AttributeSpec => {
  const kind = over.kind ?? 'power';
  return {
    key: over.key ?? 'x',
    label: 'X',
    value: kind === 'on/off' ? { type: 'boolean' } : { type: 'number', unit: over.unit ?? 'W', ...(over.precision !== undefined ? { precision: over.precision } : {}) },
    ...(kind !== 'on/off' ? { quantity: kind } : {}),
    ...(over.primary ? { category: 'primary' as const } : over.category ? { category: over.category } : {}),
  };
};

describe('formatValue', () => {
  test('a missing reading is a dash, never a zero', () => {
    // The distinction the whole device model rests on: a device that has not
    // reported is not a device reporting nothing.
    expect(formatValue(spec(), null)).toBe('—');
    expect(formatValue(spec(), 0)).toBe('0 W');
  });

  test('watts become kilowatts where a person would say kilowatts', () => {
    expect(formatValue(spec(), 950)).toBe('950 W');
    expect(formatValue(spec(), 1800)).toBe('1.80 kW');
    // What rounds to a kilowatt is one; a flow the other way too.
    expect(formatValue(spec(), 999.6)).toBe('1.00 kW');
    expect(formatValue(spec(), -1500)).toBe('-1.50 kW');
    expect(formatValue(spec(), -0.3)).toBe('0 W');
  });

  test('what rounds to nothing has no sign', () => {
    expect(formatValue(spec({ kind: 'current', unit: 'A', precision: 2 }), -0.001)).toBe('0.00 A');
    expect(formatValue(spec({ kind: 'current', unit: 'A', precision: 2 }), -0.5)).toBe('-0.50 A');
  });

  test('a length of time is rounded once, to what it shows', () => {
    const minutes = (value: number) => formatValue(spec({ kind: 'duration', unit: 'min' }), value);
    expect([59.6, 119.7, 2870, 65, 120, 0.5].map(minutes)).toEqual(['1h', '2h', '2d', '1h 5m', '2h', '30s']);
    expect(formatValue(spec({ kind: 'duration', unit: 's' }), 20)).toBe('20s');
    // None at all is a length, not nothing said.
    expect(formatValue(spec({ kind: 'duration', unit: 's' }), 0)).toBe('0 s');
  });

  test('a power measurement in something other than watts keeps its own unit', () => {
    expect(formatValue(spec({ unit: 'kW', precision: 1 }), 1.8)).toBe('1.8 kW');
  });

  test('percentages carry the declared precision', () => {
    expect(formatValue(spec({ kind: 'percent', unit: '%', precision: 1 }), 87.25)).toBe('87.3%');
    expect(formatValue(spec({ kind: 'percent', unit: '%' }), 87.25)).toBe('87%');
  });

  test('durations are read as time, not as a count of minutes', () => {
    const runtime = spec({ kind: 'duration', unit: 'min' });
    expect(formatValue(runtime, 90)).toBe('1h 30m');
    // A P280 sitting idle genuinely reports multi-week runtimes.
    expect(formatValue(runtime, 20_000)).toBe('13d 21h');
  });

  test('a duration declared in seconds is converted before it is read', () => {
    expect(formatValue(spec({ kind: 'duration', unit: 's' }), 5400)).toBe('1h 30m');
  });

  test('an on/off reads as on or off whichever way it was expressed', () => {
    const port = spec({ kind: 'on/off', unit: '' });
    expect(formatValue(port, true)).toBe('On');
    expect(formatValue(port, false)).toBe('Off');
    expect(formatValue(port, 1)).toBe('On');
    expect(formatValue(port, 0)).toBe('Off');
  });

  test('an on/off with words of its own reads in them, from history too', () => {
    const alarm: AttributeSpec = { key: 'alarm', label: 'Alarm', value: { type: 'boolean', words: { true: 'Armed', false: 'Not armed' } } };
    expect(formatValue(alarm, true)).toBe('Armed');
    expect(formatValue(alarm, false)).toBe('Not armed');
    expect(formatValue(alarm, 0)).toBe('Not armed');
  });

  test('degrees hug their number, other units take a space', () => {
    expect(formatValue(spec({ kind: 'temperature', unit: '°C' }), 21.4)).toBe('21.4°C');
    expect(formatValue(spec({ kind: 'voltage', unit: 'V' }), 230.15)).toBe('230.2 V');
  });

  test('a unitless number is not left with a trailing space', () => {
    expect(formatValue(spec({ kind: 'frequency', unit: '' }), 50)).toBe('50.00');
  });

  test('an operating mode shows its label, and one the type does not know shows as itself', () => {
    const mode: AttributeSpec = { key: 'state', label: 'Doing', value: { type: 'enum', options: [{ value: 'charging', label: 'Charging' }] } };
    expect(formatValue(mode, 'charging')).toBe('Charging');
    expect(formatValue(mode, 'bootloader')).toBe('bootloader');
  });

  test('an infinite value is reported as unknown rather than drawn', () => {
    expect(formatValue(spec(), Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatValue(spec(), Number.NaN)).toBe('—');
  });
});

describe('axis decisions', () => {
  test('zero is a floor only where zero means nothing is happening', () => {
    expect(startsAtZero('power')).toBe(true);
    expect(startsAtZero('percent')).toBe(true);
    // 230 V ± 5 against a zero-based axis is a flat line in a corner.
    expect(startsAtZero('voltage')).toBe(false);
    expect(startsAtZero('temperature')).toBe(false);
  });

  test('only a percentage has bounds the data cannot argue with', () => {
    expect(fixedRange('percent')).toEqual([0, 100]);
    expect(fixedRange('power')).toBeNull();
  });
});

describe('an old value', () => {
  test('is one observed longer ago than its attribute says a value stays current', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const reading = { key: 'x', value: 12, at: '2026-09-29T11:30:00Z' };
    expect(isOld(spec(), reading, now)).toBe(true);
    // A forecast, fetched half an hour ago, is current for an hour.
    expect(isOld({ ...spec(), currentFor: 3_600_000 }, reading, now)).toBe(false);
    // What was never said is not old: it is not known.
    expect(isOld(spec(), { ...reading, value: null }, now)).toBe(false);
    expect(isOld(spec(), undefined, now)).toBe(false);
  });
});

describe('what a card shows', () => {
  test('the declared primary leads, whatever order they are in', () => {
    const list = [spec({ key: 'a' }), spec({ key: 'b', primary: true })];
    expect(shownAttributes(list).map((attribute) => attribute.key)).toEqual(['b', 'a']);
  });

  test('settings and diagnostics are not on a card', () => {
    const list = [spec({ key: 'signal', category: 'diagnostic' }), spec({ key: 'watts' }), spec({ key: 'limit', category: 'config' })];
    expect(shownAttributes(list).map((attribute) => attribute.key)).toEqual(['watts']);
  });

  test('a device that reports nothing shows nothing', () => {
    expect(shownAttributes([])).toEqual([]);
  });

});
