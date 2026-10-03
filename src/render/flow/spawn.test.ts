import { describe, expect, it } from 'vitest';
import {
  BAND_FRACTION,
  KIND_AMBIENT,
  KIND_SHEET,
  KIND_TIP,
  SHEET_FRACTION,
  TIP_FRACTION,
  makeRng,
  makeSmokeSources,
  makeSpawnRegion,
  spawnAnywhere,
  spawnOnInlet,
} from './spawn';
import { tunnelDomain } from '../../physics/domain';
import { makeTestWing } from '../util/testFixtures';

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

describe('smoke sources round a wing', () => {
  const geo = makeTestWing({ semispan: 10, rootChord: 2, tipChord: 1, sweepDeg: 20 });
  const domain = tunnelDomain(20, 2);
  const smoke = makeSmokeSources(geo, 0)!;
  const region = makeSpawnRegion(domain, 10, 0, undefined, smoke);

  it('releases mostly a thin sheet at wing height, plus tip disks and a little dust', () => {
    const rng = makeRng(11);
    const out = new Float32Array(3);
    const counts = [0, 0, 0];
    let sheetNearWing = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const kind = spawnOnInlet(region, rng, 0, out, 0);
      counts[kind]!++;
      if (kind === KIND_SHEET) {
        expect(Math.abs(out[1]!)).toBeLessThanOrEqual(smoke.halfSpan + 1e-6);
        // Within the sheet thickness of the wing (whose LE is at z = 0 here).
        if (Math.abs(out[2]!) < 0.7) sheetNearWing++;
      }
    }
    expect(counts[KIND_SHEET]! / n).toBeCloseTo(SHEET_FRACTION, 1);
    expect(counts[KIND_TIP]! / n).toBeCloseTo(TIP_FRACTION, 1);
    expect(counts[KIND_AMBIENT]! / n).toBeLessThan(0.15);
    expect(sheetNearWing / counts[KIND_SHEET]!).toBeGreaterThan(0.95);
  });

  it('puts the tip disks round both tips', () => {
    expect(smoke.tips[0]!).toBeGreaterThan(8);
    expect(smoke.tips[3]!).toBeLessThan(-8);
    expect(smoke.tips[2]!).toBeGreaterThan(0);
  });

  it('follows the leading edge down as the wing pitches nose-up behind the pivot', () => {
    const pitched = makeSmokeSources(geo, (10 * Math.PI) / 180)!;
    // Swept wing: the outer leading edge is behind the pivot, so nose-up pitch lowers it.
    expect(pitched.z[0]!).toBeLessThan(smoke.z[0]!);
  });

  it('is null without a usable right wing', () => {
    expect(makeSmokeSources({ ...geo, surfaces: [] }, 0)).toBeNull();
  });
});
