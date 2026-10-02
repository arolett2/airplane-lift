/**
 * Adversarial checks from the independent review: theory comparisons and the failure modes found
 * at extreme slider values (thin / thick / flapped / cambered sections, dihedral, high alpha,
 * large lattice core radius).
 */
import { describe, expect, it } from 'vitest';
import type { Naca4Params, Vec3, WingGeometry } from '../types';
import { tunnelDomain } from '../domain';
import { bodyToTunnel } from '../math/frames';
import { camberLine, generateAirfoil, nacaHalfThickness } from '../airfoil/naca';
import {
  buildFlowFieldGrid,
  buildThicknessSources,
  createWingSolidTester,
  seedStreamlines,
  traceStreamlines,
  velocityAt,
} from './index';
import { WingSolid } from './solid';
import {
  addInducedExact,
  addInducedFast,
  distanceToWing,
  getCompiledLattice,
  rootSnappedPoints,
  SMOOTH_CHORDS,
} from './lattice';
import { ellipticGamma, makeTestLattice, makeTestWing } from './testFixtures';

const deg = Math.PI / 180;

describe('trailing vortex sheet vs lifting-line theory', () => {
  it('elliptic loading gives uniform Trefftz-plane downwash w = -Gamma0 / b', () => {
    const vInf = 50;
    const CL = 0.5;
    const wing = makeTestWing({
      span: 10,
      rootChord: 1,
      airfoil: { camber: 0, camberPos: 0.4, thickness: 0.12 },
    });
    const ns = 24;
    const lattice = makeTestLattice(wing, 0, {
      nSpanWing: ns,
      nChord: 4,
      gamma: ellipticGamma(wing, vInf, CL),
      coreRadius: 0.01,
    });
    const g0 = (2 * vInf * wing.referenceArea * CL) / (Math.PI * wing.referenceSpan);
    const v = new Float64Array(3);
    // Far downstream, between the discrete filaments (strip centres), both sides.
    for (const j of [0, 4, 9, 14, 18]) {
      for (const side of [1, -1]) {
        const y = (side * (j + 0.5) * 5) / ns;
        velocityAt(lattice, vInf, 500, y, 0, v);
        expect(v[2]! / (-g0 / wing.referenceSpan)).toBeCloseTo(1, 1);
        expect(Math.abs(v[2]! / (-g0 / wing.referenceSpan) - 1)).toBeLessThan(0.01);
      }
    }
  });
});

describe('thickness sources vs exact NACA 0012 surface speed', () => {
  it('matches Abbott & von Doenhoff v/V on a long wing at zero lift', () => {
    const vInf = 1;
    const wing = makeTestWing({
      span: 200,
      rootChord: 1,
      airfoil: { camber: 0, camberPos: 0.4, thickness: 0.12 },
    });
    const lattice = makeTestLattice(wing, 0, { gamma: () => 0 });
    lattice.sources = buildThicknessSources(wing, 0, vInf);
    // Exact potential-flow surface speed of NACA 0012 at alpha = 0 (Abbott & von Doenhoff).
    const exact: [number, number][] = [
      [0.1, 1.188],
      [0.2, 1.183],
      [0.3, 1.162],
      [0.4, 1.135],
      [0.5, 1.108],
      [0.6, 1.08],
      [0.7, 1.053],
      [0.8, 1.022],
    ];
    const v = new Float64Array(3);
    const y = 50 + 100 / 48; // middle of a source strip, far from the tips
    for (const [x, ref] of exact) {
      velocityAt(lattice, vInf, x, y, nacaHalfThickness(0.12, x), v);
      const speed = Math.hypot(v[0]!, v[1]!, v[2]!);
      expect(Math.abs(speed - ref)).toBeLessThan(0.05);
    }
  });
});

