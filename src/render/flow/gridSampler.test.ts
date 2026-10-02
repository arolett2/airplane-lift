import { describe, expect, it } from 'vitest';
import { FlowSampler, SAMPLE_OK, SAMPLE_OUTSIDE, SAMPLE_SOLID } from './gridSampler';
import type { FlowFieldGrid } from '../../physics/types';
import { analyticVelocity, defaultAnalyticParams, makeAnalyticFlowGrid } from './fixtures';
import { tunnelDomain } from '../../physics/domain';

/** Grid filled from a function of position. */
function makeGrid(
  dims: [number, number, number],
  origin: [number, number, number],
  spacing: [number, number, number],
  f: (x: number, y: number, z: number) => [number, number, number],
  vInf = 10,
): FlowFieldGrid {
  const [nx, ny, nz] = dims;
  const velocity = new Float32Array(nx * ny * nz * 3);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v = f(
          origin[0] + i * spacing[0],
          origin[1] + j * spacing[1],
          origin[2] + k * spacing[2],
        );
        const idx = (i + nx * (j + ny * k)) * 3;
        velocity[idx] = v[0];
        velocity[idx + 1] = v[1];
        velocity[idx + 2] = v[2];
      }
  return {
    requestId: 1,
    origin,
    spacing,
    dims,
    velocity,
    solid: new Uint8Array(nx * ny * nz),
    vInf,
  };
}

describe('FlowSampler', () => {
  it('reproduces an affine field exactly (trilinear is exact for linear functions)', () => {
    const f = (x: number, y: number, z: number): [number, number, number] => [
      3 + 0.5 * x - 0.25 * y + 0.125 * z,
      -1 + 0.2 * x + 0.4 * y,
      2 - 0.3 * z + 0.1 * x,
    ];
    const grid = makeGrid([7, 6, 5], [-2, -3, -1], [0.7, 0.9, 1.1], f);
    const s = new FlowSampler();
    s.setGrid(grid);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let n = 0; n < 200; n++) {
      const x = -2 + rnd() * 6 * 0.7;
      const y = -3 + rnd() * 5 * 0.9;
      const z = -1 + rnd() * 4 * 1.1;
      expect(s.sample(x, y, z)).toBe(SAMPLE_OK);
      const e = f(x, y, z);
      expect(s.vx).toBeCloseTo(e[0], 4);
      expect(s.vy).toBeCloseTo(e[1], 4);
      expect(s.vz).toBeCloseTo(e[2], 4);
    }
  });

  it('returns exact node values at nodes, including the far corner', () => {
    const f = (x: number, y: number, z: number): [number, number, number] => [x * y, z, x + y + z];
    const grid = makeGrid([4, 4, 4], [0, 0, 0], [1, 1, 1], f);
    const s = new FlowSampler();
    s.setGrid(grid);
    expect(s.sample(3, 3, 3)).toBe(SAMPLE_OK);
    expect(s.vx).toBeCloseTo(9, 5);
    expect(s.vz).toBeCloseTo(9, 5);
    expect(s.sample(2, 1, 0)).toBe(SAMPLE_OK);
    expect(s.vx).toBeCloseTo(2, 5);
  });

  it('approximates a smooth analytic flow (cylinder + vortex) to within a few percent', () => {
    const p = defaultAnalyticParams(40);
    const domain = tunnelDomain(10, 1.5);
    const grid = makeAnalyticFlowGrid(domain, p, [80, 56, 40]);
    const s = new FlowSampler();
    s.setGrid(grid);
    const ref = [0, 0, 0];
    let worst = 0;
    let tested = 0;
    for (let n = 0; n < 500; n++) {
      // Sample away from the cylinder and the vortex core where the field has steep gradients.
      const x =
        domain.min[0] + 0.02 + ((n * 0.6180339) % 1) * (domain.max[0] - domain.min[0] - 0.04);
      const y =
        domain.min[1] + 0.02 + ((n * 0.7548776) % 1) * (domain.max[1] - domain.min[1] - 0.04);
      const z =
        domain.min[2] + 0.02 + ((n * 0.5698402) % 1) * (domain.max[2] - domain.min[2] - 0.04);
      if (Math.hypot(x, z) < 3 || Math.hypot(y - p.vortexY, z - p.vortexZ) < 1.5) continue;
      expect(s.sample(x, y, z)).toBe(SAMPLE_OK);
      analyticVelocity(p, x, y, z, ref);
      const err = Math.hypot(s.vx - ref[0]!, s.vy - ref[1]!, s.vz - ref[2]!) / p.vInf;
      worst = Math.max(worst, err);
      tested++;
    }
    expect(tested).toBeGreaterThan(100);
    expect(worst).toBeLessThan(0.03);
  });

  it('reports points outside the grid and writes the freestream', () => {
    const grid = makeGrid([3, 3, 3], [0, 0, 0], [1, 1, 1], () => [1, 2, 3], 17);
    const s = new FlowSampler();
    s.setGrid(grid);
    expect(s.sample(-0.01, 1, 1)).toBe(SAMPLE_OUTSIDE);
    expect(s.vx).toBe(17);
    expect(s.vy).toBe(0);
    expect(s.sample(1, 2.01, 1)).toBe(SAMPLE_OUTSIDE);
    expect(s.sample(1, 1, NaN)).toBe(SAMPLE_OUTSIDE);
    s.setGrid(null);
    expect(s.sample(1, 1, 1)).toBe(SAMPLE_OUTSIDE);
  });

  it('flags the nearest solid node and excludes solid corners from the blend', () => {
    const grid = makeGrid([3, 3, 3], [0, 0, 0], [1, 1, 1], () => [10, 0, 0]);
    const idxSolid = 1 + 3 * (1 + 3 * 1); // centre node
    grid.solid[idxSolid] = 1;
    // Junk velocity inside the body must not leak out.
    grid.velocity[idxSolid * 3] = 1e6;
    const s = new FlowSampler();
    s.setGrid(grid);
    expect(s.sample(1.1, 1.1, 1.1)).toBe(SAMPLE_SOLID);
    expect(s.sample(0.3, 0.3, 0.3)).toBe(SAMPLE_OK); // nearest node is fluid, the solid corner is dropped
    expect(s.vx).toBeCloseTo(10, 4);
  });

  it('handles single-layer axes without reading out of bounds', () => {
    const grid = makeGrid([4, 1, 3], [0, 5, 0], [1, 1, 1], (x) => [x, 0, 0]);
    const s = new FlowSampler();
    s.setGrid(grid);
    expect(s.sample(1.5, 5, 1)).toBe(SAMPLE_OK);
    expect(s.vx).toBeCloseTo(1.5, 5);
  });
});
