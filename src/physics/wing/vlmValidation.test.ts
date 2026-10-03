/**
 * Further theory checks of the VLM (independent review): Göthert similarity for compressibility,
 * thin-airfoil pitching moment, near-field vs far-field lift, and the tunnel-frame lattice
 * reproducing the flow-tangency condition the solver imposed.
 */
import { describe, expect, it } from 'vitest';
import type { Naca4Params, Vec3, WingGeometry } from '../types';
import { nacaCamber } from '../airfoil/naca';
import { bodyDirToTunnel, bodyToTunnel } from '../math/frames';
import { buildVlmModel, solveVlm, vlmLatticeToTunnel } from './vlm';
import { addHorseshoeVelocity } from './vlmBiotSavart';
import { makeTestWing } from './vlmTestFixtures';

const DEG = Math.PI / 180;
const NACA2412: Naca4Params = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };

/** The same wing with every x (and chord) stretched by 1/beta: Göthert's equivalent wing. */
function stretched(geo: WingGeometry, beta: number): WingGeometry {
  return {
    ...geo,
    surfaces: geo.surfaces.map((s) => ({
      ...s,
      sections: s.sections.map((sec) => ({
        ...sec,
        le: [sec.le[0] / beta, sec.le[1], sec.le[2]] as Vec3,
        chord: sec.chord / beta,
      })),
    })),
    referenceArea: geo.referenceArea / beta,
    meanAeroChord: geo.meanAeroChord / beta,
    aspectRatio: geo.aspectRatio * beta,
  };
}

/** Thin-airfoil theory: cm about c/4 = -(pi/4)(A1 - A2) for the NACA mean line. */
function thinAirfoilCmQuarter(p: Naca4Params): number {
  const n = 20000;
  let a1 = 0;
  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const th = ((i + 0.5) / n) * Math.PI;
    const slope = nacaCamber(p, 0.5 * (1 - Math.cos(th))).slope;
    a1 += (2 / n) * slope * Math.cos(th);
    a2 += (2 / n) * slope * Math.cos(2 * th);
  }
  return (-Math.PI / 4) * (a1 - a2);
}

describe('vlm compressibility, moments and far-field lift', () => {
  it('obeys Göthert similarity: CL(M) of a wing = CL(0) of the x-stretched wing / beta', () => {
    const mach = 0.7;
    const beta = Math.sqrt(1 - mach * mach);
    for (const sweepQuarterDeg of [0, 35]) {
      const geo = makeTestWing({ span: 10, rootChord: 1.6, taper: 0.4, sweepQuarterDeg });
      const a = solveVlm(buildVlmModel(geo, { mach }), { alpha: 3 * DEG });
      const b = solveVlm(buildVlmModel(stretched(geo, beta)), { alpha: 3 * DEG });
      expect(a.CL / (b.CL / beta)).toBeCloseTo(1, 6);
      expect(a.CDi / (b.CDi / beta)).toBeCloseTo(1, 6);
    }
  });

  it('pitching moment: thin-airfoil cm_c/4 at high aspect ratio, exact pivot transfer', () => {
    const geo = makeTestWing({ span: 60, rootChord: 1, airfoil: NACA2412 });
    const cmTheory = thinAirfoilCmQuarter(NACA2412); // -0.0531
    // Lifting surface at AR 60 with 12 chordwise panels: within 2% (6 panels read ~6% low).
    const fine = solveVlm(buildVlmModel(geo, { chordwisePanels: 12 }), { alpha: 0 });
    expect(fine.Cm / cmTheory).toBeGreaterThan(0.97);
    expect(fine.Cm / cmTheory).toBeLessThan(1.0);
    const coarse = solveVlm(buildVlmModel(geo), { alpha: 0 });
    expect(coarse.Cm / cmTheory).toBeGreaterThan(0.9);
    // Moving the pivot 0.5 m aft adds the normal force times the arm (body frame).
    const swept = makeTestWing({ span: 8, rootChord: 1, airfoil: NACA2412, sweepQuarterDeg: 20 });
    const s1 = solveVlm(buildVlmModel(swept), { alpha: 5 * DEG });
    const s2 = solveVlm(buildVlmModel({ ...swept, pivot: [0.5, 0, 0] }), { alpha: 5 * DEG });
    expect(s2.Cm).toBeCloseTo(s1.Cm + (0.5 * s1.forceCoefficient[2]) / swept.meanAeroChord, 10);
  });

  it('near-field (Kutta–Joukowski) lift equals the far-field rho V sum(Gamma dy)', () => {
    for (const sweepQuarterDeg of [0, 35]) {
      const geo = makeTestWing({ span: 8, rootChord: 1, taper: 0.4, sweepQuarterDeg });
      const m = buildVlmModel(geo);
      const alpha = 5 * DEG;
      const s = solveVlm(m, { alpha });
      let sum = 0;
      for (let j = 0; j < m.halfStripCount; j++) {
        const st = m.strips[j]!;
        sum += s.stripCirculation[j]! * st.width * st.spanTangent[1];
      }
      // Both halves, q = 1/2: CL = 2 * 2 * sum / S. Far-field lift is normal to the wake (body x).
      const clFar = (4 * sum) / geo.referenceArea;
      expect(s.CL / (clFar * Math.cos(alpha))).toBeCloseTo(1, 2);
    }
  });

  it('the tunnel-frame lattice satisfies flow tangency at the control points', () => {
    // Evaluate the exported VortexLattice exactly as the flow module would (straight legs to the
    // trailing edge, then along TUNNEL +x, gamma already scaled by vInf) on a flat swept wing.
    const geo = makeTestWing({ span: 8, rootChord: 1, taper: 0.5, sweepQuarterDeg: 30 });
    const m = buildVlmModel(geo);
    const alpha = 8 * DEG;
    const vInf = 40;
    const lat = vlmLatticeToTunnel(m, solveVlm(m, { alpha }), alpha, vInf);
    const v = new Float64Array(3);
    let sum = 0;
    let max = 0;
    for (let p = 0; p < m.panelCount; p++) {
      const at = (arr: Float64Array): Vec3 => [arr[3 * p]!, arr[3 * p + 1]!, arr[3 * p + 2]!];
      const cp = bodyToTunnel(at(m.controlPoints), geo.pivot, alpha);
      const n = bodyDirToTunnel(at(m.normals), alpha);
      v.fill(0);
      for (let q = 0; q < lat.count; q++) {
        const [a, b, ta, tb] = [lat.a, lat.b, lat.teA, lat.teB].map(
          (arr) => [arr[3 * q]!, arr[3 * q + 1]!, arr[3 * q + 2]!] as const,
        );
        addHorseshoeVelocity(...cp, ...a!, ...b!, ...ta!, ...tb!, lat.gamma[q]!, 1e-20, v, 0);
      }
      const vn = ((vInf + v[0]!) * n[0] + v[1]! * n[1] + v[2]! * n[2]) / (vInf * Math.sin(alpha));
      sum += Math.abs(vn);
      max = Math.max(max, Math.abs(vn));
    }
    // Only the wake direction differs from the solve (tunnel +x instead of body +x).
    expect(sum / m.panelCount).toBeLessThan(0.005);
    expect(max).toBeLessThan(0.05);
  });
});
