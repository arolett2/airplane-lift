import { describe, expect, it } from 'vitest';
import type { Vec3, WingGeometry } from '../types';
import { bodyToTunnel } from '../math/frames';
import { solveDense } from '../math/linalg';
import {
  buildVlmModel,
  solveCoupled,
  solveVlm,
  vlmLatticeToTunnel,
  type StripPolarProvider,
  vlmLiftSlope,
  type VlmModel,
  type VlmOptions,
} from './vlm';
import {
  addHorseshoeVelocity,
  addStripHorseshoeVelocities,
  stripScratchLength,
} from './vlmBiotSavart';
import { distributeStrips } from './vlmLayout';
import { makeEllipticWing, makeMockPolar, makeTestWing } from './vlmTestFixtures';
import type { LiftingSurface, WingSection } from '../types';

const DEG = Math.PI / 180;
const NACA2412 = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };
/** Thin-airfoil zero-lift angle of NACA 2412 (rad). */
const ALPHA0_2412 = -2.077 * DEG;

function liftSlope(model: VlmModel): number {
  const a = solveVlm(model, { alpha: 2 * DEG }).CL;
  const b = solveVlm(model, { alpha: -2 * DEG }).CL;
  return (a - b) / (4 * DEG);
}

function spanEfficiency(geo: WingGeometry, model: VlmModel, alpha = 4 * DEG): number {
  const s = solveVlm(model, { alpha });
  return (s.CL * s.CL) / (Math.PI * geo.aspectRatio * s.CDi);
}

/** CDi / CL^2 (equal-CL comparisons). */
function dragFactor(model: VlmModel, alpha = 4 * DEG): number {
  const s = solveVlm(model, { alpha });
  return s.CDi / (s.CL * s.CL);
}

function helmbold(ar: number): number {
  return (2 * Math.PI * ar) / (2 + Math.sqrt(ar * ar + 4));
}

const vec = (arr: Float64Array, i: number): Vec3 => [arr[3 * i]!, arr[3 * i + 1]!, arr[3 * i + 2]!];

describe('vlm Biot–Savart kernel', () => {
  it('a long bound vortex induces Gamma / (2 pi d) like a 2D vortex', () => {
    const out = new Float64Array(3);
    // Bound A->B along +y, legs far away; point 1 m above the middle.
    addHorseshoeVelocity(0, 0, 1, 0, -1e4, 0, 0, 1e4, 0, 0, -1e4, 0, 0, 1e4, 0, 1, 1e-18, out, 0);
    expect(out[0]).toBeCloseTo(1 / (2 * Math.PI), 4); // right-hand rule: +x above a +y vortex
    expect(Math.abs(out[1]!)).toBeLessThan(1e-6);
    expect(Math.abs(out[2]!)).toBeLessThan(1e-3);
  });

  it('a semi-infinite trailing leg induces half the infinite-line velocity at its start', () => {
    const out = new Float64Array(3);
    // Unit-width horseshoe; evaluate beside the B leg's start, far from the rest.
    const d = 0.01;
    addHorseshoeVelocity(
      0,
      1e4 + d,
      0,
      0,
      -1e4,
      0,
      0,
      1e4,
      0,
      0,
      -1e4,
      0,
      0,
      1e4,
      0,
      1,
      1e-18,
      out,
      0,
    );
    // Leg along +x from (0, 1e4, 0); the point is 0.01 m outboard of it, level with its start.
    const legOnly = 1 / (4 * Math.PI * d);
    expect(out[2]! / legOnly).toBeCloseTo(1, 4);
  });

  it('returns zero (not NaN) on a segment and its extension', () => {
    const out = new Float64Array(3);
    addHorseshoeVelocity(0, 0, 0, 0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0, 1, 1e-18, out, 0);
    expect(out.every(Number.isFinite)).toBe(true);
    const ext = new Float64Array(3);
    addHorseshoeVelocity(0, 5, 0, 0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0, 1, 1e-18, ext, 0);
    expect(ext.every(Number.isFinite)).toBe(true);
  });
});

