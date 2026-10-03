import { describe, expect, it } from 'vitest';
import { BASE_PARTICLES, MAX_PARTICLES, ParticleSim, particleCountFor } from './particleSim';
import { defaultAnalyticParams, makeAnalyticFlowGrid } from './fixtures';
import { makeSpawnRegion } from './spawn';
import { tunnelDomain } from '../../physics/domain';
import type { FlowFieldGrid } from '../../physics/types';

const span = 10;
const domain = tunnelDomain(span, 1.5);

function uniformGrid(vInf: number, solidSlab = false): FlowFieldGrid {
  const dims: [number, number, number] = [40, 20, 16];
  const origin = [...domain.min] as [number, number, number];
  const spacing: [number, number, number] = [
    (domain.max[0] - domain.min[0]) / (dims[0] - 1),
    (domain.max[1] - domain.min[1]) / (dims[1] - 1),
    (domain.max[2] - domain.min[2]) / (dims[2] - 1),
  ];
  const n = dims[0] * dims[1] * dims[2];
  const velocity = new Float32Array(n * 3);
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) velocity[i * 3] = vInf;
  if (solidSlab) {
    // A wall of solid nodes across the whole section at i == 20.
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++) solid[20 + dims[0] * (j + dims[1] * k)] = 1;
  }
  return { requestId: 1, origin, spacing, dims, velocity, solid, vInf };
}

function makeSim(grid: FlowFieldGrid, count = 3000): ParticleSim {
  const sim = new ParticleSim(5000, 42);
  sim.setSpawnRegion(makeSpawnRegion(domain, span / 2));
  sim.setField(grid);
  sim.setCount(count);
  return sim;
}

describe('particle budget', () => {
  it('is ~14000 * density, capped at 30000', () => {
    expect(particleCountFor(1)).toBe(BASE_PARTICLES);
    expect(particleCountFor(0.25)).toBe(3500);
    expect(particleCountFor(2)).toBe(28000);
    expect(particleCountFor(2.5)).toBe(MAX_PARTICLES);
    expect(particleCountFor(10)).toBe(MAX_PARTICLES);
    expect(particleCountFor(0)).toBe(0);
  });
});