describe('thickness sources vs thin-airfoil thickness theory', () => {
  const vInf = 1;
  const y = 50 + 100 / 48; // middle of a source strip on a long wing, far from the tips

  /** Linear theory on the sheet: u/V = 1 + (1/pi) PV int (dyt/dxi) / (x - xi) dxi. */
  function linearTheory(t: number, x: number): number {
    const slope = (xi: number) => {
      const h = 1e-7;
      const a = Math.max(0, xi - h);
      const b = Math.min(1, xi + h);
      return (nacaHalfThickness(t, b) - nacaHalfThickness(t, a)) / (b - a);
    };
    const fx = slope(x);
    const n = 20000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const th = ((i + 0.5) / n) * Math.PI;
      const xi = 0.5 * (1 - Math.cos(th));
      sum += ((slope(xi) - fx) / (x - xi)) * 0.5 * Math.sin(th) * (Math.PI / n);
    }
    // Subtracted singularity: PV int_0^1 dxi / (x - xi) = ln(x / (1 - x)).
    return 1 + (sum + fx * Math.log(x / (1 - x))) / Math.PI;
  }

  for (const t of [0.04, 0.12, 0.24]) {
    it(`matches linear theory on the chord plane for t/c = ${t}`, () => {
      const wing = makeTestWing({
        span: 200,
        rootChord: 1,
        airfoil: { camber: 0, camberPos: 0.4, thickness: t },
      });
      const lattice = makeTestLattice(wing, 0, { gamma: () => 0 });
      lattice.sources = buildThicknessSources(wing, 0, vInf);
      const v = new Float64Array(3);
      for (const x of [0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9]) {
        velocityAt(lattice, vInf, x, y, 1e-4, v);
        // The perturbation u - 1 scales with t: within 20% of it plus 1% of V (16 lumped lines
        // cannot follow the 1/sqrt(x) source strength right at the nose perfectly).
        const lin = linearTheory(t, x);
        expect(Math.abs(v[0]! - lin)).toBeLessThan(0.2 * Math.abs(lin - 1) + 0.01);
      }
    });

    it(`has no visible speed ripple next to the skin for t/c = ${t}`, () => {
      const wing = makeTestWing({
        span: 200,
        rootChord: 1,
        airfoil: { camber: 0, camberPos: 0.4, thickness: t },
      });
      const lattice = makeTestLattice(wing, 0, { gamma: () => 0 });
      lattice.sources = buildThicknessSources(wing, 0, vInf);
      // Reference: 400 nearly singular lines, a converged discretisation of the same sheet.
      const N = 400;
      const p0: number[] = [];
      const p1: number[] = [];
      const sigma: number[] = [];
      for (let i = 0; i < N; i++) {
        const xa = 0.5 * (1 - Math.cos((Math.PI * i) / N));
        const xb = 0.5 * (1 - Math.cos((Math.PI * (i + 1)) / N));
        const xm = i === 0 ? xb / 3 : 0.5 * (xa + xb);
        p0.push(xm, -100, 0);
        p1.push(xm, 100, 0);
        sigma.push(2 * vInf * (nacaHalfThickness(t, xb) - nacaHalfThickness(t, xa)));
      }
      const ref = makeTestLattice(wing, 0, { gamma: () => 0, coreRadius: 1e-4 });
      ref.sources = {
        count: N,
        p0: Float32Array.from(p0),
        p1: Float32Array.from(p1),
        sigma: Float32Array.from(sigma),
      };
      const a = new Float64Array(3);
      const b = new Float64Array(3);
      let worst = 0;
      for (let i = 0; i <= 200; i++) {
        const x = 0.02 + (0.96 * i) / 200;
        const z = nacaHalfThickness(t, x) + 0.01;
        velocityAt(lattice, vInf, x, y, z, a);
        velocityAt(ref, vInf, x, y, z, b);
        worst = Math.max(worst, Math.abs(Math.hypot(a[0]!, a[2]!) - Math.hypot(b[0]!, b[2]!)));
      }
      expect(worst).toBeLessThan(0.02 * vInf);
    });
  }
});

