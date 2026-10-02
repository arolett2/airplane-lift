import { describe, expect, it } from 'vitest';
import { buildThicknessSources, velocityAt } from './index';
import { ellipticGamma, makeTestLattice, makeTestWing, singleHorseshoe } from './testFixtures';

const deg = Math.PI / 180;

describe('velocityAt: single horseshoe sign conventions', () => {
  // Right-side horseshoe: bound vortex A -> B along +y, legs to the TE at x = 0.75, then to +x.
  const vInf = 10;
  const lat = singleHorseshoe([0, 0, 0], [0, 1, 0], [0.75, 0, 0], [0.75, 1, 0], 2);
  const v = new Float64Array(3);

  it('speeds the air up above the bound vortex and slows it below', () => {
    velocityAt(lat, vInf, 0, 0.5, 0.1, v);
    expect(v[0]).toBeGreaterThan(vInf);
    velocityAt(lat, vInf, 0, 0.5, -0.1, v);
    expect(v[0]).toBeLessThan(vInf);
  });

  it('pushes air down behind the wing and up outboard of the tips', () => {
    velocityAt(lat, vInf, 2, 0.5, 0, v);
    expect(v[2]).toBeLessThan(0);
    velocityAt(lat, vInf, 2, 1.3, 0, v);
    expect(v[2]).toBeGreaterThan(0);
    velocityAt(lat, vInf, 2, -0.3, 0, v);
    expect(v[2]).toBeGreaterThan(0);
  });

  it('matches the analytic downwash of a long horseshoe far behind it', () => {
    // Two semi-infinite... far downstream each trailing leg acts like an infinite line vortex:
    // w = -G/(2 pi) * (1/d1 + 1/d2) at the middle, here d1 = d2 = 0.5.
    velocityAt(lat, 0, 400, 0.5, 0, v);
    const expected = -(2 / (2 * Math.PI)) * (1 / 0.5 + 1 / 0.5);
    expect(v[2]).toBeCloseTo(expected, 3);
  });

  it('stays finite on the filaments thanks to the core', () => {
    for (const p of [
      [0, 0.5, 0],
      [0.75, 1, 0],
      [5, 0, 0],
      [0, 0, 0],
    ]) {
      velocityAt(lat, vInf, p[0]!, p[1]!, p[2]!, v);
      for (const c of v) expect(Number.isFinite(c)).toBe(true);
      expect(Math.hypot(v[0]! - vInf, v[1]!, v[2]!)).toBeLessThan(1e3);
    }
  });
});

describe('velocityAt: wing lattice', () => {
  const vInf = 60;
  const alpha = 6 * deg;
  const wing = makeTestWing({ span: 10, rootChord: 1.5, tipChord: 0.9, sweep: 10 * deg });
  const lattice = makeTestLattice(wing, alpha, { gamma: ellipticGamma(wing, vInf, 0.6) });
  const v = new Float64Array(3);

  it('recovers the freestream far away', () => {
    for (const p of [
      [-500, 0, 0],
      [0, 400, 30],
      [30, -20, 500],
    ]) {
      velocityAt(lattice, vInf, p[0]!, p[1]!, p[2]!, v);
      expect(Math.abs(v[0]! - vInf)).toBeLessThan(1e-3 * vInf);
      expect(Math.abs(v[1]!)).toBeLessThan(1e-3 * vInf);
      expect(Math.abs(v[2]!)).toBeLessThan(1e-3 * vInf);
    }
  });

  it('is mirror symmetric for a symmetric lattice', () => {
    const w = new Float64Array(3);
    const pts = [
      [0.3, 1.2, 0.2],
      [2.5, 4.9, -0.1],
      [-1, 3, 0.5],
      [6, 5.5, 0.05],
      [0.6, 0.4, -0.12],
    ];
    for (const p of pts) {
      velocityAt(lattice, vInf, p[0]!, p[1]!, p[2]!, v);
      velocityAt(lattice, vInf, p[0]!, -p[1]!, p[2]!, w);
      const tol = 1e-4 * vInf;
      expect(Math.abs(v[0]! - w[0]!)).toBeLessThan(tol);
      expect(Math.abs(v[1]! + w[1]!)).toBeLessThan(tol);
      expect(Math.abs(v[2]! - w[2]!)).toBeLessThan(tol);
    }
  });

  it('has downwash behind the midspan and upwash outboard of the tips', () => {
    velocityAt(lattice, vInf, 4, 0, -0.2, v);
    expect(v[2]).toBeLessThan(-0.01 * vInf);
    velocityAt(lattice, vInf, 4, 6, -0.2, v);
    expect(v[2]).toBeGreaterThan(0.005 * vInf);
    // Upwash ahead of the wing (bound vortex).
    velocityAt(lattice, vInf, -1.5, 2, 0.1, v);
    expect(v[2]).toBeGreaterThan(0);
  });

  it('accelerates the air over the top and slows it underneath', () => {
    velocityAt(lattice, vInf, 0.5, 2, 0.25, v);
    const top = v[0]!;
    velocityAt(lattice, vInf, 0.5, 2, -0.35, v);
    const bottom = v[0]!;
    expect(top).toBeGreaterThan(vInf);
    expect(bottom).toBeLessThan(vInf);
  });
});

