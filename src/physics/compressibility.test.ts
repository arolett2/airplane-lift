import { describe, expect, it } from 'vitest';
import {
  compressibilityEstimate,
  criticalMachFromDragDivergence,
  kornDragDivergenceMach,
  LOCK_MDD_OFFSET,
  lockWaveDrag,
} from './compressibility';

const deg = Math.PI / 180;

describe('Korn equation', () => {
  it('reduces to kappa - t/c - CL/10 for an unswept wing', () => {
    expect(kornDragDivergenceMach(0, 0.12, 0.5, false)).toBeCloseTo(0.87 - 0.12 - 0.05, 12);
    expect(kornDragDivergenceMach(0, 0.12, 0.5, true)).toBeCloseTo(0.95 - 0.12 - 0.05, 12);
  });

  it('applies simple sweep theory: each term divided by cos^n of the sweep', () => {
    const c = Math.cos(30 * deg);
    const expected = 0.87 / c - 0.1 / c ** 2 - 0.4 / (10 * c ** 3);
    expect(kornDragDivergenceMach(30 * deg, 0.1, 0.4, false)).toBeCloseTo(expected, 12);
  });

  it('raises M_dd with sweep and supercritical sections, lowers it with thickness and lift', () => {
    const base = kornDragDivergenceMach(0, 0.12, 0.5, false);
    expect(kornDragDivergenceMach(25 * deg, 0.12, 0.5, false)).toBeGreaterThan(base);
    expect(kornDragDivergenceMach(0, 0.12, 0.5, true)).toBeGreaterThan(base);
    expect(kornDragDivergenceMach(0, 0.15, 0.5, false)).toBeLessThan(base);
    expect(kornDragDivergenceMach(0, 0.12, 0.8, false)).toBeLessThan(base);
  });

  it('treats forward and aft sweep alike and negative lift like positive lift', () => {
    expect(kornDragDivergenceMach(-20 * deg, 0.12, 0.5, false)).toBeCloseTo(
      kornDragDivergenceMach(20 * deg, 0.12, 0.5, false),
      12,
    );
    expect(kornDragDivergenceMach(0, 0.12, -0.5, false)).toBeCloseTo(
      kornDragDivergenceMach(0, 0.12, 0.5, false),
      12,
    );
  });

  it('gives airliner-like drag divergence for a 737-class wing at cruise', () => {
    // 25 deg sweep, ~12% thick supercritical-ish section, CL 0.5 => M_dd around 0.78..0.85.
    const mdd = kornDragDivergenceMach(25 * deg, 0.12, 0.5, true);
    expect(mdd).toBeGreaterThan(0.78);
    expect(mdd).toBeLessThan(0.86);
  });
});

describe('Lock wave drag', () => {
  it('places M_crit (0.1/80)^(1/3) ~ 0.108 below M_dd', () => {
    expect(LOCK_MDD_OFFSET).toBeCloseTo(0.1077, 4);
    expect(criticalMachFromDragDivergence(0.8)).toBeCloseTo(0.8 - LOCK_MDD_OFFSET, 12);
  });

  it('is zero up to the critical Mach number and 20 dM^4 above it', () => {
    expect(lockWaveDrag(0.5, 0.7)).toBe(0);
    expect(lockWaveDrag(0.7, 0.7)).toBe(0);
    expect(lockWaveDrag(0.8, 0.7)).toBeCloseTo(20 * 0.1 ** 4, 14);
  });

  it('has slope dCDw/dM = 0.1 at the drag-divergence Mach number (its definition)', () => {
    const est = compressibilityEstimate({
      mach: 0,
      sweep: 25 * deg,
      thicknessRatio: 0.12,
      cl: 0.5,
      supercritical: true,
    });
    const h = 1e-5;
    const slope =
      (lockWaveDrag(est.machDragDivergence + h, est.machCritical) -
        lockWaveDrag(est.machDragDivergence - h, est.machCritical)) /
      (2 * h);
    expect(slope).toBeCloseTo(0.1, 6);
    // About 27 drag counts at M_dd: the classic "20 counts" rule of thumb, roughly.
    expect(lockWaveDrag(est.machDragDivergence, est.machCritical)).toBeCloseTo(0.0027, 4);
  });

  it('combines Korn and Lock in compressibilityEstimate', () => {
    const est = compressibilityEstimate({
      mach: 0.82,
      sweep: 0,
      thicknessRatio: 0.12,
      cl: 0.5,
      supercritical: false,
    });
    expect(est.machDragDivergence).toBeCloseTo(0.7, 12);
    expect(est.machCritical).toBeCloseTo(0.7 - LOCK_MDD_OFFSET, 12);
    expect(est.waveDrag).toBeCloseTo(20 * (0.82 - est.machCritical) ** 4, 14);
  });
});
