import { describe, expect, it } from 'vitest';
import type { AirfoilGeometry, Naca4Params, PanelSolution } from '../types';
import { camberLine, generateAirfoil } from './naca';
import { createPanelSolver, directVelocity } from './panel';

const DEG = Math.PI / 180;
const naca0012: Naca4Params = { camber: 0, camberPos: 0.4, thickness: 0.12 };
const naca2412: Naca4Params = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };

const solver0012 = createPanelSolver(generateAirfoil(naca0012, 140));
const solver2412 = createPanelSolver(generateAirfoil(naca2412, 140));

type Complex = [number, number];
const cmul = (p: Complex, q: Complex): Complex => [
  p[0] * q[0] - p[1] * q[1],
  p[0] * q[1] + p[1] * q[0],
];
const cdiv = (p: Complex, q: Complex): Complex => {
  const d = q[0] * q[0] + q[1] * q[1];
  return [(p[0] * q[0] + p[1] * q[1]) / d, (p[1] * q[0] - p[0] * q[1]) / d];
};
const cpow = (p: Complex, e: number): Complex => {
  const r = Math.hypot(p[0], p[1]) ** e;
  const th = e * Math.atan2(p[1], p[0]);
  return [r * Math.cos(th), r * Math.sin(th)];
};

/**
 * Karman-Trefftz airfoil: the conformal image of a circle (centre (-eps, mu), through zeta = 1)
 * under z = k [(zeta+1)^k + (zeta-1)^k] / [(zeta+1)^k - (zeta-1)^k], k = 2 - tau/pi, which has a
 * finite trailing-edge angle tau. Its potential flow is known exactly, so it validates the panel
 * method independently of any tabulated data. The contour is rotated and scaled to unit chord.
 */
function karmanTrefftz(eps: number, mu: number, tau: number, n: number) {
  const cx = -eps;
  const cy = mu;
  const a = Math.hypot(1 - cx, cy);
  const thetaTE = Math.atan2(-cy, 1 - cx);
  const k = 2 - tau / Math.PI;
  const circle = (th: number): Complex => [cx + a * Math.cos(th), cy + a * Math.sin(th)];
  const map = (z: Complex): Complex => {
    const p = cpow([z[0] + 1, z[1]], k);
    const m = cpow([z[0] - 1, z[1]], k);
    const r = cdiv([p[0] + m[0], p[1] + m[1]], [p[0] - m[0], p[1] - m[1]]);
    return [k * r[0], k * r[1]];
  };
  const mapDerivative = (z: Complex): number => {
    const p = cpow([z[0] + 1, z[1]], k);
    const m = cpow([z[0] - 1, z[1]], k);
    const d: Complex = [p[0] - m[0], p[1] - m[1]];
    const num = cmul(cpow([z[0] - 1, z[1]], k - 1), cpow([z[0] + 1, z[1]], k - 1));
    const r = cdiv(num, cmul(d, d));
    return 4 * k * k * Math.hypot(r[0], r[1]);
  };
  // Clockwise contour: from the TE (theta = thetaTE) with decreasing angle = lower surface first.
  const theta = (i: number) => thetaTE - (2 * Math.PI * i) / n;
  const raw: Complex[] = [];
  for (let i = 0; i <= n; i++) raw.push(i === 0 || i === n ? map([1, 0]) : map(circle(theta(i))));
  let le = 0;
  let chord = 0;
  for (let i = 0; i <= n; i++) {
    const d = Math.hypot(raw[i]![0] - raw[0]![0], raw[i]![1] - raw[0]![1]);
    if (d > chord) {
      chord = d;
      le = i;
    }
  }
  const [lx, ly] = raw[le]!;
  const rot = Math.atan2(raw[0]![1] - ly, raw[0]![0] - lx); // chord-line angle
  const coords = new Float64Array(2 * (n + 1));
  for (let i = 0; i <= n; i++) {
    const x = raw[i]![0] - lx;
    const y = raw[i]![1] - ly;
    coords[2 * i] = (x * Math.cos(rot) + y * Math.sin(rot)) / chord;
    coords[2 * i + 1] = (-x * Math.sin(rot) + y * Math.cos(rot)) / chord;
  }
  const geometry: AirfoilGeometry = {
    coords,
    nPoints: n + 1,
    leIndex: le,
    params: { camber: 0, camberPos: 0.4, thickness: 0.12 },
    flap: null,
  };
  // Kutta circulation in the circle plane (V_inf = 1; the map tends to identity far away).
  const circulation = (alpha: number) => 4 * Math.PI * a * Math.sin(alpha + rot - thetaTE);
  return {
    geometry,
    exactCl: (alpha: number) => (2 * circulation(alpha)) / chord,
    /** Exact Cp at contour node i (speeds are unchanged by the rotation and scaling). */
    exactCp(alpha: number, i: number) {
      const th = theta(i);
      const q = -2 * Math.sin(th - alpha - rot) - circulation(alpha) / (2 * Math.PI * a);
      return 1 - (q / mapDerivative(circle(th))) ** 2;
    },
  };
}