describe('solid tester vs the rendered airfoil surface', () => {
  /** Ray-casting point-in-polygon and distance to the contour, airfoil frame (unit chord). */
  function contourTools(c: Float64Array, n: number) {
    return {
      inside(x: number, y: number): boolean {
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = c[2 * i]!;
          const yi = c[2 * i + 1]!;
          const xj = c[2 * j]!;
          const yj = c[2 * j + 1]!;
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      },
      distance(x: number, y: number): number {
        let best = Infinity;
        for (let i = 0; i + 1 < n; i++) {
          const ax = c[2 * i]!;
          const ay = c[2 * i + 1]!;
          const bx = c[2 * i + 2]!;
          const by = c[2 * i + 3]!;
          const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
          let t = l2 > 0 ? ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          best = Math.min(best, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
        }
        return best;
      },
    };
  }

  // The wing mesh lofts generateAirfoil(): thickness applied PERPENDICULAR to the camber line.
  const cases: { airfoil: Naca4Params; flap: { chordFrac: number; deflection: number } | null }[] =
    [
      { airfoil: { camber: 0.09, camberPos: 0.4, thickness: 0.24 }, flap: null },
      { airfoil: { camber: 0.09, camberPos: 0.2, thickness: 0.12 }, flap: null },
      {
        airfoil: { camber: 0.04, camberPos: 0.4, thickness: 0.24 },
        flap: { chordFrac: 0.4, deflection: 40 * deg },
      },
      {
        airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
        flap: { chordFrac: 0.3, deflection: 40 * deg },
      },
      { airfoil: { camber: 0, camberPos: 0.4, thickness: 0.04 }, flap: null },
    ];
  for (const { airfoil, flap } of cases) {
    const label = `${JSON.stringify(airfoil)} flap ${flap ? 'down' : 'up'}`;
    it(`matches the rendered contour beyond 0.3% chord: ${label}`, () => {
      const chord = 2;
      const wing = makeTestWing({ span: 10, rootChord: chord, airfoil, flap });
      const inside = createWingSolidTester(wing, 0);
      const af = generateAirfoil(airfoil, 600, flap);
      const contour = contourTools(af.coords, af.nPoints);
      let checked = 0;
      let disagree = 0;
      for (let i = 0; i <= 160; i++) {
        for (let j = 0; j <= 80; j++) {
          const x = -0.05 + (1.1 * i) / 160;
          const y = -0.45 + (0.65 * j) / 80;
          // The drawn nose of a strongly cambered section bulges up to 0.5% chord ahead of
          // x = 0; the solid starts at x = 0.
          if (contour.distance(x, y) < 0.003 || (x < 0 && contour.inside(x, y))) continue;
          checked++;
          if (inside(x * chord, 2, y * chord) !== contour.inside(x, y)) disagree++;
        }
      }
      expect(checked).toBeGreaterThan(8000);
      expect(disagree).toBe(0);
    });
  }

  it('pushes points out of a deflected flap beyond the rendered skin', () => {
    const airfoil = { camber: 0.02, camberPos: 0.4, thickness: 0.24 };
    const flap = { chordFrac: 0.4, deflection: 40 * deg };
    const wing = makeTestWing({ span: 10, rootChord: 1, airfoil, flap });
    const solid = new WingSolid(wing, 0);
    const af = generateAirfoil(airfoil, 600, flap);
    const contour = contourTools(af.coords, af.nPoints);
    for (const xc of [0.62, 0.7, 0.8, 0.9]) {
      for (const side of [0.5, -0.5]) {
        const yc = camberLine(airfoil, flap, xc).yc;
        const p = Float64Array.from([xc, 2, yc + side * nacaHalfThickness(0.24, xc)]);
        expect(solid.contains(p[0]!, p[1]!, p[2]!)).toBe(true);
        expect(solid.pushOut(p)).toBe(true);
        expect(contour.inside(p[0]!, p[2]!)).toBe(false);
        expect(contour.distance(p[0]!, p[2]!)).toBeLessThan(0.02);
      }
    }
  });
});

/** Right/left mirror-symmetric lattice of a dihedral wing with a deflected full-span flap. */
function flappedDihedralWing(): { wing: WingGeometry; alpha: number; vInf: number } {
  const wing = makeTestWing({
    span: 30,
    rootChord: 6,
    tipChord: 2.4,
    sweep: 25 * deg,
    dihedral: 7 * deg,
    airfoil: { camber: 0.04, camberPos: 0.4, thickness: 0.12 },
    flap: { chordFrac: 0.4, deflection: 40 * deg },
  });
  return { wing, alpha: 10 * deg, vInf: 60 };
}

describe('centreline of a dihedral wing with flaps', () => {
  it('has no spurious trailing vortex pair (jet) at the plane of symmetry', () => {
    const { wing, alpha, vInf } = flappedDihedralWing();
    const lattice = makeTestLattice(wing, alpha, {
      gamma: ellipticGamma(wing, vInf, 2),
      coreRadius: 0.05,
    });
    // The two root strips' inboard trailing-edge points are mirror images, apart in y because
    // the flap's camber drop follows the dihedral-rolled section normal.
    const te = (k: number) => [lattice.teA[3 * k]!, lattice.teA[3 * k + 1]!];
    expect(Math.abs(te(0)[1]!)).toBeGreaterThan(0.1);
    const v = new Float64Array(3);
    const w: number[] = [];
    // Across the centreline, well behind the wing, at the height of the trailing legs.
    const zTe = lattice.teA[2]!;
    for (const y of [-0.6, -0.3, 0, 0.3, 0.6]) {
      velocityAt(lattice, vInf, 40, y, zTe, v);
      w.push(v[2]!);
      expect(Math.hypot(v[0]! - vInf, v[1]!, v[2]!)).toBeLessThan(0.35 * vInf);
    }
    // The downwash varies smoothly across the plane of symmetry.
    expect(Math.abs(w[2]! - 0.5 * (w[1]! + w[3]!))).toBeLessThan(0.03 * vInf);
  });
});

describe('root-edge snapping', () => {
  it('moves only the mirror-image root-edge points of the two root strips onto y = 0', () => {
    const { wing, alpha, vInf } = flappedDihedralWing();
    const lattice = makeTestLattice(wing, alpha, { gamma: ellipticGamma(wing, vInf, 2) });
    const pts = rootSnappedPoints(lattice, 1e-6 * 30);
    let moved = 0;
    for (const [name, arr] of [
      ['a', lattice.a],
      ['b', lattice.b],
      ['teA', lattice.teA],
      ['teB', lattice.teB],
    ] as const) {
      const out = pts[name];
      for (let i = 0; i < lattice.count; i++) {
        expect(out[3 * i]).toBe(arr[3 * i]);
        expect(out[3 * i + 2]).toBe(arr[3 * i + 2]);
        if (out[3 * i + 1] !== arr[3 * i + 1]) {
          moved++;
          expect(out[3 * i + 1]).toBe(0);
          expect(Math.abs(arr[3 * i + 1]!)).toBeLessThan(0.5);
        }
      }
    }
    // Two root strips x 6 chordwise panels x (bound point + trailing-edge point).
    expect(moved).toBe(2 * 6 * 2);
  });

  it('leaves trailing-edge points without a root gap untouched', () => {
    const wing = makeTestWing({ span: 10, rootChord: 1.5, dihedral: 5 * deg });
    const lattice = makeTestLattice(wing, 0, { gamma: () => 1 });
    // NACA 2412 camber puts the root bound points (not the trailing edge, where the camber is
    // zero) slightly off y = 0; the trailing-edge points must not move.
    const pts = rootSnappedPoints(lattice, 1e-5);
    for (let i = 0; i < lattice.count; i++) {
      expect(pts.teA[3 * i + 1]).toBe(lattice.teA[3 * i + 1]);
      expect(pts.teB[3 * i + 1]).toBe(lattice.teB[3 * i + 1]);
    }
  });
});

describe('thickness sources without their metadata (structured clone)', () => {
  it('fast near/far evaluator stays within 1% of the exact field', () => {
    const wing = makeTestWing({
      span: 16,
      rootChord: 6,
      tipChord: 2.4,
      sweep: 25 * deg,
      airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.24 },
    });
    const vInf = 60;
    const alpha = 6 * deg;
    const lattice = makeTestLattice(wing, alpha, { gamma: ellipticGamma(wing, vInf, 0.8) });
    lattice.sources = structuredClone(buildThicknessSources(wing, alpha, vInf));
    const c = getCompiledLattice(lattice);
    // Grouped back into one group per strip.
    expect(c.groupCount).toBe(48);
    const e = new Float64Array(3);
    const f = new Float64Array(3);
    const d = new Float64Array(2);
    let seed = 5;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    let worst = 0;
    for (let tested = 0; tested < 1500;) {
      const x = -12 + rand() * 36;
      const y = (rand() - 0.5) * 20;
      const z = (rand() - 0.5) * 18;
      distanceToWing(c, x, y, z, d);
      if (d[0]! < SMOOTH_CHORDS * d[1]!) continue;
      tested++;
      e.fill(0);
      f.fill(0);
      addInducedExact(c, x, y, z, e);
      addInducedFast(c, x, y, z, f);
      worst = Math.max(worst, Math.hypot(e[0]! - f[0]!, e[1]! - f[1]!, e[2]! - f[2]!) / vInf);
    }
    expect(worst).toBeLessThan(0.01);
  });
});

