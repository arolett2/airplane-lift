import { describe, expect, it } from 'vitest';
import { LinearScale, extentOf, interpolateAt, nearestPoint, resolveAxisRange } from './chartMath';

describe('extentOf', () => {
  it('ignores non-finite values and empty arrays', () => {
    expect(extentOf([[1, NaN, 3], new Float32Array([-2, 0.5])])).toEqual({ min: -2, max: 3 });
    expect(extentOf([[], [NaN]])).toBeNull();
  });
});

describe('resolveAxisRange', () => {
  it('expands free ends to nice numbers', () => {
    const r = resolveAxisRange({ min: -3.7, max: 19.2 }, {});
    expect(r.min).toBeLessThanOrEqual(-3.7);
    expect(r.max).toBeGreaterThanOrEqual(19.2);
    expect(r.ticks.length).toBeGreaterThanOrEqual(3);
  });

  it('respects fixed bounds exactly', () => {
    const r = resolveAxisRange({ min: 0.1, max: 0.9 }, { min: 0, max: 1 });
    expect(r.min).toBe(0);
    expect(r.max).toBe(1);
    expect(r.ticks[0]).toBe(0);
    expect(r.ticks[r.ticks.length - 1]).toBe(1);
  });

  it('can force zero into the range', () => {
    const r = resolveAxisRange({ min: 2, max: 8 }, { includeZero: true });
    expect(r.min).toBe(0);
    expect(r.max).toBeGreaterThanOrEqual(8);
  });

  it('survives missing data', () => {
    const r = resolveAxisRange(null, {});
    expect(r.max).toBeGreaterThan(r.min);
  });

  it('survives a fixed range that collapses', () => {
    const r = resolveAxisRange({ min: 1, max: 1 }, { min: 5, max: 5 });
    expect(r.max).toBeGreaterThan(r.min);
  });
});

describe('LinearScale', () => {
  it('maps and inverts, including reversed pixel ranges', () => {
    const s = new LinearScale(0, 10, 100, 300);
    expect(s.map(5)).toBe(200);
    expect(s.invert(250)).toBe(7.5);
    const flipped = new LinearScale(0, 10, 300, 100);
    expect(flipped.map(0)).toBe(300);
    expect(flipped.map(10)).toBe(100);
    expect(flipped.invert(flipped.map(3.3))).toBeCloseTo(3.3, 12);
  });
});

describe('nearestPoint', () => {
  const xs = new LinearScale(0, 10, 0, 100);
  const ys = new LinearScale(0, 10, 100, 0);
  const series = [
    { x: [0, 5, 10], y: [0, 5, 10] },
    { x: [0, 5, 10], y: [10, 5.5, 0] },
  ];

  it('finds the closest point across series', () => {
    const hit = nearestPoint(series, xs, ys, 52, 40);
    // Pixel (50, 50) holds both series' middle points; (52, 40) is nearest the 5.5 one.
    expect(hit).not.toBeNull();
    expect(hit!.pointIndex).toBe(1);
    expect(hit!.seriesIndex).toBe(1);
  });

  it('respects the maximum distance and skips NaN', () => {
    expect(nearestPoint(series, xs, ys, 500, 500, 20)).toBeNull();
    const withNaN = [{ x: [NaN, 1], y: [1, NaN] }];
    expect(nearestPoint(withNaN, xs, ys, 10, 90)).toBeNull();
  });
});

describe('interpolateAt', () => {
  it('interpolates linearly and returns null outside the data', () => {
    expect(interpolateAt([0, 2, 4], [0, 4, 4], 1)).toBe(2);
    expect(interpolateAt([0, 2, 4], [0, 4, 4], 3)).toBe(4);
    expect(interpolateAt([0, 2, 4], [0, 4, 4], 5)).toBeNull();
    expect(interpolateAt([0], [0], 0)).toBeNull();
  });
});