/** Lift from integrating the surface pressure (independent of the circulation). */
function pressureCl(coords: Float64Array, sol: PanelSolution): number {
  let fx = 0;
  let fy = 0;
  for (let i = 0; i < sol.cp.length; i++) {
    const dx = coords[2 * i + 2]! - coords[2 * i]!;
    const dy = coords[2 * i + 3]! - coords[2 * i + 1]!;
    fx += sol.cp[i]! * dy;
    fy -= sol.cp[i]! * dx;
  }
  return fy * Math.cos(sol.alpha) - fx * Math.sin(sol.alpha);
}

describe('linear-vortex panel method', () => {
  it('gives zero lift and symmetric Cp for NACA 0012 at alpha = 0', () => {
    const sol = solver0012.solve(0);
    expect(Math.abs(sol.cl)).toBeLessThan(1e-4);
    const n = sol.cp.length;
    for (let i = 0; i < n / 2; i++) expect(sol.cp[i]).toBeCloseTo(sol.cp[n - 1 - i]!, 6);
  });

  it('reproduces the exact Karman-Trefftz potential flow (lift and surface pressure)', () => {
    for (const [eps, mu, tauDeg] of [
      [0.1, 0.06, 10], // cambered, ~12% thick
      [0.08, 0, 12], // symmetric
    ] as const) {
      const kt = karmanTrefftz(eps, mu, tauDeg * DEG, 140);
      const solver = createPanelSolver(kt.geometry);
      for (const deg of [0, 4, 8]) {
        const sol = solver.solve(deg * DEG);
        const exact = kt.exactCl(deg * DEG);
        expect(Math.abs(sol.cl - exact)).toBeLessThan(2e-3 * Math.max(1, Math.abs(exact)));
        // Node Cp (mean of the two neighbouring control points) against the exact value.
        let sumSq = 0;
        let count = 0;
        for (let i = 3; i <= 137; i++) {
          const err = 0.5 * (sol.cp[i - 1]! + sol.cp[i]!) - kt.exactCp(deg * DEG, i);
          sumSq += err * err;
          count++;
          // Away from the leading-edge suction peak (where averaging two control points is
          // itself the main error) the agreement is tight.
          if (kt.geometry.coords[2 * i]! > 0.1) expect(Math.abs(err)).toBeLessThan(0.02);
        }
        expect(Math.sqrt(sumSq / count)).toBeLessThan(0.06);
      }
    }
  });

  it('matches the thin-airfoil pitching moment of NACA 2412', () => {
    // cm_c/4 = (pi/4)(A2 - A1), A_n = (2/pi) int (dz/dx) cos(n th) dth.
    let a1 = 0;
    let a2 = 0;
    const steps = 2000;
    for (let i = 0; i < steps; i++) {
      const th = ((i + 0.5) * Math.PI) / steps;
      const slope = camberLine(naca2412, null, 0.5 * (1 - Math.cos(th))).slope;
      a1 += (2 / steps) * slope * Math.cos(th);
      a2 += (2 / steps) * slope * Math.cos(2 * th);
    }
    const cmTheory = (Math.PI / 4) * (a2 - a1);
    expect(cmTheory).toBeCloseTo(-0.053, 3);
    const cm = solver2412.solve(solver2412.alphaZeroLift).cmQuarter;
    expect(Math.abs(cm / cmTheory - 1)).toBeLessThan(0.1);
  });

  it('matches the known NACA 0012 lift at 5 deg', () => {
    const cl = solver0012.solve(5 * DEG).cl;
    expect(cl).toBeGreaterThan(0.58);
    expect(cl).toBeLessThan(0.63);
  });

  it('has a lift slope within 3% of 2 pi (1 + 0.77 t)', () => {
    const h = 0.5 * DEG;
    const slope = (solver0012.solve(h).cl - solver0012.solve(-h).cl) / (2 * h);
    const ref = 2 * Math.PI * (1 + 0.77 * 0.12);
    expect(Math.abs(slope / ref - 1)).toBeLessThan(0.03);
    expect(solver0012.liftSlope / ref).toBeCloseTo(slope / ref, 3);
  });

  it('puts the NACA 2412 zero-lift angle near -2.1 deg', () => {
    expect(solver2412.alphaZeroLift / DEG).toBeGreaterThan(-2.1 - 0.35);
    expect(solver2412.alphaZeroLift / DEG).toBeLessThan(-2.1 + 0.35);
    expect(Math.abs(solver2412.solve(solver2412.alphaZeroLift).cl)).toBeLessThan(1e-9);
    expect(solver2412.clAt(0.1)).toBeCloseTo(solver2412.solve(0.1).cl, 12);
  });

  it('agrees with pressure integration', () => {
    for (const a of [2, 5, 10]) {
      const sol = solver2412.solve(a * DEG);
      expect(Math.abs(pressureCl(solver2412.geometry.coords, sol) / sol.cl - 1)).toBeLessThan(0.02);
    }
  });

  it('reaches Cp ~ 1 at the stagnation point, near the leading edge on the lower side', () => {
    const sol = solver0012.solve(5 * DEG);
    expect(Math.max(...sol.cp)).toBeGreaterThan(0.98);
    expect(Math.max(...sol.cp)).toBeLessThanOrEqual(1);
    const [sx, sy] = sol.stagnation;
    expect(sx).toBeGreaterThan(0);
    expect(sx).toBeLessThan(0.03);
    expect(sy).toBeLessThan(0);
    // Symmetric section at zero alpha: stagnation exactly at the nose.
    const s0 = solver0012.solve(0).stagnation;
    expect(s0[0]).toBeCloseTo(0, 3);
    expect(s0[1]).toBeCloseTo(0, 3);
  });

  it('gives a nose-down quarter-chord moment for positive camber', () => {
    const cm = solver2412.solve(2 * DEG).cmQuarter;
    expect(cm).toBeLessThan(-0.03);
    expect(cm).toBeGreaterThan(-0.09);
    expect(Math.abs(solver0012.solve(4 * DEG).cmQuarter)).toBeLessThan(0.02);
  });

  it('recovers the freestream far away and keeps the body interior at rest', () => {
    const sol = solver2412.solve(6 * DEG);
    const out: [number, number] = [0, 0];
    // Far away the body looks like a point vortex of circulation cl/2 in the freestream.
    const [x, y] = [-60, 40];
    const r2 = x * x + y * y;
    const gamma = sol.cl / 2;
    solver2412.velocityAt(sol, x, y, out);
    expect(out[0]).toBeCloseTo(Math.cos(6 * DEG) + (gamma * y) / (2 * Math.PI * r2), 4);
    expect(out[1]).toBeCloseTo(Math.sin(6 * DEG) - (gamma * (x - 0.25)) / (2 * Math.PI * r2), 4);
    solver2412.velocityAt(sol, -1e5, 2e5, out);
    expect(out[0]).toBeCloseTo(Math.cos(6 * DEG), 5);
    expect(out[1]).toBeCloseTo(Math.sin(6 * DEG), 5);
    solver2412.velocityAt(sol, 0.3, 0.02, out);
    expect(Math.hypot(out[0], out[1])).toBeLessThan(1e-3);
    // On a node and on the trailing edge: finite.
    const g = solver2412.geometry.coords;
    solver2412.velocityAt(sol, g[0]!, g[1]!, out);
    expect(Number.isFinite(out[0]) && Number.isFinite(out[1])).toBe(true);
    solver2412.velocityAt(sol, g[2 * 70]!, g[2 * 70 + 1]!, out);
    expect(Number.isFinite(out[0]) && Number.isFinite(out[1])).toBe(true);
  });

  it('has surface speed consistent with Cp just outside the surface', () => {
    const sol = solver2412.solve(4 * DEG);
    const g = solver2412.geometry.coords;
    const out: [number, number] = [0, 0];
    const n = sol.cp.length;
    for (let i = 5; i < n - 5; i += 7) {
      const tx = g[2 * i + 2]! - g[2 * i]!;
      const ty = g[2 * i + 3]! - g[2 * i + 1]!;
      const l = Math.hypot(tx, ty);
      // Outward normal of the clockwise contour.
      const x = sol.controlPoints[2 * i]! - (1e-4 * ty) / l;
      const y = sol.controlPoints[2 * i + 1]! + (1e-4 * tx) / l;
      solver2412.velocityAt(sol, x, y, out);
      const speed = Math.hypot(out[0], out[1]);
      expect(speed).toBeCloseTo(Math.sqrt(Math.max(0, 1 - sol.cp[i]!)), 2);
    }
  });

  it('accelerated field evaluation matches direct summation', () => {
    const sol = solver2412.solve(8 * DEG);
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    for (let k = 0; k < 200; k++) {
      const x = -0.6 + 2.4 * ((k * 0.618) % 1);
      const y = -0.6 + 1.2 * ((k * 0.414) % 1);
      solver2412.velocityAt(sol, x, y, a);
      directVelocity(solver2412.geometry, sol, x, y, b);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-5);
    }
  });

  it('converges as panels are added', () => {
    const cls = [40, 80, 160, 320].map(
      (n) => createPanelSolver(generateAirfoil(naca0012, n)).solve(5 * DEG).cl,
    );
    const d1 = Math.abs(cls[1]! - cls[0]!);
    const d2 = Math.abs(cls[2]! - cls[1]!);
    const d3 = Math.abs(cls[3]! - cls[2]!);
    expect(d2).toBeLessThan(d1);
    expect(d3).toBeLessThan(d2);
    expect(d3).toBeLessThan(2e-4);
  });

  it('prescribes circulation without flow through the surface', () => {
    const sol = solver2412.solveWithLift(10 * DEG, 0.5);
    expect(sol.cl).toBeCloseTo(0.5, 10);
    const g = solver2412.geometry.coords;
    const out: [number, number] = [0, 0];
    for (let i = 10; i < sol.cp.length - 10; i += 13) {
      const tx = g[2 * i + 2]! - g[2 * i]!;
      const ty = g[2 * i + 3]! - g[2 * i + 1]!;
      const l = Math.hypot(tx, ty);
      solver2412.velocityAt(sol, sol.controlPoints[2 * i]!, sol.controlPoints[2 * i + 1]!, out);
      // Normal component at the control point ~ 0 (normal = (-ty, tx)/l).
      expect(Math.abs((-out[0] * ty + out[1] * tx) / l)).toBeLessThan(1e-6);
    }
  });

  it('builds and solves fast enough for interactive use', () => {
    const geometry = generateAirfoil(naca2412, 140);
    const t0 = performance.now();
    const s = createPanelSolver(geometry);
    const build = performance.now() - t0;
    const t1 = performance.now();
    const reps = 200;
    for (let i = 0; i < reps; i++) s.solve((i % 20) * DEG);
    const solve = (performance.now() - t1) / reps;
    // eslint-disable-next-line no-console -- timing log requested for perf tracking
    console.info(`panel(140): build ${build.toFixed(2)} ms, solve ${solve.toFixed(4)} ms`);
    expect(build).toBeLessThan(60); // target < 20 ms; generous for CI noise
    expect(solve).toBeLessThan(1.5); // target < 0.5 ms
  });
});