describe('velocityAt: circulation', () => {
  it('line integral around the bound vortex at midspan of a long wing ~ gamma', () => {
    const chord = 1;
    const wing = makeTestWing({
      span: 60,
      rootChord: chord,
      airfoil: { camber: 0, camberPos: 0.4, thickness: 0.12 },
    });
    const G = 3;
    const lattice = makeTestLattice(wing, 0, {
      nSpanWing: 30,
      nChord: 4,
      gamma: () => G,
      coreRadius: 0.005,
    });
    // Thickness sources must not add circulation.
    lattice.sources = buildThicknessSources(wing, 0, 50);
    // Circle in the x-z plane at y = 0.3 (inside a strip), centred mid-chord, radius 0.8 chord.
    const cx = 0.5;
    const r = 0.8;
    const n = 2000;
    const v = new Float64Array(3);
    let circ = 0;
    for (let i = 0; i < n; i++) {
      const th = ((i + 0.5) / n) * 2 * Math.PI;
      const x = cx + r * Math.sin(th);
      const z = r * Math.cos(th);
      velocityAt(lattice, 50, x, 0.3, z, v);
      // dl for a loop going from +z towards +x (right-handed about +y).
      circ += (v[0]! * Math.cos(th) - v[2]! * Math.sin(th)) * r * ((2 * Math.PI) / n);
    }
    expect(circ / G).toBeCloseTo(1, 2);
  });
});

describe('buildThicknessSources', () => {
  const wing = makeTestWing({
    span: 40,
    rootChord: 1,
    airfoil: { camber: 0, camberPos: 0.4, thickness: 0.12 },
  });
  const vInf = 50;
  const sources = buildThicknessSources(wing, 0, vInf);

  it('makes a closed body (net source strength ~ 0)', () => {
    let net = 0;
    let pos = 0;
    for (let k = 0; k < sources.count; k++) {
      const len = Math.hypot(
        sources.p1[3 * k]! - sources.p0[3 * k]!,
        sources.p1[3 * k + 1]! - sources.p0[3 * k + 1]!,
        sources.p1[3 * k + 2]! - sources.p0[3 * k + 2]!,
      );
      net += sources.sigma[k]! * len;
      pos += Math.max(0, sources.sigma[k]!) * len;
    }
    expect(sources.count).toBeGreaterThan(100);
    expect(Math.abs(net)).toBeLessThan(1e-4 * pos);
  });

  it('displaces the flow around the thickness like thin-airfoil theory', () => {
    const lattice = makeTestLattice(wing, 0, { gamma: () => 0 });
    lattice.sources = sources;
    const v = new Float64Array(3);
    // Just above the surface at 30% chord (half-thickness 0.06): NACA 0012 peaks near 1.15-1.2.
    velocityAt(lattice, vInf, 0.3, 0.2, 0.065, v);
    expect(v[0]! / vInf).toBeGreaterThan(1.08);
    expect(v[0]! / vInf).toBeLessThan(1.3);
    // Flow is pushed up over the front half, down over the rear half.
    velocityAt(lattice, vInf, 0.1, 0.2, 0.1, v);
    expect(v[2]).toBeGreaterThan(0);
    velocityAt(lattice, vInf, 0.85, 0.2, 0.1, v);
    expect(v[2]).toBeLessThan(0);
    // Slower ahead of the nose.
    velocityAt(lattice, vInf, -0.05, 0.2, 0, v);
    expect(v[0]).toBeLessThan(vInf);
  });
});