describe('vlm layout', () => {
  it('clusters strips toward the tip and lands edges on sections', () => {
    const pieces = distributeStrips([3, 1], 24);
    expect(pieces).toHaveLength(24);
    // Section boundary at 3/4 of the arc is a strip edge.
    const seg1 = pieces.filter((p) => p.segment === 1);
    expect(seg1[0]!.f0).toBe(0);
    expect(seg1[seg1.length - 1]!.f1).toBe(1);
    // Tip strip narrower than root strip.
    const first = pieces[0]!;
    const last = pieces[pieces.length - 1]!;
    expect(3 * (first.f1 - first.f0)).toBeGreaterThan(5 * (last.f1 - last.f0));
    // Semicircle control points: mid-span near the root, 3/4 of the strip at the tip.
    expect(first.fc).toBeCloseTo(0.5, 2);
    expect(last.fc).toBeCloseTo(0.75, 2);
  });

  it('builds both sides with the mirror and orientation rules', () => {
    const geo = makeTestWing({
      span: 10,
      rootChord: 1.5,
      taper: 0.4,
      sweepQuarterDeg: 25,
      dihedralDeg: 5,
      devices: [{ heightFrac: 0.1, sweepDeg: 40, taper: 0.4 }],
    });
    const m = buildVlmModel(geo);
    const half = m.halfStripCount;
    expect(half).toBe(24 + 6);
    expect(m.strips).toHaveLength(2 * half);
    expect(m.panelCount).toBe(2 * half * 6);
    expect(m.halfPanelCount).toBe(half * 6);
    for (let j = 0; j < half; j++) {
      const r = m.strips[j]!;
      const l = m.strips[j + half]!;
      expect(r.side).toBe('right');
      expect(l.side).toBe('left');
      expect(l.surfaceId).toBe(r.surfaceId.replace('right', 'left'));
      expect(l.center[1]).toBeCloseTo(-r.center[1], 12);
      expect(l.spanTangent[1]).toBeCloseTo(-r.spanTangent[1], 12);
      expect(l.eta).toBe(r.eta);
      expect(l.panelStart).toBe(r.panelStart + m.halfPanelCount);
    }
    // Orientation: right A inboard of B along the span tangent; left A outboard.
    for (let p = 0; p < m.halfPanelCount; p++) {
      const s = m.strips.find((st) => p >= st.panelStart && p < st.panelStart + st.panelCount)!;
      const ab = [0, 1, 2].map((c) => m.boundB[3 * p + c]! - m.boundA[3 * p + c]!);
      expect(
        ab[0]! * s.spanTangent[0] + ab[1]! * s.spanTangent[1] + ab[2]! * s.spanTangent[2],
      ).toBeGreaterThan(0);
      const q = p + m.halfPanelCount;
      expect(m.boundA[3 * q + 1]).toBeCloseTo(-m.boundB[3 * p + 1]!, 12);
      expect(m.trailingA[3 * q + 1]).toBeCloseTo(-m.trailingB[3 * p + 1]!, 12);
    }
    // Eta: base wing 0..1, device beyond 1. Winglet normal points inboard on the right.
    const wingStrips = m.strips.slice(0, 24);
    expect(wingStrips[0]!.eta).toBeGreaterThan(0);
    expect(wingStrips[23]!.eta).toBeLessThan(1);
    const device = m.strips[24]!;
    expect(device.eta).toBeGreaterThan(1);
    expect(device.normal[1]).toBeLessThan(-0.9);
    // Dihedral tilts the wing normal inboard slightly.
    expect(wingStrips[5]!.normal[1]).toBeCloseTo(-Math.sin(5 * DEG), 6);
  });

  it('puts panels on the cambered, flapped mean surface', () => {
    const geo = makeTestWing({
      span: 8,
      rootChord: 1,
      airfoil: NACA2412,
      flap: { chordFrac: 0.25, deflectionDeg: 20, spanFrac: 0.5 },
      slat: true,
    });
    const m = buildVlmModel(geo);
    const flapped = m.strips.filter((s) => s.flap !== null);
    expect(flapped.length).toBeGreaterThan(0);
    for (const s of m.strips) {
      expect(s.flap !== null).toBe(Math.abs(s.center[1]) < 0.5 * 4);
      expect(s.slat).toBe(true);
    }
    // Mid-chord bound points lie above the chord line (camber), flapped TE below it.
    const s0 = m.strips[2]!;
    expect(m.boundA[3 * (s0.panelStart + 3) + 2]).toBeGreaterThan(0);
    expect(m.trailingA[3 * s0.panelStart + 2]).toBeLessThan(-0.25 * Math.tan(20 * DEG) * 0.8);
    const sOut = m.strips[20]!;
    expect(m.trailingA[3 * sOut.panelStart + 2]).toBeCloseTo(0, 6);
  });
});

