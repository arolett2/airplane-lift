import { describe, expect, it } from 'vitest';
import { cssRgb, flowEmphasis, flowPressureColor, wingPressureColor } from './palette';

describe('3D pressure palettes keep the shared colour meaning', () => {
  it('wing: blue for suction, near-white for freestream, red for stagnation', () => {
    const suction = wingPressureColor(-0.8);
    expect(suction[2]).toBeGreaterThan(suction[0] + 0.4);
    const free = wingPressureColor(0);
    expect(Math.min(...free)).toBeGreaterThan(0.9);
    const stag = wingPressureColor(1);
    expect(stag[0]).toBeGreaterThan(stag[2] + 0.5);
  });

  it('flow: undisturbed air is a dim grey, departures saturate', () => {
    const free = flowPressureColor(0);
    expect(Math.max(...free)).toBeLessThan(0.75);
    expect(Math.max(...free) - Math.min(...free)).toBeLessThan(0.2);
    const fast = flowPressureColor(-0.6);
    expect(fast[2]).toBeGreaterThan(0.95);
    expect(fast[2] - fast[0]).toBeGreaterThan(0.5);
    const slow = flowPressureColor(0.5);
    expect(slow[0]).toBeGreaterThan(0.95);
    expect(slow[0] - slow[2]).toBeGreaterThan(0.5);
  });

  it('emphasis is 0 in undisturbed air and saturates at 1', () => {
    expect(flowEmphasis(0)).toBe(0);
    expect(flowEmphasis(-2)).toBe(1);
    expect(flowEmphasis(1)).toBe(1);
    expect(flowEmphasis(NaN)).toBe(0);
    expect(flowEmphasis(-0.2)).toBeGreaterThan(0.3);
  });

  it('formats CSS colours', () => {
    expect(cssRgb([1, 0.5, 0])).toBe('rgb(255, 128, 0)');
  });
});
