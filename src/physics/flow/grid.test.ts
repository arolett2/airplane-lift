import { describe, expect, it } from 'vitest';
import { tunnelDomain } from '../domain';
import { buildFlowFieldGrid, buildThicknessSources, sampleGrid, velocityAt } from './index';
import {
  addInducedExact,
  addInducedFast,
  addInducedLumped,
  distanceToWing,
  getCompiledLattice,
} from './lattice';
import { getWingSolid } from './solid';
import { ellipticGamma, makeTestLattice, makeTestWing } from './testFixtures';

const deg = Math.PI / 180;

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ~300 horseshoes: 2 x 25 strips x 6 chordwise, heavily loaded (CL 1.2) to stress the lumping.
const vInf = 60;
const alpha = 8 * deg;
const wing = makeTestWing({
  span: 10,
  rootChord: 1.8,
  tipChord: 0.9,
  sweep: 15 * deg,
  dihedral: 4 * deg,
});
const lattice = makeTestLattice(wing, alpha, {
  nSpanWing: 25,
  nChord: 6,
  gamma: ellipticGamma(wing, vInf, 1.2),
});
lattice.sources = buildThicknessSources(wing, alpha, vInf);
const domain = tunnelDomain(wing.overallSpan, 1.8);

describe('lumped far-field model', () => {
  const c = getCompiledLattice(lattice);
  const e = new Float64Array(3);
  const l = new Float64Array(3);
  const d = new Float64Array(2);

  it('differs from the exact model by < 3% of V_inf beyond 1.5 local chords', () => {
    const rand = rng(7);
    let tested = 0;
    let worst = 0;
    while (tested < 400) {
      const x = domain.min[0] + rand() * (domain.max[0] - domain.min[0]);
      const y = domain.min[1] + rand() * (domain.max[1] - domain.min[1]);
      // Concentrate samples in the interesting band around the wing.
      const z = (rand() - 0.5) * 6;
      distanceToWing(c, x, y, z, d);
      if (d[0]! < 1.5 * d[1]!) continue;
      tested++;
      e.fill(0);
      l.fill(0);
      addInducedExact(c, x, y, z, e);
      addInducedLumped(c, x, y, z, l);
      worst = Math.max(worst, Math.hypot(e[0]! - l[0]!, e[1]! - l[1]!, e[2]! - l[2]!) / vInf);
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('near/far evaluator stays close to exact everywhere outside the wing', () => {
    const rand = rng(11);
    const solid = getWingSolid(wing, alpha);
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      const x = -2 + rand() * 6;
      const y = -6 + rand() * 12;
      const z = -1.5 + rand() * 3;
      if (solid.contains(x, y, z)) continue;
      e.fill(0);
      l.fill(0);
      addInducedExact(c, x, y, z, e);
      addInducedFast(c, x, y, z, l);
      worst = Math.max(worst, Math.hypot(e[0]! - l[0]!, e[1]! - l[1]!, e[2]! - l[2]!) / vInf);
    }
    expect(worst).toBeLessThan(0.03);
  });
});

describe('buildFlowFieldGrid', () => {
  const t0 = performance.now();
  const grid = buildFlowFieldGrid(lattice, vInf, wing, alpha, { domain }, 42);
  const ms = performance.now() - t0;

  it('builds ~cubic cells with about the requested node count, within budget', () => {
    const [nx, ny, nz] = grid.dims;
    const nodes = nx * ny * nz;
    console.warn(
      `[perf] flow grid ${nx}x${ny}x${nz} = ${nodes} nodes, ${lattice.count} horseshoes, ` +
        `${lattice.sources.count} sources: ${ms.toFixed(0)} ms`,
    );
    expect(grid.requestId).toBe(42);
    expect(nodes).toBeGreaterThan(90_000);
    expect(nodes).toBeLessThan(160_000);
    const [sx, sy, sz] = grid.spacing;
    expect(Math.max(sx, sy, sz) / Math.min(sx, sy, sz)).toBeLessThan(1.2);
    expect(grid.velocity.length).toBe(3 * nodes);
    expect(grid.solid.length).toBe(nodes);
    // Budget is 600 ms in a worker; generous here for slow CI machines.
    expect(ms).toBeLessThan(4000);
  });

  it('marks solid nodes inside the wing with zero velocity', () => {
    let solidCount = 0;
    const solid = getWingSolid(wing, alpha);
    const [nx, ny] = grid.dims;
    for (let n = 0; n < grid.solid.length; n++) {
      if (!grid.solid[n]) continue;
      solidCount++;
      expect(grid.velocity[3 * n]).toBe(0);
      const i = n % nx;
      const j = Math.floor(n / nx) % ny;
      const k = Math.floor(n / (nx * ny));
      const x = grid.origin[0] + i * grid.spacing[0];
      const y = grid.origin[1] + j * grid.spacing[1];
      const z = grid.origin[2] + k * grid.spacing[2];
      expect(solid.contains(x, y, z)).toBe(true);
    }
    expect(solidCount).toBeGreaterThan(0);
  });

  it('samples nodes exactly and matches the exact field away from the wing', () => {
    const out = new Float64Array(3);
    const exact = new Float64Array(3);
    // At a node.
    const [nx, ny] = grid.dims;
    const n = 5 + nx * (7 + ny * 9);
    sampleGrid(
      grid,
      grid.origin[0] + 5 * grid.spacing[0],
      grid.origin[1] + 7 * grid.spacing[1],
      grid.origin[2] + 9 * grid.spacing[2],
      out,
    );
    expect(out[0]).toBeCloseTo(grid.velocity[3 * n]!, 4);
    // Between nodes, at least one chord from the wing and outside the wake band.
    const rand = rng(3);
    const c = getCompiledLattice(lattice);
    const d = new Float64Array(2);
    let tested = 0;
    let worst = 0;
    while (tested < 200) {
      const x = domain.min[0] + rand() * (domain.max[0] - domain.min[0]);
      const y = domain.min[1] + rand() * (domain.max[1] - domain.min[1]);
      const z = domain.min[2] + rand() * (domain.max[2] - domain.min[2]);
      distanceToWing(c, x, y, z, d);
      if (d[0]! < 1.0 * d[1]!) continue;
      if (x > 0 && Math.abs(z) < 1.2 && Math.abs(y) < 6) continue; // trailing sheet & tip vortices
      tested++;
      expect(sampleGrid(grid, x, y, z, out)).toBe(true);
      velocityAt(lattice, vInf, x, y, z, exact);
      worst = Math.max(
        worst,
        Math.hypot(out[0]! - exact[0]!, out[1]! - exact[1]!, out[2]! - exact[2]!) / vInf,
      );
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('returns freestream and false outside the grid', () => {
    const out = [0, 0, 0];
    expect(sampleGrid(grid, domain.max[0] + 1, 0, 0, out)).toBe(false);
    expect(out).toEqual([vInf, 0, 0]);
    expect(sampleGrid(grid, 0, 0, Number.NaN, out)).toBe(false);
    expect(sampleGrid(grid, domain.max[0], domain.max[1], domain.max[2], out)).toBe(true);
  });

  it('builds sources itself when the lattice has none, without mutating it', () => {
    const bare = makeTestLattice(wing, alpha, { gamma: ellipticGamma(wing, vInf, 0.5) });
    const small = buildFlowFieldGrid(bare, vInf, wing, alpha, { domain, targetNodes: 4000 }, 1);
    expect(bare.sources.count).toBe(0);
    expect(small.dims[0] * small.dims[1] * small.dims[2]).toBeGreaterThan(2500);
  });
});