describe('vlm validation against wing theory', () => {
  it('rectangular AR 6 lift slope is within 10% of Helmbold', () => {
    const geo = makeTestWing({ span: 6, rootChord: 1 });
    const cla = liftSlope(buildVlmModel(geo));
    expect(cla).toBeGreaterThan(4.0);
    expect(cla).toBeLessThan(4.45);
    expect(Math.abs(cla / helmbold(6) - 1)).toBeLessThan(0.1);
  });

  it('elliptic wing: constant downwash CL/(pi AR), e = 1, lifting-surface slope', () => {
    const geo = makeEllipticWing(6);
    const m = buildVlmModel(geo, { spanwisePanelsWing: 40 });
    const s = solveVlm(m, { alpha: 5 * DEG });
    // Trefftz downwash is uniform over the inboard span (the last few, very narrow tip strips
    // sit between closely spaced discrete trailing vortices; the drag integral is unaffected).
    const ai = s.CL / (Math.PI * geo.aspectRatio);
    for (let j = 0; j < m.halfStripCount; j++) {
      if (m.strips[j]!.eta > 0.7) continue;
      expect(s.stripAlphaInduced[j]! / ai).toBeGreaterThan(0.95);
      expect(s.stripAlphaInduced[j]! / ai).toBeLessThan(1.05);
    }
    // Section cl is nearly constant (elliptic loading) over most of the span.
    for (let j = 0; j < m.halfStripCount; j++) {
      if (m.strips[j]!.eta > 0.8) continue;
      expect(s.stripCl[j]! / s.CL).toBeGreaterThan(0.96);
      expect(s.stripCl[j]! / s.CL).toBeLessThan(1.04);
    }
    expect(spanEfficiency(geo, m)).toBeGreaterThan(0.98);
    expect(spanEfficiency(geo, m)).toBeLessThan(1.01);
    // Lifting-surface slope lies below lifting-line 2 pi A / (A + 2) and near Helmbold.
    const cla = liftSlope(m);
    expect(cla).toBeLessThan((2 * Math.PI * 6) / 8);
    expect(Math.abs(cla / helmbold(6) - 1)).toBeLessThan(0.05);
  });

  it('span efficiency: taper 0.4 AR 8 near-elliptic, rectangular AR 6 lower', () => {
    const tapered = makeTestWing({ span: 8 * 0.7, rootChord: 1, taper: 0.4 });
    expect(tapered.aspectRatio).toBeCloseTo(8, 10);
    const eTaper = spanEfficiency(tapered, buildVlmModel(tapered));
    expect(eTaper).toBeGreaterThanOrEqual(0.95);
    expect(eTaper).toBeLessThanOrEqual(1.0);
    const rect = makeTestWing({ span: 6, rootChord: 1 });
    const eRect = spanEfficiency(rect, buildVlmModel(rect));
    expect(eRect).toBeGreaterThanOrEqual(0.85);
    expect(eRect).toBeLessThanOrEqual(0.99);
    expect(eRect).toBeLessThan(eTaper);
  });

  it('higher aspect ratio: steeper lift curve and less induced drag at equal CL', () => {
    const ars = [4, 6, 10];
    const m = ars.map((ar) => buildVlmModel(makeTestWing({ span: ar, rootChord: 1 })));
    const slopes = m.map(liftSlope);
    const k = m.map((x) => dragFactor(x));
    expect(slopes[1]).toBeGreaterThan(slopes[0]!);
    expect(slopes[2]).toBeGreaterThan(slopes[1]!);
    expect(k[1]).toBeLessThan(k[0]!);
    expect(k[2]).toBeLessThan(k[1]!);
  });

  it('35 deg sweep lowers the lift slope and pitches nose-down about the root quarter chord', () => {
    const straight = buildVlmModel(makeTestWing({ span: 6, rootChord: 1 }));
    const swept = buildVlmModel(makeTestWing({ span: 6, rootChord: 1, sweepQuarterDeg: 35 }));
    const ratio = liftSlope(swept) / liftSlope(straight);
    expect(ratio).toBeLessThan(0.95);
    expect(ratio).toBeGreaterThan(0.75);
    // Unswept flat plate: lift acts near the quarter chord -> Cm ~ 0. Swept: lift is aft.
    expect(Math.abs(solveVlm(straight, { alpha: 5 * DEG }).Cm)).toBeLessThan(0.01);
    expect(solveVlm(swept, { alpha: 5 * DEG }).Cm).toBeLessThan(-0.1);
  });

  it('a vertical winglet of 0.1 semispan cuts induced drag at equal CL by 3-30%', () => {
    const base = makeTestWing({ span: 8 * 0.7, rootChord: 1, taper: 0.4 });
    const winglet = makeTestWing({
      span: 8 * 0.7,
      rootChord: 1,
      taper: 0.4,
      devices: [{ heightFrac: 0.1, sweepDeg: 30, taper: 0.5 }],
    });
    const ratio = dragFactor(buildVlmModel(winglet)) / dragFactor(buildVlmModel(base));
    expect(ratio).toBeLessThan(0.97);
    expect(ratio).toBeGreaterThan(0.7);
  });

  it('is left/right symmetric: matches a brute-force full-span solve, zero side force', () => {
    const geo = makeTestWing({
      span: 6,
      rootChord: 1.2,
      taper: 0.5,
      sweepQuarterDeg: 20,
      dihedralDeg: 6,
      airfoil: NACA2412,
      devices: [{ heightFrac: 0.12, sweepDeg: 35, taper: 0.5, cantDeg: 20 }],
    });
    const opts: Partial<VlmOptions> = {
      spanwisePanelsWing: 8,
      chordwisePanels: 3,
      spanwisePanelsDevice: 3,
    };
    const m = buildVlmModel(geo, opts);
    const alpha = 6 * DEG;
    const sol = solveVlm(m, { alpha });
    // Brute force over all panels of BOTH sides, no symmetry: build the left strips' edge
    // polylines explicitly (mirror + A/B swap) and evaluate every horseshoe directly.
    const n = m.panelCount;
    const half = m.halfPanelCount;
    const nc = 3;
    const eA = new Float64Array(2 * m.solver.edgeA.length);
    const eB = new Float64Array(2 * m.solver.edgeB.length);
    eA.set(m.solver.edgeA);
    eB.set(m.solver.edgeB);
    const off = m.solver.edgeA.length;
    for (let i = 0; i < off; i += 3) {
      eA[off + i] = m.solver.edgeB[i]!;
      eA[off + i + 1] = -m.solver.edgeB[i + 1]!;
      eA[off + i + 2] = m.solver.edgeB[i + 2]!;
      eB[off + i] = m.solver.edgeA[i]!;
      eB[off + i + 1] = -m.solver.edgeA[i + 1]!;
      eB[off + i + 2] = m.solver.edgeA[i + 2]!;
    }
    const aic = new Float64Array(n * n);
    const rhs = new Float64Array(n);
    const row = new Float64Array(3 * n);
    const scratch = new Float64Array(stripScratchLength(nc));
    for (let i = 0; i < n; i++) {
      const [px, py, pz] = vec(m.controlPoints, i);
      const nn = vec(m.normals, i);
      rhs[i] = -(Math.cos(alpha) * nn[0] + Math.sin(alpha) * nn[2]);
      row.fill(0);
      for (let st = 0; st < m.strips.length; st++) {
        const p0 = m.strips[st]!.panelStart;
        addStripHorseshoeVelocities(
          px,
          py,
          pz,
          m.boundA,
          m.boundB,
          p0,
          eA,
          eB,
          st * (nc + 1),
          nc,
          1e-20,
          false,
          row,
          scratch,
        );
      }
      for (let j = 0; j < n; j++) {
        aic[i * n + j] = row[3 * j]! * nn[0] + row[3 * j + 1]! * nn[1] + row[3 * j + 2]! * nn[2];
      }
    }
    expect(half * 2).toBe(n);
    const gFull = solveDense(aic, rhs, n);
    let fy = 0;
    for (let i = 0; i < n; i++) {
      expect(sol.gamma[i]).toBeCloseTo(gFull[i]!, 9);
      // Kutta–Joukowski side force with the freestream.
      const a = vec(m.boundA, i);
      const b = vec(m.boundB, i);
      const l = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      fy += gFull[i]! * (Math.sin(alpha) * l[0]! - Math.cos(alpha) * l[2]!);
    }
    expect(Math.abs(fy)).toBeLessThan(1e-9);
    expect(sol.forceCoefficient[1]).toBe(0);
    for (let j = 0; j < m.halfStripCount; j++) {
      expect(sol.stripCl[j + m.halfStripCount]).toBe(sol.stripCl[j]);
    }
  });

  it('converges with mesh refinement (CL and e change < 2% when panels double)', () => {
    const geo = makeTestWing({ span: 8, rootChord: 1.2, taper: 0.5, sweepQuarterDeg: 25 });
    const coarse = buildVlmModel(geo);
    const fine = buildVlmModel(geo, { spanwisePanelsWing: 48, chordwisePanels: 12 });
    const a = solveVlm(coarse, { alpha: 5 * DEG });
    const b = solveVlm(fine, { alpha: 5 * DEG });
    expect(Math.abs(a.CL / b.CL - 1)).toBeLessThan(0.02);
    expect(Math.abs(spanEfficiency(geo, coarse) / spanEfficiency(geo, fine) - 1)).toBeLessThan(
      0.02,
    );
    expect(Math.abs(a.Cm - b.Cm)).toBeLessThan(0.02);
  });

  it('camber lifts at zero alpha (thin-airfoil zero-lift angle) and flaps add lift', () => {
    const plain = buildVlmModel(makeTestWing({ span: 8, rootChord: 1, airfoil: NACA2412 }));
    const cl0 = solveVlm(plain, { alpha: 0 }).CL;
    expect(cl0).toBeGreaterThan(0);
    expect(cl0 / (liftSlope(plain) * -ALPHA0_2412)).toBeCloseTo(1, 1);
    const flapped = buildVlmModel(
      makeTestWing({
        span: 8,
        rootChord: 1,
        airfoil: NACA2412,
        flap: { chordFrac: 0.25, deflectionDeg: 20, spanFrac: 0.6 },
      }),
    );
    const dCL = solveVlm(flapped, { alpha: 0 }).CL - cl0;
    expect(dCL).toBeGreaterThan(0.2);
    expect(dCL).toBeLessThan(0.8);
    // Flaps shift the curve, barely its slope (2D exact-geometry lattice: -1.2% at 20 deg).
    expect(liftSlope(flapped) / liftSlope(plain)).toBeGreaterThan(0.97);
    expect(liftSlope(flapped) / liftSlope(plain)).toBeLessThan(1.01);
  });

  it('uniform strip incidence on a planar wing equals a change of alpha', () => {
    const m = buildVlmModel(makeTestWing({ span: 7, rootChord: 1, taper: 0.6 }));
    const d = 0.02;
    const inc = new Float64Array(m.strips.length).fill(d);
    const a = solveVlm(m, { alpha: 0.05, stripIncidence: inc });
    const b = solveVlm(m, { alpha: 0.05 + d });
    expect(a.CL / b.CL).toBeCloseTo(1, 3);
    expect(a.CDi / b.CDi).toBeCloseTo(1, 2);
    for (let j = 0; j < m.strips.length; j++) {
      expect(a.stripCirculation[j]! / b.stripCirculation[j]!).toBeCloseTo(1, 3);
    }
  });

  it('Prandtl–Glauert: high-AR lift slope rises ~1/beta, a swept wing rises less', () => {
    const mach = 0.7;
    const beta = Math.sqrt(1 - mach * mach);
    const straight = makeTestWing({ span: 20, rootChord: 1 });
    const swept = makeTestWing({ span: 20, rootChord: 1, sweepQuarterDeg: 35 });
    const rs = liftSlope(buildVlmModel(straight, { mach })) / liftSlope(buildVlmModel(straight));
    const rw = liftSlope(buildVlmModel(swept, { mach })) / liftSlope(buildVlmModel(swept));
    expect(rs).toBeGreaterThan(1.25);
    expect(rs).toBeLessThan(1 / beta);
    expect(rw).toBeGreaterThan(1.05);
    expect(rw).toBeLessThan(rs - 0.05);
    // Mach is clamped at 0.85.
    const m1 = buildVlmModel(straight, { mach: 0.99 });
    expect(m1.beta).toBeCloseTo(Math.sqrt(1 - 0.85 * 0.85), 12);
  });
});

