import { describe, expect, it } from 'vitest';
import { LUT_SIZE, getColorLut, lutIndex } from './flowColors';
import { cpFromSpeed } from '../../shared/colormaps';
import { flowPressureColor, srgbToLinear } from '../util/palette';

function at(lut: Float32Array, s: number): [number, number, number] {
  const i = lutIndex(s) * 3;
  return [lut[i]!, lut[i + 1]!, lut[i + 2]!];
}

const saturation = (c: number[]) =>
  (Math.max(...c) - Math.min(...c)) / Math.max(1e-6, Math.max(...c));

describe('colour LUTs', () => {
  it('pressure mode colours by Cp = 1 - (V/Vinf)^2: fast air is blue, slowed air red', () => {
    const lut = getColorLut('pressure').rgb;
    expect(lut.length).toBe(LUT_SIZE * 3);
    const fast = at(lut, 1.3);
    expect(fast[2]).toBeGreaterThan(1.5 * fast[0]); // blue dominates
    const slow = at(lut, 0.5); // well slowed, towards stagnation
    expect(slow[0]).toBeGreaterThan(1.5 * slow[2]); // red dominates
  });

  it('keeps undisturbed air dim and neutral, and departures from it saturated', () => {
    const { rgb, emphasis } = getColorLut('pressure');
    const free = at(rgb, 1);
    expect(Math.max(...free) - Math.min(...free)).toBeLessThan(0.2); // greyish
    expect(Math.max(...free)).toBeLessThan(0.5); // dim (linear)
    expect(saturation(at(rgb, 1.25))).toBeGreaterThan(saturation(free));
    expect(emphasis[lutIndex(1)]!).toBeLessThan(0.06);
    expect(emphasis[lutIndex(1.1)]!).toBeGreaterThan(0.3);
    expect(emphasis[lutIndex(1.3)]!).toBe(1);
    expect(emphasis[lutIndex(0.3)]!).toBe(1);
    // Emphasis grows monotonically away from the freestream on both sides.
    for (let s = 1; s < 1.6; s += 0.05) {
      expect(emphasis[lutIndex(s + 0.05)]!).toBeGreaterThanOrEqual(emphasis[lutIndex(s)]!);
      expect(emphasis[lutIndex(2 - s - 0.05)]!).toBeGreaterThanOrEqual(
        emphasis[lutIndex(2 - s)]! - 1e-6,
      );
    }
  });

  it('stores the 3D flow palette in linear RGB', () => {
    const p = getColorLut('pressure').rgb;
    for (const ratio of [0.2, 0.7, 1, 1.3, 1.9]) {
      const i = lutIndex(ratio) * 3;
      const expected = flowPressureColor(cpFromSpeed(ratio));
      for (let c = 0; c < 3; c++) expect(p[i + c]!).toBeCloseTo(srgbToLinear(expected[c]!), 1);
    }
  });

  it('speed mode emphasises departures from the freestream speed', () => {
    const { emphasis } = getColorLut('speed');
    expect(emphasis[lutIndex(1)]!).toBeLessThan(0.05);
    expect(emphasis[lutIndex(1.4)]!).toBe(1);
    expect(emphasis[lutIndex(0.6)]!).toBe(1);
  });

  it('clamps and tolerates bad input', () => {
    expect(lutIndex(-1)).toBe(0);
    expect(lutIndex(50)).toBe(LUT_SIZE - 1);
    expect(lutIndex(NaN)).toBeGreaterThan(0);
    expect(lutIndex(NaN)).toBeLessThan(LUT_SIZE);
  });

  it('caches tables', () => {
    expect(getColorLut('speed')).toBe(getColorLut('speed'));
  });
});
