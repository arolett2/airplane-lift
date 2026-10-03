import { describe, expect, it } from 'vitest';
import {
  BUFFET_LIFT_FLOOR,
  BUFFET_LIFT_MARGIN,
  buffetLift,
  buffetLimited,
  compressibilityEstimate,
  KORN_KAPPA_CONVENTIONAL,
  kornDragDivergenceLift,
  sweptMaxLiftFactor,
  wingLiftLimit,
  criticalMachFromDragDivergence,
  kornDragDivergenceMach,
  LOCK_MDD_OFFSET,
  lockWaveDrag,
} from './compressibility';

const deg = Math.PI / 180;

describe('Korn equation', () => {
  it('reduces to kappa - t/c - CL/10 for an unswept wing', () => {
    expect(kornDragDivergenceMach(0, 0.12, 0.5, false)).toBeCloseTo(
      KORN_KAPPA_CONVENTIONAL - 0.12 - 0.05,
      12,
    );
    expect(kornDragDivergenceMach(0, 0.12, 0.5, true)).toBeCloseTo(0.95 - 0.12 - 0.05, 12);
  });

  it('applies simple sweep theory: each term divided by cos^n of the sweep', () => {
    const c = Math.cos(30 * deg);
    const expected = KORN_KAPPA_CONVENTIONAL / c - 0.1 / c ** 2 - 0.4 / (10 * c ** 3);
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
    const mdd = KORN_KAPPA_CONVENTIONAL - 0.12 - 0.05;
    expect(est.machDragDivergence).toBeCloseTo(mdd, 12);
    expect(est.machCritical).toBeCloseTo(mdd - LOCK_MDD_OFFSET, 12);
    expect(est.waveDrag).toBeCloseTo(20 * (0.82 - est.machCritical) ** 4, 14);
  });
});

describe('maximum lift: sweep and buffet', () => {
  const b737 = { sweep: 25 * deg, thicknessRatio: 0.11, supercritical: true };

  it('inverts the Korn equation for the drag-divergence lift', () => {
    const cl = kornDragDivergenceLift(0.78, 25 * deg, 0.11, true);
    expect(kornDragDivergenceMach(25 * deg, 0.11, cl, true)).toBeCloseTo(0.78, 12);
  });

  it('puts buffet onset a fixed margin above the drag-divergence lift', () => {
    const m = 0.785;
    expect(buffetLift({ mach: m, ...b737 })).toBeCloseTo(
      kornDragDivergenceLift(m, b737.sweep, b737.thicknessRatio, true) + BUFFET_LIFT_MARGIN,
      2, // the smooth floor adds ~0.003 here
    );
  });

  it('falls smoothly and monotonically with Mach, levelling off at the floor', () => {
    let prev = Infinity;
    for (let m = 0; m <= 1.2; m += 0.01) {
      const cl = buffetLift({ mach: m, ...b737 });
      expect(cl).toBeLessThan(prev);
      expect(cl).toBeGreaterThan(BUFFET_LIFT_FLOOR);
      prev = cl;
    }
    expect(buffetLift({ mach: 0.2, ...b737 })).toBeGreaterThan(4);
    expect(buffetLift({ mach: 1.2, ...b737 })).toBeLessThan(BUFFET_LIFT_FLOOR + 0.01);
  });

  it('lets sweep, thinner and supercritical sections buffet later', () => {
    const at = (o: Partial<typeof b737>) => buffetLift({ mach: 0.8, ...b737, ...o });
    expect(at({ sweep: 35 * deg })).toBeGreaterThan(at({}));
    expect(at({ thicknessRatio: 0.09 })).toBeGreaterThan(at({}));
    expect(at({ supercritical: false })).toBeLessThan(at({}));
  });

  it('reduces swept-wing maximum lift by cos^0.75 of the sweep', () => {
    expect(sweptMaxLiftFactor(0)).toBe(1);
    expect(sweptMaxLiftFactor(25 * deg)).toBeCloseTo(Math.cos(25 * deg) ** 0.75, 12);
    expect(sweptMaxLiftFactor(-25 * deg)).toBeCloseTo(sweptMaxLiftFactor(25 * deg), 12);
  });

  it('builds the strip lift limit in Prandtl-Glauert units', () => {
    const beta = Math.sqrt(1 - 0.785 ** 2);
    const lim = wingLiftLimit({ mach: 0.785, ...b737 }, beta);
    expect(lim.scale).toBeCloseTo(beta * sweptMaxLiftFactor(b737.sweep), 12);
    expect(lim.cap).toBeCloseTo(beta * buffetLift({ mach: 0.785, ...b737 }), 12);
    expect(lim.flatPlateScale).toBeCloseTo(beta, 12);
    // Low speed, unswept: practically no limit at all.
    const ga = wingLiftLimit(
      { mach: 0.19, sweep: 0, thicknessRatio: 0.12, supercritical: false },
      1,
    );
    expect(ga.scale).toBe(1);
    expect(ga.cap).toBeGreaterThan(5);
  });

  it('knows when buffet rather than low-speed stall limits the lift', () => {
    expect(buffetLimited({ mach: 0.785, ...b737 }, 1.7)).toBe(true);
    expect(buffetLimited({ mach: 0.3, ...b737 }, 1.7)).toBe(false);
  });
});
