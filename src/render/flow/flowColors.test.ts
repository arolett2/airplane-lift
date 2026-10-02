import { describe, expect, it } from 'vitest';
import { LUT_SIZE, getColorLut, lutIndex } from './flowColors';
import { cpFromSpeed, pressureColor, speedColor } from '../../shared/colormaps';

describe('colour LUTs', () => {
  it('pressure mode colours by Cp = 1 - (V/Vinf)^2: fast air is blue, freestream white', () => {
    const lut = getColorLut('pressure').rgb;
    expect(lut.length).toBe(LUT_SIZE * 3);
    const at = (s: number) => {
      const i = lutIndex(s) * 3;
      return [lut[i]!, lut[i + 1]!, lut[i + 2]!];
    };
    const fast = at(1.6);
    expect(fast[2]!).toBeGreaterThan(fast[0]!); // blue dominates
    const free = at(1);
    expect(free[0]!).toBeGreaterThan(0.9);
    expect(free[1]!).toBeGreaterThan(0.9);
    expect(free[2]!).toBeGreaterThan(0.9);
    const slow = at(0.1); // near stagnation
    expect(slow[0]!).toBeGreaterThan(slow[2]!); // red dominates
  });

  it('matches the shared colour map at sampled speeds', () => {
    const p = getColorLut('pressure').rgb;
    const s = getColorLut('speed').rgb;
    for (const ratio of [0.2, 0.7, 1, 1.3, 1.9]) {
      const i = lutIndex(ratio) * 3;
      const expectedP = pressureColor(cpFromSpeed(ratio));
      const expectedS = speedColor(ratio);
      for (let c = 0; c < 3; c++) {
        expect(p[i + c]!).toBeCloseTo(expectedP[c]!, 1);
        expect(s[i + c]!).toBeCloseTo(expectedS[c]!, 1);
      }
    }
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
