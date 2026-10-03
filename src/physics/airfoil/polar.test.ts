import { describe, expect, it } from 'vitest';
import type { FlapState, Naca4Params } from '../types';
import { generateAirfoil } from './naca';
import { createPanelSolver } from './panel';
import {
  createSectionPolar,
  NO_LIFT_LIMIT,
  skinFriction,
  softMin,
  thinAirfoilTheory,
  TRANSITION_REYNOLDS,
  viscousSlopeFactor,
} from './polar';

const DEG = Math.PI / 180;
const RE = 6e6;

function polarFor(params: Naca4Params, flap: FlapState | null = null, slat = false) {
  const solver = createPanelSolver(generateAirfoil(params, 140, flap));
  return createSectionPolar(params, solver, { flap, slat, supercritical: false });
}

const naca = (m: number, t: number): Naca4Params => ({ camber: m, camberPos: 0.4, thickness: t });
const p0012 = polarFor(naca(0, 0.12));
const p2412 = polarFor(naca(0.02, 0.12));

describe('thin-airfoil helpers', () => {
  it('reproduces the thin-airfoil zero-lift angle of NACA 2412 (-2.08 deg)', () => {
    expect(thinAirfoilTheory(naca(0.02, 0.12), null).alphaZeroLift / DEG).toBeCloseTo(-2.08, 1);
  });
});

describe('viscous lift-slope factor', () => {
  it('falls linearly with thickness: 0.93 at 6 %, 0.87 at 12 %', () => {
    expect(viscousSlopeFactor(0.06)).toBeCloseTo(0.93, 9);
    expect(viscousSlopeFactor(0.12)).toBeCloseTo(0.87, 9);
    expect(viscousSlopeFactor(0)).toBeLessThanOrEqual(1);
    expect(viscousSlopeFactor(0.24)).toBeLessThan(viscousSlopeFactor(0.12));
  });

  it('gives measured-size slopes: 12 % sections 0.100-0.108/deg, 6 % about 0.108/deg', () => {
    // Abbott & von Doenhoff / Ladson (smooth models, Re 3-9 million).
    for (const p of [p0012, p2412]) {
      expect(p.liftSlope * DEG).toBeGreaterThan(0.1);
      expect(p.liftSlope * DEG).toBeLessThan(0.108);
    }
    const p0006 = polarFor(naca(0, 0.06));
    expect(p0006.liftSlope * DEG).toBeCloseTo(0.108, 2);
    // Thicker sections no longer get a steeper viscous slope than thinner ones.
    expect(p0006.liftSlope).toBeGreaterThan(p0012.liftSlope);
  });
});

