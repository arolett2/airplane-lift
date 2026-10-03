import { describe, expect, it } from 'vitest';
import {
  formatTick,
  formatValue,
  niceNumber,
  niceScale,
  niceTicks,
  tickDecimals,
  ticksFromStep,
} from './ticks';

describe('niceNumber', () => {
  it('rounds to 1, 2, 5 times a power of ten', () => {
    expect(niceNumber(0.7, true)).toBe(0.5);
    expect(niceNumber(1.2, true)).toBe(1);
    expect(niceNumber(2.4, true)).toBe(2);
    expect(niceNumber(4, true)).toBe(5);
    expect(niceNumber(8, true)).toBe(10);
    expect(niceNumber(130, false)).toBe(200);
    expect(niceNumber(0.03, false)).toBeCloseTo(0.05, 12);
  });

  it('is safe for degenerate input', () => {
    expect(niceNumber(0, true)).toBe(1);
    expect(niceNumber(-3, true)).toBe(1);
    expect(niceNumber(NaN, false)).toBe(1);
  });
});

describe('niceTicks', () => {
  it('produces round numbers inside the range', () => {
    expect(niceTicks(0, 10, 6)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-4, 20, 5)).toEqual([-5, 0, 5, 10, 15, 20].filter((t) => t >= -4));
  });

  it('handles fractions without floating point dust', () => {
    const ticks = niceTicks(0, 1, 6);
    expect(ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const small = niceTicks(0.1, 0.4, 4);
    for (const t of small) expect(t).toBe(Number(t.toFixed(10)));
  });

  it('returns a single tick for a zero-width range', () => {
    expect(niceTicks(3, 3)).toEqual([3]);
  });

  it('never exceeds a sane number of ticks', () => {
    expect(ticksFromStep(0, 1e9, 1e-3).length).toBeLessThanOrEqual(201);
  });
});

describe('niceScale', () => {
  it('expands to nice bounds that contain the data', () => {
    const s = niceScale(-0.37, 1.43, 5);
    expect(s.min).toBeLessThanOrEqual(-0.37);
    expect(s.max).toBeGreaterThanOrEqual(1.43);
    expect(s.ticks[0]).toBe(s.min);
    expect(s.ticks[s.ticks.length - 1]).toBe(s.max);
    // Spacing is uniform.
    const d = s.ticks[1]! - s.ticks[0]!;
    for (let i = 2; i < s.ticks.length; i++) {
      expect(s.ticks[i]! - s.ticks[i - 1]!).toBeCloseTo(d, 9);
    }
  });

  it('widens a degenerate range', () => {
    const s = niceScale(2, 2);
    expect(s.max).toBeGreaterThan(s.min);
    expect(s.min).toBeLessThanOrEqual(2);
    expect(s.max).toBeGreaterThanOrEqual(2);
    const z = niceScale(0, 0);
    expect(z.max).toBeGreaterThan(z.min);
  });

  it('falls back to 0..1 for non-finite input', () => {
    const s = niceScale(NaN, Infinity);
    expect(s.min).toBe(0);
    expect(s.max).toBe(1);
  });
});

describe('tick formatting', () => {
  it('picks decimals from the step', () => {
    expect(tickDecimals(1)).toBe(0);
    expect(tickDecimals(5)).toBe(0);
    expect(tickDecimals(0.5)).toBe(1);
    expect(tickDecimals(0.2)).toBe(1);
    expect(tickDecimals(0.05)).toBe(2);
    expect(formatTick(0.6, 0.2)).toBe('0.6');
    expect(formatTick(10, 5)).toBe('10');
  });

  it('never prints negative zero', () => {
    expect(formatTick(-0, 0.5)).toBe('0.0');
    expect(formatTick(-1e-15, 0.5)).toBe('0.0');
    expect(formatTick(-0.5, 0.5)).toBe('-0.5');
  });

  it('formats tooltip values compactly', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(1234.5)).toBe('1235');
    expect(formatValue(12.345)).toBe('12.35');
    expect(formatValue(0.6234)).toBe('0.623');
    expect(formatValue(0.00123)).toBe('0.0012');
    expect(formatValue(NaN)).toBe('–');
  });
});
