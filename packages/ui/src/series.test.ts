import { describe, expect, test } from 'bun:test';

import { chartPath, chartScale, chartSegments, chartY, type SeriesPoint } from './series';

const MINUTE = 60_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');

/** `n` samples a minute apart, unless a stride is given. */
const run = (values: number[], strideMs = MINUTE, from = START): SeriesPoint[] =>
  values.map((value, index) => ({ at: new Date(from + index * strideMs).toISOString(), value }));

describe('chartScale', () => {
  test('a percentage is 0–100 no matter what the data did', () => {
    const scale = chartScale(run([41, 43, 42]), { kind: 'percent' });
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(100);
    // The real extremes are still reported; they are just not the axis.
    expect(scale.peak).toBe(43);
    expect(scale.trough).toBe(41);
  });

  test('power starts at zero, because zero is a thing that happened', () => {
    const scale = chartScale(run([400, 1200, 800]), { kind: 'power' });
    expect(scale.min).toBe(0);
    expect(scale.max).toBeGreaterThan(1200);
  });

  test('voltage does not, or the interesting range is a few pixels tall', () => {
    const scale = chartScale(run([229, 231, 230]), { kind: 'voltage' });
    expect(scale.min).toBeGreaterThan(220);
    expect(scale.max).toBeLessThan(240);
    expect(scale.min).toBeLessThan(229);
    expect(scale.max).toBeGreaterThan(231);
  });

  test('a negative reading pulls the floor below zero rather than being clipped', () => {
    // Export to the grid is real, and a chart that hides it is lying.
    const scale = chartScale(run([-300, 0, 500]), { kind: 'power' });
    expect(scale.min).toBeLessThanOrEqual(-300);
  });

  test('a flat line still gets a range, so it draws as a line and not a divide by zero', () => {
    const scale = chartScale(run([230, 230, 230]), { kind: 'voltage' });
    expect(scale.max).toBeGreaterThan(scale.min);
    expect(Number.isFinite(chartY(230, scale, 100))).toBe(true);
  });

  test('no points is a range, not a crash', () => {
    const scale = chartScale([], { kind: 'power' });
    expect(scale.max).toBeGreaterThan(scale.min);
  });
});

describe('chartSegments', () => {
  test('an unbroken series is one run', () => {
    expect(chartSegments(run([1, 2, 3, 4]))).toEqual([[0, 3]]);
  });

  test('a silence longer than three intervals breaks the line', () => {
    // Two minutes of samples, an hour of nothing, two more minutes.
    const before = run([1, 2, 3]);
    const after = run([4, 5, 6], MINUTE, START + 60 * MINUTE);
    expect(chartSegments([...before, ...after])).toEqual([
      [0, 2],
      [3, 5],
    ]);
  });

  test('a thinned series is judged by its own spacing, not by the sampler’s minute', () => {
    // A fortnight thinned to 240 points is ~84 minutes apart and perfectly
    // continuous; a fixed one-minute threshold would shatter it into 240 runs.
    const points = run(Array.from({ length: 20 }, (_, index) => index), 84 * MINUTE);
    expect(chartSegments(points)).toEqual([[0, 19]]);
  });

  test('a lone point on the far side of a gap is dropped rather than drawn as nothing', () => {
    const points = [...run([1, 2, 3]), ...run([9], MINUTE, START + 60 * MINUTE)];
    // A single point has no line; keeping it would emit a path with one vertex.
    expect(chartSegments(points)).toEqual([[0, 2]]);
  });

  test('fewer than two points cannot be a line', () => {
    expect(chartSegments([])).toEqual([]);
    expect(chartSegments(run([1]))).toEqual([]);
  });
});

describe('chartPath', () => {
  test('positions are keyed to the whole series, so a gap leaves a hole', () => {
    const points = [...run([0, 0, 0]), ...run([0, 0, 0], MINUTE, START + 60 * MINUTE)];
    const [first, second] = chartSegments(points);
    const box = { width: 100, height: 10 };
    const scale = chartScale(points, { kind: 'power' });

    // The whole series spans 62 minutes, and the second run begins at minute
    // 60 — so it starts near the right edge rather than back at the origin.
    expect(chartPath(points, first!, box, scale)).toStartWith('M0.0,');
    expect(chartPath(points, second!, box, scale)).toStartWith('M96.8,');
  });

  test('the last point lands on the right edge', () => {
    const points = run([1, 2, 3]);
    const path = chartPath(points, [0, 2], { width: 200, height: 10 }, chartScale(points, { kind: 'power' }));
    expect(path).toContain('L200.0,');
  });
});

describe('chartY', () => {
  test('the origin is at the top, as SVG has it', () => {
    const scale = { min: 0, max: 100, peak: 100, trough: 0 };
    expect(chartY(0, scale, 140)).toBe(140);
    expect(chartY(100, scale, 140)).toBe(0);
    expect(chartY(50, scale, 140)).toBe(70);
  });
});