describe('vlm robustness and tip devices', () => {
  const base = { span: 8 * 0.7, rootChord: 1, taper: 0.4 } as const;

  it('an in-plane tip extension acts like extra span; a split winglet beats a single one', () => {
    const k0 = dragFactor(buildVlmModel(makeTestWing(base)));
    const ext = buildVlmModel(
      makeTestWing({ ...base, devices: [{ heightFrac: 0.1, cantDeg: 90 }] }),
    );
    expect(dragFactor(ext) / k0).toBeLessThan(0.9);
    expect(vlmLiftSlope(ext)).toBeGreaterThan(vlmLiftSlope(buildVlmModel(makeTestWing(base))));
    const upper = { heightFrac: 0.1, sweepDeg: 40, taper: 0.4 };
    const lower = { heightFrac: 0.05, sweepDeg: 40, taper: 0.4, cantDeg: 160 };
    const single = buildVlmModel(makeTestWing({ ...base, devices: [upper] }));
    const split = buildVlmModel(makeTestWing({ ...base, devices: [upper, lower] }));
    expect(split.halfStripCount).toBe(24 + 12);
    expect(dragFactor(split)).toBeLessThan(dragFactor(single));
    // The lower fin carries positive (outboard-pushing) circulation at positive lift.
    const sol = solveVlm(split, { alpha: 5 * DEG });
    for (let j = 30; j < 36; j++) expect(sol.stripCirculation[j]).toBeGreaterThan(0);
  });

  it('handles a smoothly curving multi-section (blended) winglet', () => {
    const geo = makeTestWing(base);
    const right = geo.surfaces[0]!;
    const tip = right.sections[right.sections.length - 1]!;
    const h = 0.12 * 0.5 * base.span;
    const sections: WingSection[] = [];
    for (let k = 0; k <= 4; k++) {
      const roll = ((k / 4) * 80 * Math.PI) / 180;
      const prev = sections[k - 1];
      const le: Vec3 = prev
        ? [
            prev.le[0] + 0.05,
            prev.le[1] + (h / 4) * Math.cos(roll),
            prev.le[2] + (h / 4) * Math.sin(roll),
          ]
        : [...tip.le];
      sections.push({ ...tip, le, roll, chord: tip.chord * (1 - 0.15 * k), flap: null });
    }
    const winglet: LiftingSurface = {
      id: 'wl-right',
      name: 'Right winglet',
      side: 'right',
      role: 'tip-device',
      sections,
    };
    const mirrored: LiftingSurface = {
      ...winglet,
      id: 'wl-left',
      side: 'left',
      sections: sections.map((sec) => ({ ...sec, le: [sec.le[0], -sec.le[1], sec.le[2]] as Vec3 })),
    };
    const blended = { ...geo, surfaces: [right, winglet, geo.surfaces[1]!, mirrored] };
    const m = buildVlmModel(blended);
    const sol = solveVlm(m, { alpha: 4 * DEG });
    expect(Number.isFinite(sol.CL) && Number.isFinite(sol.CDi)).toBe(true);
    expect(dragFactor(m)).toBeLessThan(dragFactor(buildVlmModel(geo)));
    // Strip normals turn smoothly from up to inboard along the winglet.
    const wl = m.strips.filter((s) => s.surfaceId === 'wl-right');
    expect(wl).toHaveLength(6);
    for (let j = 1; j < wl.length; j++) {
      expect(wl[j]!.normal[1]).toBeLessThanOrEqual(wl[j - 1]!.normal[1] + 1e-12);
    }
    expect(wl[wl.length - 1]!.normal[1]).toBeLessThan(wl[0]!.normal[1] - 0.5);
    expect(m.strips.find((s) => s.surfaceId === 'wl-left')).toBeDefined();
  });

  it('survives duplicate sections and more sections than strips', () => {
    const geo = makeTestWing(base);
    const right = geo.surfaces[0]!;
    const secs = right.sections;
    const many: WingSection[] = [];
    for (let k = 0; k <= 40; k++) {
      const f = k / 40;
      const a = secs[0]!;
      const b = secs[1]!;
      many.push({
        ...a,
        le: [a.le[0] + f * (b.le[0] - a.le[0]), f * b.le[1], 0],
        chord: a.chord + f * (b.chord - a.chord),
      });
      if (k === 20) many.push({ ...many[many.length - 1]! }); // duplicate section
    }
    const r: LiftingSurface = { ...right, sections: many };
    const l: LiftingSurface = {
      ...r,
      id: 'wing-left',
      side: 'left',
      sections: many.map((x) => ({ ...x, le: [x.le[0], -x.le[1], x.le[2]] as Vec3 })),
    };
    const m = buildVlmModel({ ...geo, surfaces: [r, l] });
    expect(m.halfStripCount).toBe(40);
    const a = solveVlm(m, { alpha: 4 * DEG });
    const b = solveVlm(buildVlmModel(geo), { alpha: 4 * DEG });
    // 40 section-forced (nearly uniform) strips vs the default cosine mesh.
    expect(Math.abs(a.CL / b.CL - 1)).toBeLessThan(0.02);
  });

  it('stalls at large negative angles too, and accepts half-length incidence arrays', () => {
    const m = buildVlmModel(makeTestWing({ span: 8, rootChord: 1, airfoil: NACA2412 }));
    const prov: StripPolarProvider = {
      polar: () => makeMockPolar({ alphaZeroLift: ALPHA0_2412 }),
      reynolds: () => 1e6,
    };
    const deep = solveCoupled(m, -26 * DEG, prov);
    expect(deep.stripStalled.some((x) => x === 1)).toBe(true);
    expect(deep.CL).toBeGreaterThan(solveVlm(m, { alpha: -26 * DEG }).CL);
    const half = new Float64Array(m.halfStripCount).fill(0.01);
    const full = new Float64Array(m.strips.length).fill(0.01);
    expect(solveVlm(m, { alpha: 0.1, stripIncidence: half }).CL).toBeCloseTo(
      solveVlm(m, { alpha: 0.1, stripIncidence: full }).CL,
      12,
    );
  });

  it('stays finite at the Mach clamp and the coupled solve matches the linear one there', () => {
    const m = buildVlmModel(
      makeTestWing({ span: 30, rootChord: 4, taper: 0.3, sweepQuarterDeg: 30 }),
      { mach: 0.85 },
    );
    const lin = solveVlm(m, { alpha: 2 * DEG });
    const c = solveCoupled(m, 2 * DEG, {
      polar: () => makeMockPolar({ alphaZeroLift: 0 }),
      reynolds: () => 4e7,
    });
    expect(Number.isFinite(lin.CL) && Number.isFinite(lin.CDi) && Number.isFinite(lin.Cm)).toBe(
      true,
    );
    expect(c.CL / lin.CL).toBeCloseTo(1, 4);
    expect(c.stripClMax[0]).toBeCloseTo(
      makeMockPolar({ alphaZeroLift: 0 }).clMax(4e7) / m.beta,
      10,
    );
  });
});