describe('vortex core of a high aspect-ratio wing', () => {
  it('keeps the speed-up over the wing when the lattice core is large (1% of span)', () => {
    const span = 30;
    const chord = 1;
    const vInf = 30;
    const alpha = 5 * deg;
    const wing = makeTestWing({ span, rootChord: chord });
    const big = makeTestLattice(wing, alpha, {
      gamma: ellipticGamma(wing, vInf, 0.6),
      coreRadius: 0.01 * span,
    });
    const small = makeTestLattice(wing, alpha, {
      gamma: ellipticGamma(wing, vInf, 0.6),
      coreRadius: 0.005 * chord,
    });
    big.sources = buildThicknessSources(wing, alpha, vInf);
    small.sources = big.sources;
    const airfoil = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };
    const vb = new Float64Array(3);
    const vs = new Float64Array(3);
    for (const xc of [0.1, 0.3, 0.6]) {
      const zc = camberLine(airfoil, null, xc).yc + nacaHalfThickness(0.12, xc) + 0.02;
      const p = bodyToTunnel([xc * chord, 0.3 * (span / 2), zc * chord], wing.pivot, alpha);
      velocityAt(big, vInf, p[0], p[1], p[2], vb);
      velocityAt(small, vInf, p[0], p[1], p[2], vs);
      const sb = Math.hypot(vb[0]!, vb[1]!, vb[2]!) / vInf;
      const ss = Math.hypot(vs[0]!, vs[1]!, vs[2]!) / vInf;
      expect(ss).toBeGreaterThan(1.15);
      expect(Math.abs(sb - ss)).toBeLessThan(0.03);
    }
  });
});