describe('ParticleSim', () => {
  it('starts with particles staggered through the whole tunnel, all inside the domain', () => {
    const sim = makeSim(uniformGrid(30));
    const lx = domain.max[0] - domain.min[0];
    let late = 0;
    for (let i = 0; i < sim.count; i++) {
      const [x, y, z] = [sim.pos[i * 3]!, sim.pos[i * 3 + 1]!, sim.pos[i * 3 + 2]!];
      expect(x).toBeGreaterThan(domain.min[0]);
      expect(x).toBeLessThan(domain.max[0]);
      expect(y).toBeGreaterThanOrEqual(domain.min[1]);
      expect(y).toBeLessThanOrEqual(domain.max[1]);
      expect(z).toBeGreaterThanOrEqual(domain.min[2]);
      expect(z).toBeLessThanOrEqual(domain.max[2]);
      if (x > domain.min[0] + 0.5 * lx) late++;
    }
    expect(late / sim.count).toBeGreaterThan(0.4);
    expect(late / sim.count).toBeLessThan(0.6);
  });

  it('advects with the local velocity (uniform stream)', () => {
    const vInf = 30;
    const sim = makeSim(uniformGrid(vInf), 500);
    const before = Float32Array.from(sim.pos.subarray(0, 1500));
    const dt = 0.005;
    sim.update(dt);
    let moved = 0;
    for (let i = 0; i < sim.count; i++) {
      const dx = sim.pos[i * 3]! - before[i * 3]!;
      if (dx > 0) {
        // Not respawned: displacement is exactly vInf * dt, no lateral drift.
        expect(dx).toBeCloseTo(vInf * dt, 3);
        expect(sim.pos[i * 3 + 1]!).toBeCloseTo(before[i * 3 + 1]!, 5);
        expect(sim.pos[i * 3 + 2]!).toBeCloseTo(before[i * 3 + 2]!, 5);
        moved++;
      }
    }
    expect(moved).toBeGreaterThan(450);
  });

  it('integrates rotation accurately with the midpoint scheme (solid-body vortex)', () => {
    // u = -omega * y', v = omega * x' about the y-z plane origin... use x-z plane rotation about (0, *, 0).
    const omega = 2;
    const dims: [number, number, number] = [21, 21, 21];
    const lo = -5;
    const h = 0.5;
    const n = dims[0] * dims[1] * dims[2];
    const velocity = new Float32Array(n * 3);
    for (let k = 0; k < 21; k++)
      for (let j = 0; j < 21; j++)
        for (let i = 0; i < 21; i++) {
          const idx = (i + 21 * (j + 21 * k)) * 3;
          const x = lo + i * h;
          const z = lo + k * h;
          velocity[idx] = -omega * z; // linear => trilinear is exact
          velocity[idx + 2] = omega * x;
        }
    const grid: FlowFieldGrid = {
      requestId: 1,
      origin: [lo, lo, lo],
      spacing: [h, h, h],
      dims,
      velocity,
      solid: new Uint8Array(n),
      vInf: 2,
    };
    const sim = new ParticleSim(10, 1);
    sim.setSpawnRegion(makeSpawnRegion({ min: [-5, -5, -5], max: [5, 5, 5] }, 3));
    sim.setField(grid);
    sim.setCount(1);
    sim.pos[0] = 3;
    sim.pos[1] = 0;
    sim.pos[2] = 0;
    sim.age[0] = 0;
    sim.maxAge[0] = 1e9;
    const dt = 0.01;
    const steps = 150; // 1.5 s => angle = 3 rad
    for (let s = 0; s < steps; s++) {
      sim.age[0] = 0; // keep it alive
      sim.update(dt);
    }
    const angle = omega * dt * steps;
    expect(sim.pos[0]!).toBeCloseTo(3 * Math.cos(angle), 2);
    expect(sim.pos[2]!).toBeCloseTo(3 * Math.sin(angle), 2);
    expect(Math.hypot(sim.pos[0]!, sim.pos[2]!)).toBeCloseTo(3, 2);
  });

  it('respawns particles that leave the domain on the inlet plane', () => {
    const vInf = 40;
    const sim = makeSim(uniformGrid(vInf), 800);
    const lx = domain.max[0] - domain.min[0];
    // Run for more than one transit so everything has wrapped at least once.
    const dt = 0.01;
    for (let s = 0; s < Math.ceil((1.3 * lx) / vInf / dt); s++) sim.update(dt);
    for (let i = 0; i < sim.count; i++) {
      const x = sim.pos[i * 3]!;
      const y = sim.pos[i * 3 + 1]!;
      const z = sim.pos[i * 3 + 2]!;
      expect(x).toBeGreaterThanOrEqual(domain.min[0]);
      expect(x).toBeLessThanOrEqual(domain.max[0]);
      expect(y).toBeGreaterThanOrEqual(domain.min[1]);
      expect(y).toBeLessThanOrEqual(domain.max[1]);
      expect(z).toBeGreaterThanOrEqual(domain.min[2]);
      expect(z).toBeLessThanOrEqual(domain.max[2]);
    }
    // The tunnel is still populated all the way along (no gaps from respawn bunching).
    const bins = new Array(5).fill(0) as number[];
    for (let i = 0; i < sim.count; i++) {
      bins[Math.min(4, Math.floor(((sim.pos[i * 3]! - domain.min[0]) / lx) * 5))]!++;
    }
    for (const b of bins) expect(b).toBeGreaterThan(sim.count * 0.1);
  });

  it('respawns particles that enter a solid node instead of letting them pass through', () => {
    const sim = makeSim(uniformGrid(30, true), 800);
    const wallX = domain.min[0] + 20 * ((domain.max[0] - domain.min[0]) / 39);
    const dt = 0.01;
    let crossed = 0;
    for (let s = 0; s < 120; s++) {
      const before = Float32Array.from(sim.pos.subarray(0, sim.count * 3));
      sim.update(dt);
      for (let i = 0; i < sim.count; i++) {
        // A particle that moved from upstream of the wall to downstream of it jumped through.
        if (before[i * 3]! < wallX - 1 && sim.pos[i * 3]! > wallX + 1) crossed++;
      }
    }
    expect(crossed).toBe(0);
  });

  it('respawns old particles', () => {
    const sim = makeSim(uniformGrid(30), 100);
    const dt = 0.001;
    for (let i = 0; i < sim.count; i++) {
      sim.age[i] = sim.maxAge[i]! + 1;
    }
    sim.update(dt);
    for (let i = 0; i < sim.count; i++) {
      expect(sim.age[i]!).toBe(0);
      expect(sim.pos[i * 3]!).toBeLessThan(domain.min[0] + 0.1 * (domain.max[0] - domain.min[0]));
    }
  });

  it('keeps colours, alphas and tails finite and in range over the analytic wing flow', () => {
    const p = defaultAnalyticParams(40);
    const grid = makeAnalyticFlowGrid(domain, p, [60, 40, 30]);
    const sim = makeSim(grid, 2000);
    sim.setColorMode('speed');
    for (let s = 0; s < 60; s++) sim.update(0.004);
    for (let i = 0; i < sim.count; i++) {
      expect(sim.alpha[i]!).toBeGreaterThanOrEqual(0);
      expect(sim.alpha[i]!).toBeLessThanOrEqual(1);
      for (let c = 0; c < 3; c++) {
        expect(Number.isFinite(sim.pos[i * 3 + c]!)).toBe(true);
        expect(Number.isFinite(sim.tail[i * 3 + c]!)).toBe(true);
        expect(sim.color[i * 3 + c]!).toBeGreaterThanOrEqual(0);
        expect(sim.color[i * 3 + c]!).toBeLessThanOrEqual(1);
      }
    }
  });

  it('trails lag behind the head along the flow and vanish when paused', () => {
    const sim = makeSim(uniformGrid(30), 200);
    for (let s = 0; s < 100; s++) sim.update(0.004);
    let lagging = 0;
    for (let i = 0; i < sim.count; i++) {
      if (sim.pos[i * 3]! - sim.tail[i * 3]! > 0.05) lagging++;
    }
    expect(lagging).toBeGreaterThan(150);
    const snapshot = Float32Array.from(sim.pos.subarray(0, sim.count * 3));
    sim.update(0); // paused: nothing moves
    for (let i = 0; i < sim.count * 3; i++) expect(sim.pos[i]!).toBe(snapshot[i]!);
  });

  it('is inactive without a field', () => {
    const sim = new ParticleSim(100, 1);
    sim.setCount(50);
    sim.update(0.01); // must not throw
    expect(sim.active).toBe(false);
    sim.setField(uniformGrid(10));
    expect(sim.active).toBe(true);
    sim.setField(null);
    expect(sim.active).toBe(false);
  });

  it('adding particles scatters only the new ones', () => {
    const sim = makeSim(uniformGrid(30), 100);
    const first = Float32Array.from(sim.pos.subarray(0, 300));
    sim.setCount(400);
    for (let i = 0; i < 300; i++) expect(sim.pos[i]!).toBe(first[i]!);
    expect(sim.count).toBe(400);
    let spread = 0;
    for (let i = 100; i < 400; i++) if (sim.pos[i * 3]! > domain.min[0] + 3) spread++;
    expect(spread).toBeGreaterThan(200);
  });

  it('carries particles through regions the grid does not cover with the freestream', () => {
    // Grid covers only the front half of the tunnel; the spawn region covers all of it.
    const grid = uniformGrid(30);
    grid.dims = [20, 20, 16];
    grid.velocity = grid.velocity.subarray(0, 20 * 20 * 16 * 3);
    grid.solid = grid.solid.subarray(0, 20 * 20 * 16);
    const sim = makeSim(grid, 400);
    const before = Float32Array.from(sim.pos.subarray(0, 1200));
    sim.update(0.004);
    let moved = 0;
    for (let i = 0; i < sim.count; i++) {
      const dx = sim.pos[i * 3]! - before[i * 3]!;
      if (dx > 0) {
        expect(dx).toBeCloseTo(30 * 0.004, 3);
        moved++;
      }
    }
    expect(moved).toBeGreaterThan(380);
  });

  it('keeps particles when the spawn region changes slightly, re-places them when it changes a lot', () => {
    const sim = makeSim(uniformGrid(30), 300);
    const before = Float32Array.from(sim.pos.subarray(0, 900));
    sim.setSpawnRegion(makeSpawnRegion(tunnelDomain(span * 1.05, 1.5), (span * 1.05) / 2));
    for (let i = 0; i < 900; i++) expect(sim.pos[i]!).toBe(before[i]!);
    sim.setSpawnRegion(makeSpawnRegion(tunnelDomain(span * 3, 1.5), (span * 3) / 2));
    let same = 0;
    for (let i = 0; i < 900; i++) if (sim.pos[i]! === before[i]!) same++;
    expect(same).toBeLessThan(50);
  });

  it('derives a spawn region from the grid when none was given', () => {
    const sim = new ParticleSim(500, 3);
    sim.setField(uniformGrid(30));
    sim.setCount(200);
    expect(sim.spawnRegion).not.toBeNull();
    sim.update(0.002);
    for (let i = 0; i < sim.count; i++) {
      expect(sim.pos[i * 3]!).toBeGreaterThanOrEqual(domain.min[0]);
      expect(sim.pos[i * 3]!).toBeLessThanOrEqual(domain.max[0]);
    }
  });
});
