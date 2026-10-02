import { describe, expect, it } from 'vitest';
import type { Naca4Params, PanelSolution } from '../types';
import { generateAirfoil } from './naca';
import { createPanelSolver, directVelocity } from './panel';

const DEG = Math.PI / 180;
const naca0012: Naca4Params = { camber: 0, camberPos: 0.4, thickness: 0.12 };
const naca2412: Naca4Params = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };

const solver0012 = createPanelSolver(generateAirfoil(naca0012, 140));
const solver2412 = createPanelSolver(generateAirfoil(naca2412, 140));

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