describe('section polar', () => {
  it('is linear with the viscous slope below stall', () => {
    const a = p2412.liftSlope;
    expect(a / p2412.inviscidLiftSlope).toBeCloseTo(viscousSlopeFactor(0.12), 9);
    let prev = -Infinity;
    for (let deg = -8; deg <= 8; deg += 1) {
      const cl = p2412.cl(deg * DEG, RE);
      expect(cl).toBeGreaterThan(prev);
      expect(cl).toBeCloseTo(a * (deg * DEG - p2412.alphaZeroLift), 9);
      prev = cl;
    }
    expect(p2412.cl(p2412.alphaZeroLift, RE)).toBeCloseTo(0, 12);
  });

  it('peaks at clMax at the stall angle, then drops noticeably', () => {
    const as = p2412.alphaStall(RE);
    const clMax = p2412.clMax(RE);
    expect(p2412.cl(as, RE)).toBeCloseTo(clMax, 9);
    for (const d of [-3, -1, 1, 3]) expect(p2412.cl(as + d * DEG, RE)).toBeLessThan(clMax);
    expect(as / DEG).toBeGreaterThan(12);
    expect(as / DEG).toBeLessThan(19);
    // Visible post-stall drop: negative slope a couple of degrees past stall.
    const slope = (p2412.cl(as + 3 * DEG, RE) - p2412.cl(as + 2 * DEG, RE)) / DEG;
    expect(slope).toBeLessThan(-0.03);
    expect(p2412.cl(as + 6 * DEG, RE)).toBeLessThan(clMax - 0.3);
    expect(p2412.isStalled(as + 0.5 * DEG, RE)).toBe(true);
    expect(p2412.isStalled(as - 0.5 * DEG, RE)).toBe(false);
  });

  it('orders clMax by thickness the way NACA data does', () => {
    const c = (t: number) => polarFor(naca(0, t)).clMax(RE);
    const c06 = c(0.06);
    const c12 = c(0.12);
    const c18 = c(0.18);
    expect(c06).toBeGreaterThan(0.75);
    expect(c06).toBeLessThan(1.1);
    expect(c12).toBeGreaterThan(1.45);
    expect(c12).toBeLessThan(1.65);
    expect(c18).toBeGreaterThan(1.35);
    expect(c18).toBeLessThan(c12);
    expect(c12).toBeGreaterThan(c06);
    // Camber helps, and scales with Reynolds number within limits.
    expect(p2412.clMax(RE) - c12).toBeGreaterThan(0.1);
    expect(p2412.clMax(RE) - c12).toBeLessThan(0.25);
    expect(p2412.clMax(1e6)).toBeLessThan(p2412.clMax(RE));
    expect(p2412.clMax(1e12)).toBeCloseTo(p2412.clMax(1e9), 9);
  });

  it('is C1-smooth over the full circle', () => {
    const thinFlapped = polarFor(naca(0.04, 0.06), { chordFrac: 0.3, deflection: 30 * DEG }, true);
    for (const polar of [p0012, p2412, thinFlapped]) {
      const h = 1e-6;
      let prevSlope = NaN;
      for (let a = -Math.PI + 1e-3; a < Math.PI - 1e-3; a += 0.02 * DEG) {
        const c0 = polar.cl(a, RE);
        expect(Number.isFinite(c0)).toBe(true);
        // Continuity of value.
        expect(Math.abs(polar.cl(a + h, RE) - c0)).toBeLessThan(1e-4);
        expect(Math.abs(polar.cd(a + h, RE) - polar.cd(a, RE))).toBeLessThan(1e-4);
        expect(Math.abs(polar.cm(a + h, RE) - polar.cm(a, RE))).toBeLessThan(1e-4);
        // Continuity of slope: 0.02 deg apart the slope only changes by curvature * step
        // (< ~0.5 here), whereas any kink in the piecewise curve would jump by O(lift slope).
        const slope = (polar.cl(a + h, RE) - polar.cl(a - h, RE)) / (2 * h);
        if (!Number.isNaN(prevSlope)) expect(Math.abs(slope - prevSlope)).toBeLessThan(1);
        prevSlope = slope;
      }
      // Wraps continuously at +-pi.
      expect(polar.cl(Math.PI, RE)).toBeCloseTo(polar.cl(-Math.PI, RE), 6);
      expect(polar.cd(Math.PI, RE)).toBeCloseTo(polar.cd(-Math.PI, RE), 6);
      expect(polar.cm(Math.PI, RE)).toBeCloseTo(polar.cm(-Math.PI, RE), 6);
    }
  });

  it('a buffet-capped stall levels off instead of falling to the flat plate at a small angle', () => {
    // A flap moves the zero-lift angle far negative: at a small geometric angle the section is
    // deep past a low (buffet-capped) stall although the plate angle is only a few degrees.
    const flapped = polarFor(naca(0.02, 0.12), { chordFrac: 0.3, deflection: 25 * DEG }, false);
    const buffet = flapped.withLiftLimit({ scale: 0.9, cap: 0.7 });
    const alpha = 3 * DEG;
    expect(buffet.isStalled(alpha, RE)).toBe(true);
    // The plain flat plate would give 2 sin(3 deg) cos(3 deg) = 0.10.
    expect(buffet.cl(alpha, RE)).toBeGreaterThan(0.5 * buffet.clMax(RE));
    // Separating never lowers the drag below the attached flapped section's.
    const x = alpha - buffet.alphaZeroLift;
    const attachedLike = buffet.cd(buffet.alphaZeroLift + 0.5 * x, RE);
    expect(buffet.cd(alpha, RE)).toBeGreaterThan(attachedLike);
    // At low speed (no cap) the deep stall is still the flat plate.
    const plainDeep = 60 * DEG;
    expect(flapped.cl(plainDeep, RE)).toBeCloseTo(Math.sin(2 * plainDeep), 6);
  });

  it('stays finite, C1 and peaked at clMax across the slider extremes', () => {
    const cases: [Naca4Params, FlapState | null, boolean][] = [
      [naca(0, 0.04), null, false],
      [{ camber: 0.09, camberPos: 0.1, thickness: 0.04 }, null, false],
      [
        { camber: 0.09, camberPos: 0.9, thickness: 0.04 },
        { chordFrac: 0.4, deflection: 40 * DEG },
        true,
      ],
      [
        { camber: 0.09, camberPos: 0.2, thickness: 0.24 },
        { chordFrac: 0.1, deflection: 40 * DEG },
        false,
      ],
      [naca(0, 0.24), { chordFrac: 0.4, deflection: 40 * DEG }, true],
      [naca(0.04, 0.15), { chordFrac: 0.25, deflection: 15 * DEG }, false],
    ];
    for (const [params, flap, slat] of cases) {
      const polar = polarFor(params, flap, slat);
      for (const re of [1e4, 3e7]) {
        const h = 1e-6;
        let prevSlope = NaN;
        let bad = 0; // non-finite values, non-positive drag, attachedFraction out of range
        let worstJump = 0;
        for (let a = -40 * DEG; a < 60 * DEG; a += 0.02 * DEG) {
          const cl = polar.cl(a, re);
          const cd = polar.cd(a, re);
          const cm = polar.cm(a, re);
          const f = polar.attachedFraction(a, re);
          if (![cl, cd, cm, f].every(Number.isFinite) || !(cd > 0) || f < 0.1 - 1e-9 || f > 1) {
            bad++;
          }
          const slope = (polar.cl(a + h, re) - polar.cl(a - h, re)) / (2 * h);
          if (!Number.isNaN(prevSlope))
            worstJump = Math.max(worstJump, Math.abs(slope - prevSlope));
          prevSlope = slope;
        }
        expect(bad).toBe(0);
        expect(worstJump).toBeLessThan(1);
        // The stall angle is the (first) peak of the lift curve, followed by a visible drop.
        // (Deep in stall thin sections climb back towards the flat-plate cl = sin 2a, which
        // can exceed their clMax beyond ~20 deg: clMax is the attached-flow peak.)
        const as = polar.alphaStall(re);
        const clMax = polar.clMax(re);
        expect(polar.cl(as, re)).toBeCloseTo(clMax, 9);
        for (let a = polar.alphaZeroLift; a < as + 5 * DEG; a += 0.1 * DEG) {
          expect(polar.cl(a, re)).toBeLessThanOrEqual(clMax + 1e-9);
        }
        expect(polar.cl(as + 4 * DEG, re)).toBeLessThan(clMax - 0.1);
        expect(polar.clMin(re)).toBeLessThan(0);
        expect(polar.alphaStallNegative(re)).toBeLessThan(polar.alphaZeroLift);
      }
    }
  });

  it('gives an odd lift curve for a symmetric section', () => {
    for (const deg of [3, 10, 15, 20, 35, 70, 120]) {
      expect(p0012.cl(-deg * DEG, RE)).toBeCloseTo(-p0012.cl(deg * DEG, RE), 6);
      expect(p0012.cd(-deg * DEG, RE)).toBeCloseTo(p0012.cd(deg * DEG, RE), 6);
    }
  });

  it('stalls less hard in the negative direction for cambered sections', () => {
    const clMin = p2412.clMin(RE);
    expect(clMin).toBeLessThan(-0.8);
    expect(-clMin).toBeLessThan(p2412.clMax(RE));
    expect(p2412.cl(p2412.alphaStallNegative(RE), RE)).toBeCloseTo(clMin, 9);
  });

  it('adds lift with a flap and raises clMax by ~60% of the increment', () => {
    const flapped = polarFor(naca(0.02, 0.12), { chordFrac: 0.25, deflection: 20 * DEG });
    expect(flapped.alphaZeroLift).toBeLessThan(p2412.alphaZeroLift - 5 * DEG);
    expect(flapped.cl(4 * DEG, RE)).toBeGreaterThan(p2412.cl(4 * DEG, RE) + 0.6);
    expect(flapped.flapDeltaCl).toBeGreaterThan(0.6);
    expect(flapped.clMax(RE) - p2412.clMax(RE)).toBeCloseTo(0.6 * flapped.flapDeltaCl, 6);
    expect(flapped.alphaStall(RE)).toBeLessThan(p2412.alphaStall(RE));
    expect(flapped.cd(4 * DEG, RE)).toBeGreaterThan(p2412.cd(4 * DEG, RE) + 0.005);
  });

  it('raises clMax and delays stall with a slat', () => {
    const slat = polarFor(naca(0.02, 0.12), null, true);
    expect(slat.clMax(RE) - p2412.clMax(RE)).toBeCloseTo(0.7, 6);
    const delay = (slat.alphaStall(RE) - p2412.alphaStall(RE)) / DEG;
    expect(delay).toBeGreaterThan(6);
    expect(delay).toBeLessThan(10);
  });

  it('has minimum drag near the design lift coefficient', () => {
    let best = Infinity;
    let bestAlpha = 0;
    for (let a = -10 * DEG; a <= 10 * DEG; a += 0.05 * DEG) {
      const cd = p2412.cd(a, RE);
      if (cd < best) {
        best = cd;
        bestAlpha = a;
      }
    }
    expect(Math.abs(p2412.cl(bestAlpha, RE) - p2412.designCl)).toBeLessThan(0.05);
    expect(p2412.designCl).toBeGreaterThan(0.1);
    expect(p2412.designCl).toBeLessThan(0.4);
    // Flat-plate friction level (short laminar run, then turbulent) for a 12% section.
    expect(best).toBeGreaterThan(0.006);
    expect(best).toBeLessThan(0.011);
    // Symmetric section: minimum at zero lift.
    expect(p0012.cd(0, RE)).toBeLessThan(p0012.cd(2 * DEG, RE));
  });

  it('approaches flat-plate behaviour at 90 deg', () => {
    for (const polar of [p0012, p2412]) {
      expect(Math.abs(polar.cl(90 * DEG, RE))).toBeLessThan(0.02);
      expect(polar.cd(90 * DEG, RE)).toBeCloseTo(1.98, 1);
      expect(polar.cl(45 * DEG, RE)).toBeCloseTo(1, 2);
      expect(polar.cm(90 * DEG, RE)).toBeLessThan(-0.3);
    }
  });

  it('drifts the moment nose-down after stall', () => {
    const as = p2412.alphaStall(RE);
    expect(p2412.cm(as + 10 * DEG, RE)).toBeLessThan(p2412.cm(as - 2 * DEG, RE) - 0.02);
    expect(p2412.cm(as + 20 * DEG, RE)).toBeLessThan(p2412.cm(as + 10 * DEG, RE) - 0.05);
    expect(p2412.cm(0, RE)).toBeLessThan(-0.03);
    expect(p0012.cm(0, RE)).toBeCloseTo(0, 6);
  });

  it('separates from the trailing edge forward as stall develops', () => {
    const as = p2412.alphaStall(RE);
    expect(p2412.attachedFraction(5 * DEG, RE)).toBe(1);
    expect(p2412.attachedFraction(as - 3 * DEG, RE)).toBe(1);
    const atStall = p2412.attachedFraction(as, RE);
    expect(atStall).toBeLessThan(1);
    expect(atStall).toBeGreaterThan(0.6);
    let prev = 1;
    for (let d = 0; d <= 30; d += 2) {
      const f = p2412.attachedFraction(as + d * DEG, RE);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
    expect(prev).toBeCloseTo(0.1, 2);
  });
});

describe('lift limits (sweep, shock-induced separation)', () => {
  it('soft minimum: below both inputs, close to the smaller one when they differ a lot', () => {
    expect(softMin(1, Infinity)).toBe(1);
    expect(softMin(Infinity, 2)).toBe(2);
    expect(softMin(1, 1)).toBeCloseTo(Math.pow(2, -1 / 4), 12);
    expect(softMin(1, 2)).toBeLessThan(1);
    expect(softMin(1, 2)).toBeGreaterThan(0.98);
    expect(softMin(1, 4)).toBeGreaterThan(0.999);
    expect(softMin(3, 1)).toBeCloseTo(softMin(1, 3), 14);
  });

  it('returns the plain polar for the identity limit, and memoises limited ones', () => {
    expect(p2412.withLiftLimit(NO_LIFT_LIMIT)).toBe(p2412);
    expect(p2412.withLiftLimit({ scale: 1, cap: Infinity })).toBe(p2412);
    const a = p2412.withLiftLimit({ scale: 0.9, cap: 1.2 });
    expect(p2412.withLiftLimit({ scale: 0.9, cap: 1.2 })).toBe(a);
    expect(a.withLiftLimit({ scale: 0.9, cap: 1.2 })).toBe(a);
    expect(a.liftLimit).toEqual({ scale: 0.9, cap: 1.2, flatPlateScale: 1 });
  });

  it('scales clMax and |clMin| and moves the stall angles with them, keeping the linear part', () => {
    const lim = p2412.withLiftLimit({ scale: 0.8, cap: Infinity });
    expect(lim.clMax(RE)).toBeCloseTo(0.8 * p2412.clMax(RE), 12);
    expect(lim.clMin(RE)).toBeCloseTo(0.8 * p2412.clMin(RE), 12);
    expect(lim.alphaStall(RE)).toBeLessThan(p2412.alphaStall(RE));
    expect(lim.alphaStallNegative(RE)).toBeGreaterThan(p2412.alphaStallNegative(RE));
    expect(lim.liftSlope).toBe(p2412.liftSlope);
    expect(lim.alphaZeroLift).toBe(p2412.alphaZeroLift);
    for (const deg of [-4, 0, 4, 8]) {
      expect(lim.cl(deg * DEG, RE)).toBeCloseTo(p2412.cl(deg * DEG, RE), 12);
      expect(lim.cm(deg * DEG, RE)).toBeCloseTo(p2412.cm(deg * DEG, RE), 12);
    }
    // Peak, stall flag, drag rise and separation all follow the lower limit.
    const as = lim.alphaStall(RE);
    expect(lim.cl(as, RE)).toBeCloseTo(lim.clMax(RE), 9);
    expect(lim.isStalled(as + 0.5 * DEG, RE)).toBe(true);
    expect(p2412.isStalled(as + 0.5 * DEG, RE)).toBe(false);
    expect(lim.cd(as + 2 * DEG, RE)).toBeGreaterThan(p2412.cd(as + 2 * DEG, RE));
    expect(lim.attachedFraction(as + 2 * DEG, RE)).toBeLessThan(1);
  });

  it('caps the maximum lift independently of Reynolds number, smoothly', () => {
    const cap = 0.9;
    const lim = p2412.withLiftLimit({ scale: 1, cap });
    for (const re of [1e6, 6e6, 3e7]) {
      expect(lim.clMax(re)).toBeLessThan(cap);
      expect(lim.clMax(re)).toBeCloseTo(softMin(p2412.clMax(re), cap), 12);
    }
    // A cap far above the section's own clMax changes almost nothing.
    const loose = p2412.withLiftLimit({ scale: 1, cap: 4 * p2412.clMax(RE) });
    expect(loose.clMax(RE) / p2412.clMax(RE)).toBeGreaterThan(0.999);
  });

  it('scales the deep-stall (flat plate) lift by flatPlateScale only', () => {
    const lim = p2412.withLiftLimit({ scale: 1, cap: Infinity, flatPlateScale: 0.6 });
    expect(lim.cl(60 * DEG, RE)).toBeCloseTo(0.6 * p2412.cl(60 * DEG, RE), 9);
    expect(lim.cl(4 * DEG, RE)).toBeCloseTo(p2412.cl(4 * DEG, RE), 12);
    expect(lim.clMax(RE)).toBeCloseTo(p2412.clMax(RE), 12);
  });

  it('keeps the lift curve continuous through a capped stall', () => {
    const lim = p2412.withLiftLimit({ scale: 0.85, cap: 0.8, flatPlateScale: 0.7 });
    let prev = lim.cl(-30 * DEG, RE);
    for (let deg = -30 + 0.05; deg <= 40; deg += 0.05) {
      const cl = lim.cl(deg * DEG, RE);
      expect(Math.abs(cl - prev), `jump at ${deg.toFixed(2)} deg`).toBeLessThan(0.02);
      prev = cl;
    }
  });
});

describe('skin friction with a laminar run', () => {
  it('is Blasius below transition and continuous at it', () => {
    expect(skinFriction(1e5)).toBeCloseTo(1.328 / Math.sqrt(1e5), 12);
    const rt = TRANSITION_REYNOLDS;
    expect(skinFriction(rt * (1 + 1e-9))).toBeCloseTo(skinFriction(rt), 9);
  });

  it('approaches the fully turbulent 0.074 Re^-0.2 at high Reynolds number', () => {
    const turb = (re: number) => 0.074 * Math.pow(re, -0.2);
    // Prandtl-Schlichting with transition at 5e5: A ~ 1740.
    expect((turb(1e7) - skinFriction(1e7)) * 1e7).toBeCloseTo(1742, -1);
    expect(skinFriction(3e7) / turb(3e7)).toBeGreaterThan(0.97);
    expect(skinFriction(1.5e6) / turb(1.5e6)).toBeLessThan(0.8);
  });

  it('stays below fully turbulent friction and is continuous (with the transition bump)', () => {
    let prev = skinFriction(TRANSITION_REYNOLDS);
    for (let re = TRANSITION_REYNOLDS * 1.02; re < 1e9; re *= 1.02) {
      const cf = skinFriction(re);
      expect(cf).toBeLessThan(0.074 * Math.pow(re, -0.2));
      expect(Math.abs(cf - prev) / prev).toBeLessThan(0.05);
      prev = cf;
    }
  });
});