describe('vlmLatticeToTunnel', () => {
  it('pitches the lattice into the tunnel frame with the orientation rule', () => {
    const geo = makeTestWing({ span: 6, rootChord: 1, devices: [{ heightFrac: 0.1 }] });
    const m = buildVlmModel(geo, {
      spanwisePanelsWing: 6,
      chordwisePanels: 2,
      spanwisePanelsDevice: 2,
    });
    const alpha = 8 * DEG;
    const sol = solveVlm(m, { alpha });
    const lat = vlmLatticeToTunnel(m, sol, alpha, 50);
    expect(lat.count).toBe(m.panelCount);
    expect(lat.sources.count).toBe(0);
    expect(lat.coreRadius).toBeCloseTo(0.06, 12);
    for (let p = 0; p < m.panelCount; p++) {
      expect(lat.gamma[p]).toBeCloseTo(sol.gamma[p]! * 50, 3);
      expect(sol.gamma[p]).toBeGreaterThan(-1e-9);
      const t = bodyToTunnel(vec(m.trailingB, p), geo.pivot, alpha);
      expect(lat.teB[3 * p]).toBeCloseTo(t[0], 5);
      expect(lat.teB[3 * p + 2]).toBeCloseTo(t[2], 5);
    }
    // Pitched nose-up: trailing edges drop below the pivot.
    expect(lat.teA[2]).toBeLessThan(0);
    // Right base wing: A inboard of B; left: A outboard of B.
    expect(lat.b[1]).toBeGreaterThan(lat.a[1]!);
    const q = m.halfPanelCount;
    expect(Math.abs(lat.a[3 * q + 1]!)).toBeGreaterThan(Math.abs(lat.b[3 * q + 1]!));
  });
});

