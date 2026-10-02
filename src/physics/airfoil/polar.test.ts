import { describe, expect, it } from 'vitest';
import type { FlapState, Naca4Params } from '../types';
import { generateAirfoil } from './naca';
import { createPanelSolver } from './panel';
import { createSectionPolar, thinAirfoilTheory } from './polar';

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

describe('section polar', () => {
  it('is linear with the viscous slope below stall', () => {
    const a = p2412.liftSlope;
    expect(a / p2412.inviscidLiftSlope).toBeCloseTo(0.92, 6);
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
    // Turbulent flat-plate friction level for a 12% section.
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
