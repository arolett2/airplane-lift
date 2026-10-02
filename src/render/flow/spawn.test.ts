import { describe, expect, it } from 'vitest';
import { BAND_FRACTION, makeRng, makeSpawnRegion, spawnAnywhere, spawnOnInlet } from './spawn';
import { tunnelDomain } from '../../physics/domain';

describe('makeRng', () => {
  it('is deterministic and uniform-ish in [0, 1)', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    let sum = 0;
    for (let i = 0; i < 5000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 5000).toBeCloseTo(0.5, 1);
  });
});

describe('spawn region', () => {
  const span = 20;
  const domain = tunnelDomain(span, 2);
  const semispan = span / 2;
  const region = makeSpawnRegion(domain, semispan);

  it('sizes the wing band from the semispan', () => {
    expect(region.bandHalfY).toBeCloseTo(1.15 * semispan, 9);
    expect(region.bandHalfZ).toBeCloseTo(0.2 * semispan, 9);
  });

  it('puts inlet respawns on the inlet plane, inside the domain', () => {
    const rng = makeRng(1);
    const out = new Float32Array(3);
    for (let i = 0; i < 5000; i++) {
      spawnOnInlet(region, rng, 0.5, out, 0);
      expect(out[0]!).toBeGreaterThanOrEqual(domain.min[0]);
      expect(out[0]!).toBeLessThanOrEqual(
        domain.min[0] + 0.5 + 1e-3 * (domain.max[0] - domain.min[0]),
      );
      expect(out[1]!).toBeGreaterThanOrEqual(domain.min[1]);
      expect(out[1]!).toBeLessThanOrEqual(domain.max[1]);
      expect(out[2]!).toBeGreaterThanOrEqual(domain.min[2]);
      expect(out[2]!).toBeLessThanOrEqual(domain.max[2]);
    }
  });

  it('concentrates about 60% of spawns in the band around the wing', () => {
    const rng = makeRng(99);
    const out = new Float32Array(3);
    const n = 20000;
    let inBand = 0;
    for (let i = 0; i < n; i++) {
      spawnOnInlet(region, rng, 0, out, 0);
      if (Math.abs(out[1]!) < region.bandHalfY && Math.abs(out[2]!) < region.bandHalfZ) inBand++;
    }
    const frac = inBand / n;
    // 60% by design plus the share of the uniform remainder that lands in the band by chance.
    const bandArea =
      (2 * region.bandHalfY * 2 * region.bandHalfZ) /
      ((region.max[1] - region.min[1]) * (region.max[2] - region.min[2]));
    const expected = BAND_FRACTION + (1 - BAND_FRACTION) * bandArea;
    expect(frac).toBeGreaterThan(0.58);
    expect(frac).toBeCloseTo(expected, 1);
  });

  it('spreads the remainder across the whole section', () => {
    const rng = makeRng(5);
    const out = new Float32Array(3);
    let farY = 0;
    let farZ = 0;
    for (let i = 0; i < 5000; i++) {
      spawnOnInlet(region, rng, 0, out, 0);
      if (Math.abs(out[1]!) > region.bandHalfY) farY++;
      if (Math.abs(out[2]!) > region.bandHalfZ) farZ++;
    }
    expect(farY).toBeGreaterThan(100);
    expect(farZ).toBeGreaterThan(1000);
  });

  it('staggers initial positions through the whole tunnel length', () => {
    const rng = makeRng(3);
    const out = new Float32Array(3);
    const bins = new Array(10).fill(0) as number[];
    const lx = domain.max[0] - domain.min[0];
    for (let i = 0; i < 5000; i++) {
      spawnAnywhere(region, rng, out, 0);
      expect(out[0]!).toBeGreaterThan(domain.min[0]);
      expect(out[0]!).toBeLessThan(domain.max[0]);
      bins[Math.min(9, Math.floor(((out[0]! - domain.min[0]) / lx) * 10))]!++;
    }
    for (const b of bins) expect(b).toBeGreaterThan(350);
  });

  it('clamps the band into small or off-centre domains', () => {
    const tiny = makeSpawnRegion({ min: [0, -1, -0.2], max: [5, 1, 0.2] }, 50, 10);
    expect(tiny.bandHalfY).toBeLessThanOrEqual(1);
    expect(tiny.bandHalfZ).toBeLessThanOrEqual(0.2);
    expect(tiny.bandCenterZ + tiny.bandHalfZ).toBeLessThanOrEqual(0.2);
  });
});