describe('solveCoupled', () => {
  const provider = (spec: Parameters<typeof makeMockPolar>[0]): StripPolarProvider => {
    const polar = makeMockPolar(spec);
    return { polar: () => polar, reynolds: () => 1e6 };
  };

  it('matches the linear lattice below stall when the polar is linear (no flap double count)', () => {
    const geo = makeTestWing({
      span: 9,
      rootChord: 1.3,
      taper: 0.4,
      sweepQuarterDeg: 30,
      airfoil: NACA2412,
      flap: { chordFrac: 0.25, deflectionDeg: 15, spanFrac: 0.5 },
      devices: [{ heightFrac: 0.1, sweepDeg: 40, taper: 0.5 }],
    });
    const m = buildVlmModel(geo);
    // Very late stall: linear over the tested range. Any zero-lift angle works by construction.
    const prov = provider({ alphaZeroLift: -8 * DEG, alphaStall: 60 * DEG });
    for (const ad of [-2, 3, 8]) {
      const c = solveCoupled(m, ad * DEG, prov);
      const lin = solveVlm(m, { alpha: ad * DEG });
      expect(c.converged).toBe(true);
      expect(Math.abs(c.CL - lin.CL)).toBeLessThan(0.02 * Math.abs(lin.CL) + 1e-6);
      expect(c.stripStalled.every((s) => s === 0)).toBe(true);
    }
  });

  it('effective angle ~ geometric angle minus Trefftz downwash on a straight wing', () => {
    const m = buildVlmModel(makeTestWing({ span: 10, rootChord: 1 }));
    const c = solveCoupled(m, 6 * DEG, provider({ alphaZeroLift: 0, alphaStall: 60 * DEG }));
    for (let j = 0; j < m.halfStripCount; j++) {
      if (m.strips[j]!.eta > 0.6) continue;
      expect(c.stripAlphaGeometric[j]).toBeCloseTo(6 * DEG, 10);
      expect(
        Math.abs(c.stripAlphaEffective[j]! - (6 * DEG - c.stripAlphaDownwash[j]!)),
      ).toBeLessThan(0.25 * DEG);
      expect(c.stripAlphaInduced[j]).toBeCloseTo(
        c.stripAlphaGeometric[j]! - c.stripAlphaEffective[j]!,
        12,
      );
    }
  });

  it('a thicker polar (slope 6.9) raises CL in proportion before stall', () => {
    const m = buildVlmModel(makeTestWing({ span: 8, rootChord: 1 }));
    const c = solveCoupled(m, 5 * DEG, provider({ alphaZeroLift: 0, liftSlope: 6.9 }));
    const lin = solveVlm(m, { alpha: 5 * DEG });
    expect(c.CL / lin.CL).toBeGreaterThan(1.04);
    expect(c.CL / lin.CL).toBeLessThan(6.9 / (2 * Math.PI) + 0.01);
  });

  it('stalls: CL peaks then drops, stalled strips are flagged and contiguous, solution symmetric', () => {
    const m = buildVlmModel(makeTestWing({ span: 8, rootChord: 1 }));
    const prov = provider({ alphaZeroLift: 0 });
    let clMax = 0;
    let alphaMax = 0;
    const cls: number[] = [];
    for (let ad = 0; ad <= 30; ad += 1) {
      const c = solveCoupled(m, ad * DEG, prov);
      cls.push(c.CL);
      if (c.CL > clMax) {
        clMax = c.CL;
        alphaMax = ad;
      }
      if (ad <= 10) expect(c.stripStalled.some((s) => s === 1)).toBe(false);
    }
    expect(alphaMax).toBeGreaterThan(12);
    expect(alphaMax).toBeLessThan(22);
    expect(cls[30]!).toBeLessThan(0.85 * clMax);
    const c = solveCoupled(m, 22 * DEG, prov);
    const half = m.halfStripCount;
    const pattern = Array.from(c.stripStalled.slice(0, half)).join('');
    expect(pattern).toMatch(/^0*1+0*$/); // one contiguous stalled region
    for (let j = 0; j < half; j++) {
      expect(c.stripStalled[j + half]).toBe(c.stripStalled[j]);
      expect(c.stripClViscous[j + half]).toBe(c.stripClViscous[j]);
      if (c.stripStalled[j]) {
        expect(c.stripAttachedFraction[j]).toBeLessThan(1);
        expect(c.stripCd[j]).toBeGreaterThan(0.008);
      }
      expect(Math.abs(c.stripClViscous[j]! - c.stripClPolar[j]!)).toBeLessThan(0.4);
    }
    expect(c.stripClMax[0]).toBeGreaterThan(1.2);
  });

  it('washout moves the first stall inboard', () => {
    const firstStallEta = (washoutDeg: number): number => {
      const m = buildVlmModel(
        makeTestWing({ span: 8 * 0.65, rootChord: 1, taper: 0.3, washoutDeg }),
      );
      const prov = provider({ alphaZeroLift: 0 });
      for (let ad = 8; ad <= 30; ad += 0.5) {
        const c = solveCoupled(m, ad * DEG, prov);
        let sum = 0;
        let n = 0;
        for (let j = 0; j < m.halfStripCount; j++) {
          if (c.stripStalled[j]) {
            sum += m.strips[j]!.eta;
            n++;
          }
        }
        if (n > 0) return sum / n;
      }
      return NaN;
    };
    const plain = firstStallEta(0);
    const washed = firstStallEta(6);
    expect(plain).toBeGreaterThan(0.45);
    expect(washed).toBeLessThan(plain - 0.15);
  });
});