/** Penetration: how far (in chords, along the section normal) a point sits inside the solid. */
function depthInside(solid: WingSolid, x: number, y: number, z: number, chord: number): number {
  if (!solid.contains(x, y, z)) return 0;
  const q = Float64Array.from([x, y, z]);
  solid.pushOut(q);
  // pushOut leaves a 0.4% chord clearance above the skin.
  return Math.max(0, Math.hypot(q[0]! - x, q[1]! - y, q[2]! - z) / chord - 0.004);
}

describe('streamlines at extreme settings', () => {
  const configs: { name: string; wing: WingGeometry; alpha: number; cl: number }[] = [
    {
      name: 'thin flapped wing at 20 deg',
      wing: makeTestWing({
        span: 16,
        rootChord: 4,
        tipChord: 1.2,
        sweep: 30 * deg,
        dihedral: 5 * deg,
        airfoil: { camber: 0, camberPos: 0.4, thickness: 0.04 },
        flap: { chordFrac: 0.4, deflection: 40 * deg },
      }),
      alpha: 20 * deg,
      cl: 2.2,
    },
    {
      name: 'thick cambered wing with winglets at -10 deg',
      wing: makeTestWing({
        span: 30,
        rootChord: 4,
        tipChord: 1.2,
        sweep: 35 * deg,
        airfoil: { camber: 0.09, camberPos: 0.4, thickness: 0.24 },
        winglet: { height: 2, taper: 0.4 },
      }),
      alpha: -10 * deg,
      cl: -0.4,
    },
  ];
  for (const { name, wing, alpha, cl } of configs) {
    it(`${name}: finite, ends downstream, never visibly inside the wing`, () => {
      const vInf = 60;
      const lattice = makeTestLattice(wing, alpha, { gamma: ellipticGamma(wing, vInf, cl) });
      const domain = tunnelDomain(wing.overallSpan, 4);
      const solid = new WingSolid(wing, alpha);
      const chord = wing.meanAeroChord;
      let worst = 0;
      for (const mode of ['vertical', 'horizontal', 'tip-vortex'] as const) {
        for (const eta of [0.05, 0.35, 0.8]) {
          const seeds = seedStreamlines(wing, alpha, { mode, eta, height: 0, count: 32 }, domain);
          const lines = traceStreamlines(lattice, vInf, seeds, domain, wing, alpha);
          expect(lines.length).toBe(32);
          for (const l of lines) {
            const p = l.points;
            const n = p.length / 3;
            for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i]!)).toBe(true);
            for (let i = 0; i < n; i++) {
              expect(Number.isFinite(l.speed[i]!)).toBe(true);
              expect(Number.isFinite(l.time[i]!)).toBe(true);
            }
            // Leaves through the outlet or a side wall, never stops mid-air.
            const x = p[3 * n - 3]!;
            const y = p[3 * n - 2]!;
            const z = p[3 * n - 1]!;
            const onWall =
              Math.abs(x - domain.max[0]) < 1e-3 ||
              Math.abs(Math.abs(y) - domain.max[1]) < 1e-3 ||
              Math.abs(z - domain.max[2]) < 1e-3 ||
              Math.abs(z - domain.min[2]) < 1e-3;
            expect(onWall).toBe(true);
            // Check the segments between points too (odd eighths of every step).
            for (let i = 1; i < n; i++) {
              for (let s = 1; s < 8; s += 2) {
                const f = s / 8;
                const sx = p[3 * i - 3]! + f * (p[3 * i]! - p[3 * i - 3]!);
                const sy = p[3 * i - 2]! + f * (p[3 * i + 1]! - p[3 * i - 2]!);
                const sz = p[3 * i - 1]! + f * (p[3 * i + 2]! - p[3 * i - 1]!);
                worst = Math.max(worst, depthInside(solid, sx, sy, sz, chord));
              }
            }
          }
        }
      }
      // Depth is measured along the section normal, so across a 40 deg flap it reads ~1.3x the
      // true depth. Clipping the last few tenths of a percent of a trailing edge (well under a
      // pixel when the whole wing is on screen) is accepted; crossing a skin is not.
      expect(worst).toBeLessThan(0.005);
    });
  }

  it('grid stays finite with a dihedral flapped wing at high alpha', () => {
    const { wing, alpha, vInf } = flappedDihedralWing();
    const lattice = makeTestLattice(wing, alpha, {
      gamma: ellipticGamma(wing, vInf, 2.4),
      coreRadius: 0.3,
    });
    const domain = tunnelDomain(wing.overallSpan, 6);
    const grid = buildFlowFieldGrid(lattice, vInf, wing, alpha, { domain, targetNodes: 30_000 }, 3);
    let maxSpeed = 0;
    for (let n = 0; n < grid.solid.length; n++) {
      const s = Math.hypot(
        grid.velocity[3 * n]!,
        grid.velocity[3 * n + 1]!,
        grid.velocity[3 * n + 2]!,
      );
      expect(Number.isFinite(s)).toBe(true);
      maxSpeed = Math.max(maxSpeed, s / vInf);
    }
    expect(maxSpeed).toBeLessThan(4);
  });

  it('a vertical rake covers a stubby, long-chord wing', () => {
    const wing = makeTestWing({ span: 4, rootChord: 12, tipChord: 6 });
    const alpha = 15 * deg;
    const domain = tunnelDomain(4, 12);
    const [set] = seedStreamlines(
      wing,
      alpha,
      { mode: 'vertical', eta: 0.3, height: 0, count: 16 },
      domain,
    );
    const zs = Array.from({ length: 16 }, (_, i) => set!.points[3 * i + 2]!);
    // The wing's trailing edge sits ~chord sin(alpha) below its leading edge.
    const extent = Math.max(...zs) - Math.min(...zs);
    expect(extent).toBeGreaterThan(10 * Math.sin(alpha));
  });
});

export type { Vec3 };
