import { describe, expect, it } from 'vitest';
import type { Streamline3D } from '../types';
import type { RakeConfig } from '../../state/params';
import { tunnelDomain } from '../domain';
import { buildThicknessSources, seedStreamlines, traceStreamlines } from './index';
import { getWingSolid } from './solid';
import { wingStationAt } from './streamlines';
import { ellipticGamma, makeTestLattice, makeTestWing } from './testFixtures';

const deg = Math.PI / 180;
const vInf = 60;
const alpha = 6 * deg;
const wing = makeTestWing({
  span: 10,
  rootChord: 1.6,
  tipChord: 0.8,
  sweep: 12 * deg,
  dihedral: 4 * deg,
});
const S = 5;
const lattice = makeTestLattice(wing, alpha, {
  nSpanWing: 25,
  nChord: 6,
  gamma: ellipticGamma(wing, vInf, 0.7),
});
lattice.sources = buildThicknessSources(wing, alpha, vInf);
const domain = tunnelDomain(wing.overallSpan, 1.6);
const solid = getWingSolid(wing, alpha);

const rake = (mode: RakeConfig['mode'], count = 24, eta = 0.35, height = 0): RakeConfig => ({
  mode,
  eta,
  height,
  count,
});

/** Value of `time` (or any per-point series) where the line first crosses x = x0. */
function atX(line: Streamline3D, x0: number, series: Float32Array, stride = 1, comp = 0): number {
  const p = line.points;
  for (let i = 1; i < p.length / 3; i++) {
    const xa = p[3 * (i - 1)]!;
    const xb = p[3 * i]!;
    if (xa <= x0 && xb >= x0) {
      const t = xb > xa ? (x0 - xa) / (xb - xa) : 0;
      const a = series[stride * (i - 1) + comp]!;
      const b = series[stride * i + comp]!;
      return a + t * (b - a);
    }
  }
  return Number.NaN;
}

describe('seedStreamlines', () => {
  const inletX = domain.min[0];

  it('places a vertical rake at the chosen span station, denser near the wing', () => {
    const [set] = seedStreamlines(wing, alpha, rake('vertical', 24, 0.35), domain);
    expect(set!.group).toBe('rake');
    const p = set!.points;
    expect(p.length).toBe(3 * 24);
    const zs: number[] = [];
    for (let i = 0; i < 24; i++) {
      expect(p[3 * i]! - inletX).toBeGreaterThan(0);
      expect(p[3 * i]! - inletX).toBeLessThan(0.02 * (domain.max[0] - domain.min[0]));
      expect(p[3 * i + 1]).toBeCloseTo(0.35 * S, 5);
      zs.push(p[3 * i + 2]!);
    }
    const zWing = wingStationAt(wing, alpha, 0.35 * S).le[2];
    expect(Math.max(...zs) - zWing).toBeLessThan(0.27 * S);
    expect(zWing - Math.min(...zs)).toBeLessThan(0.27 * S);
    zs.sort((a, b) => a - b);
    const gapMid = zs[12]! - zs[11]!;
    const gapEdge = zs[23]! - zs[22]!;
    expect(gapMid).toBeLessThan(0.25 * gapEdge);
  });

  it('follows the rake height', () => {
    const lo = seedStreamlines(wing, alpha, rake('vertical', 9, 0, -0.2), domain)[0]!.points;
    const hi = seedStreamlines(wing, alpha, rake('vertical', 9, 0, 0.2), domain)[0]!.points;
    expect(hi[3 * 4 + 2]! - lo[3 * 4 + 2]!).toBeCloseTo(0.4 * S, 5);
  });

  it('spreads a horizontal sheet across the span just above the wing', () => {
    const [set] = seedStreamlines(wing, alpha, rake('horizontal', 30), domain);
    expect(set!.group).toBe('sheet');
    const p = set!.points;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 30; i++) {
      const y = p[3 * i + 1]!;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      expect(Math.abs(y)).toBeLessThanOrEqual(1.15 * S + 1e-6);
      const zWing = wingStationAt(wing, alpha, Math.max(-S, Math.min(S, y))).le[2];
      expect(p[3 * i + 2]!).toBeGreaterThan(zWing);
    }
    expect(maxY).toBeGreaterThan(S);
    expect(minY).toBeLessThan(-S);
  });

  it('rings both wingtips for the tip-vortex mode', () => {
    const [set] = seedStreamlines(wing, alpha, rake('tip-vortex', 32), domain);
    expect(set!.group).toBe('tip-vortex');
    const p = set!.points;
    expect(p.length / 3).toBe(32);
    let right = 0;
    let left = 0;
    for (let i = 0; i < p.length / 3; i++) {
      const y = p[3 * i + 1]!;
      expect(Math.abs(Math.abs(y) - S)).toBeLessThan(0.2 * S);
      if (y > 0) right++;
      else left++;
    }
    expect(right).toBe(16);
    expect(left).toBe(16);
  });
});

