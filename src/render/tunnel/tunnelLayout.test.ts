import { describe, expect, it } from 'vitest';
import { tunnelDomain } from '../../physics/domain';
import {
  boxEdges,
  clipSegment,
  floorGrid,
  honeycombSegments,
  honeycombVertices,
  niceStep,
  tunnelDims,
  wallRibs,
} from './tunnelLayout';

describe('niceStep', () => {
  it('rounds to 1-2-5 steps', () => {
    expect(niceStep(100, 10)).toBe(10);
    expect(niceStep(64, 10)).toBe(5);
    expect(niceStep(11, 10)).toBe(1);
    expect(niceStep(35, 10)).toBe(5);
    expect(niceStep(0.9, 10)).toBeCloseTo(0.1, 12);
    expect(niceStep(14, 10)).toBe(1);
    expect(niceStep(18, 10)).toBe(2);
  });
});

describe('tunnelDims', () => {
  it('recovers the span the domain was built from', () => {
    const d = tunnelDomain(37, 4);
    expect(tunnelDims(d).span).toBeCloseTo(37, 10);
  });
});

describe('clipSegment', () => {
  const out = [0, 0, 0, 0];
  it('keeps segments inside, trims crossing ones and rejects outside ones', () => {
    expect(clipSegment(1, 1, 2, 2, 0, 0, 5, 5, out)).toBe(true);
    expect(out).toEqual([1, 1, 2, 2]);
    expect(clipSegment(-5, 2, 10, 2, 0, 0, 5, 5, out)).toBe(true);
    expect(out).toEqual([0, 2, 5, 2]);
    expect(clipSegment(6, 0, 8, 5, 0, 0, 5, 5, out)).toBe(false);
    expect(clipSegment(-1, 7, 3, 9, 0, 0, 5, 5, out)).toBe(false);
  });
});

describe('honeycomb', () => {
  const w = 8;
  const h = 5;
  const r = 0.4;
  const seg = honeycombSegments(w, h, r);

  it('stays inside the rectangle and has no duplicate edges', () => {
    expect(seg.length % 4).toBe(0);
    expect(seg.length).toBeGreaterThan(400);
    const keys = new Set<string>();
    for (let i = 0; i < seg.length; i += 4) {
      for (const k of [0, 2]) {
        expect(seg[i + k]).toBeGreaterThanOrEqual(-1e-5);
        expect(seg[i + k]).toBeLessThanOrEqual(w + 1e-5);
        expect(seg[i + k + 1]).toBeGreaterThanOrEqual(-1e-5);
        expect(seg[i + k + 1]).toBeLessThanOrEqual(h + 1e-5);
      }
      const a = `${seg[i]!.toFixed(3)},${seg[i + 1]!.toFixed(3)}`;
      const b = `${seg[i + 2]!.toFixed(3)},${seg[i + 3]!.toFixed(3)}`;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });

  it('covers the whole rectangle (every region has cell walls nearby)', () => {
    // Sample points: each must be within one cell radius of some segment endpoint.
    for (let x = 0.2; x < w; x += 0.9) {
      for (let y = 0.2; y < h; y += 0.9) {
        let best = Infinity;
        for (let i = 0; i < seg.length; i += 4) {
          best = Math.min(
            best,
            Math.hypot(seg[i]! - x, seg[i + 1]! - y),
            Math.hypot(seg[i + 2]! - x, seg[i + 3]! - y),
          );
        }
        expect(best).toBeLessThan(1.5 * r);
      }
    }
  });

  it('corner vertices are unique and inside', () => {
    const v = honeycombVertices(w, h, r);
    expect(v.length % 2).toBe(0);
    const keys = new Set<string>();
    for (let i = 0; i < v.length; i += 2) {
      expect(v[i]).toBeGreaterThanOrEqual(0);
      expect(v[i]).toBeLessThanOrEqual(w);
      keys.add(`${Math.round(v[i]! * 100)},${Math.round(v[i + 1]! * 100)}`);
    }
    expect(keys.size).toBe(v.length / 2);
  });
});

describe('floorGrid', () => {
  const d = tunnelDomain(40, 4);
  const g = floorGrid(d, 5);

  it('lies on the floor plane and passes through the wing axis', () => {
    expect(g.positions.length % 6).toBe(0);
    for (let i = 2; i < g.positions.length; i += 3) expect(g.positions[i]).toBe(d.min[2]);
    // A line at x = 0 and y = 0 exists.
    let hasX0 = false;
    let hasY0 = false;
    for (let i = 0; i < g.positions.length; i += 6) {
      if (g.positions[i] === 0 && g.positions[i + 3] === 0) hasX0 = true;
      if (g.positions[i + 1] === 0 && g.positions[i + 4] === 0) hasY0 = true;
    }
    expect(hasX0).toBe(true);
    expect(hasY0).toBe(true);
  });

  it('fades toward the edges and stays in [0, 1]', () => {
    expect(g.brightness.length).toBe(g.positions.length / 3);
    for (const b of g.brightness) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
    let edgeMax = 0;
    let centreMax = 0;
    for (let i = 0; i < g.brightness.length; i++) {
      const x = g.positions[3 * i]!;
      const y = g.positions[3 * i + 1]!;
      if (Math.abs(y) > 0.95 * d.max[1] || x > d.max[0] - 3)
        edgeMax = Math.max(edgeMax, g.brightness[i]!);
      if (Math.abs(y) < 0.2 * d.max[1] && Math.abs(x) < 6)
        centreMax = Math.max(centreMax, g.brightness[i]!);
    }
    expect(centreMax).toBeGreaterThan(0.9);
    expect(edgeMax).toBeLessThan(0.35);
  });
});

describe('frames', () => {
  it('boxEdges has 12 edges on the domain bounds', () => {
    const d = tunnelDomain(20, 2);
    const e = boxEdges(d);
    expect(e.length).toBe(12 * 6);
    for (let i = 0; i < e.length; i += 3) {
      expect([d.min[0], d.max[0]]).toContain(e[i]);
      expect([d.min[1], d.max[1]]).toContain(e[i + 1]);
      expect([d.min[2], d.max[2]]).toContain(e[i + 2]);
    }
  });

  it('wallRibs makes three segments per rib, strictly inside the end faces', () => {
    const d = tunnelDomain(20, 2);
    const r = wallRibs(d, 7);
    expect(r.length).toBe(7 * 3 * 6);
    for (let i = 0; i < r.length; i += 3) {
      expect(r[i]).toBeGreaterThan(d.min[0]);
      expect(r[i]).toBeLessThan(d.max[0]);
    }
  });
});
