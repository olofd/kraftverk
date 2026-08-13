import { describe, expect, test } from 'bun:test';

import type { MeasurementSpec } from '@kraftverk/plugin-sdk';

import {
  fixedRange,
  formatMeasurement,
  primaryMeasurement,
  readingFor,
  startsAtZero,
} from './measurement';

const spec = (over: Partial<MeasurementSpec> = {}): MeasurementSpec => ({
  key: 'x',
  label: 'X',
  unit: 'W',
  kind: 'power',
  ...over,
});

describe('formatMeasurement', () => {
  test('a missing reading is a dash, never a zero', () => {
    // The distinction the whole device model rests on: a device that has not
    // reported is not a device reporting nothing.
    expect(formatMeasurement(spec(), null)).toBe('—');
    expect(formatMeasurement(spec(), 0)).toBe('0 W');
  });

  test('watts become kilowatts where a person would say kilowatts', () => {
    expect(formatMeasurement(spec(), 950)).toBe('950 W');
    expect(formatMeasurement(spec(), 1800)).toBe('1.80 kW');
  });

  test('a power measurement in something other than watts keeps its own unit', () => {
    expect(formatMeasurement(spec({ unit: 'kW', precision: 1 }), 1.8)).toBe('1.8 kW');
  });

  test('percentages carry the declared precision', () => {
    expect(formatMeasurement(spec({ kind: 'percent', unit: '%', precision: 1 }), 87.25)).toBe('87.3%');
    expect(formatMeasurement(spec({ kind: 'percent', unit: '%' }), 87.25)).toBe('87%');
  });

  test('durations are read as time, not as a count of minutes', () => {
    const runtime = spec({ kind: 'duration', unit: 'min' });
    expect(formatMeasurement(runtime, 90)).toBe('1h 30m');
    // A P280 sitting idle genuinely reports multi-week runtimes.
    expect(formatMeasurement(runtime, 20_000)).toBe('13d 21h');
  });

  test('a duration declared in seconds is converted before it is read', () => {
    expect(formatMeasurement(spec({ kind: 'duration', unit: 's' }), 5400)).toBe('1h 30m');
  });

  test('state reads as on or off whichever way the driver expressed it', () => {
    const port = spec({ kind: 'state', unit: '' });
    expect(formatMeasurement(port, true)).toBe('On');
    expect(formatMeasurement(port, false)).toBe('Off');
    expect(formatMeasurement(port, 1)).toBe('On');
    expect(formatMeasurement(port, 0)).toBe('Off');
  });

  test('degrees hug their number, other units take a space', () => {
    expect(formatMeasurement(spec({ kind: 'temperature', unit: '°C' }), 21.4)).toBe('21.4°C');
    expect(formatMeasurement(spec({ kind: 'voltage', unit: 'V' }), 230.15)).toBe('230.2 V');
  });

  test('a unitless number is not left with a trailing space', () => {
    expect(formatMeasurement(spec({ kind: 'frequency', unit: '' }), 50)).toBe('50.00');
  });

  test('an infinite value is reported as unknown rather than drawn', () => {
    expect(formatMeasurement(spec(), Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatMeasurement(spec(), Number.NaN)).toBe('—');
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
    expect(fixedRange('state')).toEqual([0, 1]);
    expect(fixedRange('power')).toBeNull();
  });
});

describe('picking measurements', () => {
  test('the declared primary wins, whatever order they are in', () => {
    const list = [spec({ key: 'a' }), spec({ key: 'b', primary: true })];
    expect(primaryMeasurement(list)?.key).toBe('b');
  });

  test('without a declared primary the first one leads', () => {
    expect(primaryMeasurement([spec({ key: 'a' }), spec({ key: 'b' })])?.key).toBe('a');
  });

  test('a device that measures nothing has no primary', () => {
    expect(primaryMeasurement([])).toBeNull();
  });

  test('a reading is found by key, and absence is undefined rather than a guess', () => {
    const readings = [{ key: 'soc', value: 80, at: '2026-01-01T00:00:00.000Z' }];
    expect(readingFor(readings, 'soc')?.value).toBe(80);
    expect(readingFor(readings, 'missing')).toBeUndefined();
  });
});