describe('traceStreamlines', () => {
  const seeds = seedStreamlines(wing, alpha, rake('vertical', 32, 0.35), domain);
  traceStreamlines(lattice, vInf, seeds, domain, wing, alpha); // warm up the JIT
  const t0 = performance.now();
  const lines = traceStreamlines(lattice, vInf, seeds, domain, wing, alpha);
  const ms = performance.now() - t0;

  it('traces 32 lines within budget', () => {
    let pts = 0;
    for (const l of lines) pts += l.points.length / 3;
    console.warn(`[perf] 32 streamlines, ${pts} points: ${ms.toFixed(0)} ms`);
    expect(lines.length).toBe(32);
    // Budget is 150 ms in a worker; generous here for slow CI machines.
    expect(ms).toBeLessThan(1500);
  });

  it('ends every line downstream at the outlet', () => {
    for (const l of lines) {
      const n = l.points.length / 3;
      expect(n).toBeLessThanOrEqual(1500);
      expect(l.points[3 * (n - 1)]).toBeCloseTo(domain.max[0], 3);
      expect(l.group).toBe('rake');
    }
  });

  it('never enters the wing (points or segment midpoints)', () => {
    for (const l of lines) {
      const p = l.points;
      for (let i = 0; i < p.length / 3; i++) {
        expect(solid.contains(p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!)).toBe(false);
        if (i > 0) {
          const mx = 0.5 * (p[3 * i]! + p[3 * i - 3]!);
          const my = 0.5 * (p[3 * i + 1]! + p[3 * i - 2]!);
          const mz = 0.5 * (p[3 * i + 2]! + p[3 * i - 1]!);
          expect(solid.contains(mx, my, mz)).toBe(false);
        }
      }
    }
  });

  it('records increasing time and sensible speeds', () => {
    for (const l of lines) {
      expect(l.time[0]).toBe(0);
      for (let i = 1; i < l.time.length; i++) expect(l.time[i]!).toBeGreaterThan(l.time[i - 1]!);
      for (const s of l.speed) {
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThan(3);
      }
      // Crossing the tunnel takes about length / V_inf.
      const total = l.time[l.time.length - 1]!;
      const ideal = (domain.max[0] - domain.min[0]) / vInf;
      expect(total).toBeGreaterThan(0.8 * ideal);
      expect(total).toBeLessThan(1.6 * ideal);
    }
  });

  it('air over the top is faster and reaches the trailing edge first', () => {
    const st = wingStationAt(wing, alpha, 0.35 * S);
    const xTe = st.le[0] + st.chord * Math.cos(alpha) + 0.02;
    const xMid = st.le[0] + 0.3 * st.chord;
    // Classify lines by which side of the wing they pass at 30% chord.
    let upper: Streamline3D | null = null;
    let lower: Streamline3D | null = null;
    let zu = Infinity;
    let zl = -Infinity;
    const zWing = st.le[2] - 0.3 * st.chord * Math.sin(alpha);
    for (const l of lines) {
      const z = atX(l, xMid, l.points, 3, 2);
      if (z > zWing && z < zu) {
        zu = z;
        upper = l;
      }
      if (z < zWing && z > zl) {
        zl = z;
        lower = l;
      }
    }
    expect(upper && lower).toBeTruthy();
    expect(atX(upper!, xMid, upper!.speed)).toBeGreaterThan(1.1);
    expect(atX(lower!, xMid, lower!.speed)).toBeLessThan(1.02);
    // No "equal transit time": the upper parcel arrives at the trailing edge first.
    expect(atX(upper!, xTe, upper!.time)).toBeLessThan(atX(lower!, xTe, lower!.time));
  });

  it('winds tip-vortex lines around the trailing tip vortex', () => {
    const tipSeeds = seedStreamlines(wing, alpha, rake('tip-vortex', 24), domain);
    const tipLines = traceStreamlines(lattice, vInf, tipSeeds, domain, wing, alpha);
    expect(tipLines.length).toBe(24);
    // Axis of the right tip vortex: from the tip trailing edge straight downstream.
    const tip = wingStationAt(wing, alpha, S);
    const yc = S;
    const zc = tip.le[2] - tip.chord * Math.sin(alpha);
    const xStart = tip.le[0] + tip.chord;
    let best = 0;
    for (const l of tipLines) {
      const p = l.points;
      if (p[1]! < 0) continue;
      let winding = 0;
      let prev = Number.NaN;
      for (let i = 0; i < p.length / 3; i++) {
        if (p[3 * i]! < xStart) continue;
        const a = Math.atan2(p[3 * i + 2]! - zc, p[3 * i + 1]! - yc);
        if (!Number.isNaN(prev)) {
          let d = a - prev;
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          winding += d;
        }
        prev = a;
      }
      best = Math.max(best, Math.abs(winding));
    }
    expect(best).toBeGreaterThan(Math.PI);
  });

  it('turns a sheet over the upper surface inboard', () => {
    const sheet = seedStreamlines(wing, alpha, rake('horizontal', 20), domain);
    const sheetLines = traceStreamlines(lattice, vInf, sheet, domain, wing, alpha);
    let checked = 0;
    for (const l of sheetLines) {
      const y0 = l.points[1]!;
      if (y0 < 0.4 * S || y0 > 0.9 * S) continue;
      const st = wingStationAt(wing, alpha, y0);
      const yTe = atX(l, st.le[0] + st.chord + 0.5, l.points, 3, 1);
      expect(yTe).toBeLessThan(y0);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });
});

describe('edge cases', () => {
  const empty = makeTestLattice(wing, alpha, { nSpanWing: 0, nSpanDevice: 0 });

  it('handles an empty lattice and zero airspeed', () => {
    expect(empty.count).toBe(0);
    const seeds = seedStreamlines(wing, alpha, rake('vertical', 8), domain);
    const lines = traceStreamlines(empty, vInf, seeds, domain, wing, alpha);
    expect(lines.length).toBe(8);
    for (const l of lines) expect(l.points[l.points.length - 3]).toBeCloseTo(domain.max[0], 3);
    expect(traceStreamlines(lattice, 0, seeds, domain, wing, alpha)).toEqual([]);
  });

  it('handles a geometry without surfaces', () => {
    const bare = { ...wing, surfaces: [] };
    const seeds = seedStreamlines(bare, alpha, rake('tip-vortex', 8), domain);
    expect(seeds[0]!.points.length).toBe(3 * 8);
    for (const v of seeds[0]!.points) expect(Number.isFinite(v)).toBe(true);
    const lines = traceStreamlines(empty, vInf, seeds, domain, bare, alpha);
    expect(lines.length).toBe(8);
  });
});