describe('vlm performance', () => {
  it('builds and solves the default lattice fast enough for interaction', () => {
    const geo = makeTestWing({
      span: 34,
      rootChord: 7,
      taper: 0.25,
      sweepQuarterDeg: 25,
      dihedralDeg: 6,
      washoutDeg: 3,
      airfoil: NACA2412,
      flap: { chordFrac: 0.3, deflectionDeg: 10, spanFrac: 0.6 },
      devices: [{ heightFrac: 0.12, sweepDeg: 50, taper: 0.3, cantDeg: 15 }],
    });
    buildVlmModel(geo); // warm-up (JIT)
    let t = performance.now();
    const m = buildVlmModel(geo);
    const tBuild = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 50; i++) solveVlm(m, { alpha: 0.05 });
    const tSolve = (performance.now() - t) / 50;
    const prov: StripPolarProvider = {
      polar: () => makeMockPolar({ alphaZeroLift: ALPHA0_2412 }),
      reynolds: () => 3e7,
    };
    solveCoupled(m, 0.3, prov);
    t = performance.now();
    for (let i = 0; i < 10; i++) solveCoupled(m, (12 + 2 * i) * DEG, prov);
    const tCoupled = (performance.now() - t) / 10;
    // eslint-disable-next-line no-console
    console.log(
      `vlm perf (N=${m.halfPanelCount}/half): build ${tBuild.toFixed(1)} ms, ` +
        `solve ${tSolve.toFixed(2)} ms, coupled ${tCoupled.toFixed(2)} ms`,
    );
    // Budgets: build < 60 ms, solve < 3 ms, coupled < 40 ms. Asserts are generous for CI noise.
    expect(tBuild).toBeLessThan(300);
    expect(tSolve).toBeLessThan(15);
    expect(tCoupled).toBeLessThan(200);
  });
});
