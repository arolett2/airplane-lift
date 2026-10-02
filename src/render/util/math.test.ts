import { describe, expect, it } from 'vitest';
import { clamp, easeInOutCubic, lerp, nextPow2, smoothingFactor, smoothstep } from './math';
import { formatKilonewtons } from './labels';

describe('math helpers', () => {
  it('clamp / lerp / smoothstep', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(2, 4, 0.25)).toBe(2.5);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
  });

  it('easeInOutCubic has fixed endpoints and is monotonic', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const e = easeInOutCubic(i / 20);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  it('smoothingFactor is frame-rate independent', () => {
    // Two half-steps equal one full step.
    const full = smoothingFactor(0.1, 0.2);
    const half = smoothingFactor(0.05, 0.2);
    expect(1 - (1 - half) * (1 - half)).toBeCloseTo(full, 12);
    expect(smoothingFactor(0, 0.2)).toBe(0);
    expect(smoothingFactor(1, 0)).toBe(1);
  });

  it('nextPow2', () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(33)).toBe(64);
    expect(nextPow2(64)).toBe(64);
  });
});

describe('formatKilonewtons', () => {
  it('picks readable precision', () => {
    expect(formatKilonewtons(54)).toBe('54 N');
    expect(formatKilonewtons(2345)).toBe('2.35 kN');
    expect(formatKilonewtons(45600)).toBe('45.6 kN');
    expect(formatKilonewtons(3_456_000)).toBe('3,456 kN');
    expect(formatKilonewtons(NaN)).toBe('-- kN');
  });
});
