import { describe, expect, it } from 'vitest';
import type { SectionFlow, Streamline2D } from '../types';
import { getAirfoilModel } from './index';
import { computeSectionFlow, seedOffsets } from './sectionFlow';

const DEG = Math.PI / 180;
const RE = 6e6;
const model = getAirfoilModel({
  params: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
  flap: null,
  slat: false,
  supercritical: false,
});
const flowAt = (alphaDeg: number, alphaInducedDeg = 0) =>
  computeSectionFlow(model, {
    eta: 0.4,
    alphaGeometric: alphaDeg * DEG,
    alphaInduced: alphaInducedDeg * DEG,
    reynolds: RE,
  });

const attached = flowAt(6, 1);
const stallAlpha = model.polar.alphaStall(RE) / DEG;
const stalled = flowAt(stallAlpha + 4);

function pointInContour(contour: Float32Array, x: number, y: number): boolean {
  let inside = false;
  const n = contour.length / 2 - 1;
  for (let i = 0; i < n; i++) {
    const x0 = contour[2 * i]!;
    const y0 = contour[2 * i + 1]!;
    const x1 = contour[2 * i + 2]!;
    const y1 = contour[2 * i + 3]!;
    if (y0 > y !== y1 > y && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside;
  }
  return inside;
}

const node = (f: SectionFlow, x: number, y: number) => {
  const g = f.grid;
  const i = Math.round(((x - g.xMin) / (g.xMax - g.xMin)) * (g.nx - 1));
  const j = Math.round(((y - g.yMin) / (g.yMax - g.yMin)) * (g.ny - 1));
  return i + g.nx * j;
};

/** Travel time when a streamline first reaches x (linear interpolation), or NaN. */
function timeAtX(line: Streamline2D, x: number): number {
  const n = line.points.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const x0 = line.points[2 * i]!;
    const x1 = line.points[2 * i + 2]!;
    if (x0 <= x && x1 > x) {
      const w = (x - x0) / (x1 - x0);
      return line.time[i]! + w * (line.time[i + 1]! - line.time[i]!);
    }
  }
  return NaN;
}

/** Height of a streamline where it crosses x (first crossing), or NaN. */
function yAtX(line: Streamline2D, x: number): number {
  const n = line.points.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const x0 = line.points[2 * i]!;
    const x1 = line.points[2 * i + 2]!;
    if (x0 <= x && x1 > x) {
      const w = (x - x0) / (x1 - x0);
      return line.points[2 * i + 1]! + w * (line.points[2 * i + 3]! - line.points[2 * i + 1]!);
    }
  }
  return NaN;
}

describe('section flow', () => {
  it('reports the effective angle and section aerodynamics', () => {
    expect(attached.alphaEffective).toBeCloseTo(5 * DEG, 12);
    expect(attached.alphaGeometric).toBeCloseTo(6 * DEG, 12);
    expect(attached.alphaInduced).toBeCloseTo(1 * DEG, 12);
    expect(attached.eta).toBe(0.4);
    expect(attached.cl).toBeCloseTo(model.polar.cl(5 * DEG, RE), 12);
    expect(attached.stalled).toBe(false);
    expect(attached.attachedFraction).toBe(1);
    expect(attached.fieldCl).toBeCloseTo(model.solver.clAt(5 * DEG), 9);
    expect(attached.cp.xc.length).toBe(41);
    expect(attached.contour.length).toBe(2 * model.geometry.nPoints);
    // Stagnation point just under the nose at positive alpha.
    expect(attached.stagnation[0]).toBeGreaterThan(0);
    expect(attached.stagnation[0]).toBeLessThan(0.03);
    expect(attached.stagnation[1]).toBeLessThan(0);
  });

  it('fills a grid that tends to the freestream away from the airfoil', () => {
    const g = attached.grid;
    expect(g.nx).toBe(160);
    expect(g.ny).toBe(96);
    expect(g.uv.length).toBe(2 * 160 * 96);
    const a = attached.alphaEffective;
    for (const [x, y] of [
      [-0.6, -0.6],
      [-0.6, 0.6],
      [1.8, -0.6],
      [1.8, 0.6],
    ] as const) {
      const k = node(attached, x, y);
      const u = g.uv[2 * k]!;
      const v = g.uv[2 * k + 1]!;
      expect(Math.abs(Math.hypot(u, v) - 1)).toBeLessThan(0.12);
      expect(Math.abs(Math.atan2(v, u) - a)).toBeLessThan(8 * DEG);
    }
    // Faster over the top than underneath.
    const top = node(attached, 0.3, 0.12);
    const bottom = node(attached, 0.3, -0.1);
    expect(Math.hypot(g.uv[2 * top]!, g.uv[2 * top + 1]!)).toBeGreaterThan(
      Math.hypot(g.uv[2 * bottom]!, g.uv[2 * bottom + 1]!) + 0.1,
    );
  });

  it('masks grid nodes inside the airfoil', () => {
    const g = attached.grid;
    expect(g.inside[node(attached, 0.3, 0.02)]).toBe(1);
    expect(g.inside[node(attached, 0.3, 0.2)]).toBe(0);
    expect(g.inside[node(attached, -0.2, 0)]).toBe(0);
    let count = 0;
    for (let k = 0; k < g.nx * g.ny; k++) {
      const x = g.xMin + ((k % g.nx) * (g.xMax - g.xMin)) / (g.nx - 1);
      const y = g.yMin + (Math.floor(k / g.nx) * (g.yMax - g.yMin)) / (g.ny - 1);
      expect(g.inside[k]).toBe(pointInContour(attached.contour, x, y) ? 1 : 0);
      if (g.inside[k]) {
        count++;
        expect(g.uv[2 * k]).toBe(0);
        expect(g.uv[2 * k + 1]).toBe(0);
      }
    }
    // NACA 4-digit area ~ 0.685 t c^2.
    const cell = ((g.xMax - g.xMin) / (g.nx - 1)) * ((g.yMax - g.yMin) / (g.ny - 1));
    expect(count * cell).toBeGreaterThan(0.685 * 0.12 * 0.85);
    expect(count * cell).toBeLessThan(0.685 * 0.12 * 1.15);
  });

  it('traces streamlines from upstream that never enter the body', () => {
    expect(attached.streamlines.length).toBe(28);
    const W = attached.grid;
    for (const line of attached.streamlines) {
      const n = line.points.length / 2;
      expect(n).toBeGreaterThan(10);
      expect(line.speed.length).toBe(n);
      expect(line.time.length).toBe(n);
      for (let i = 0; i < n; i++) {
        const x = line.points[2 * i]!;
        const y = line.points[2 * i + 1]!;
        expect(x).toBeGreaterThanOrEqual(W.xMin - 1e-4);
        expect(x).toBeLessThanOrEqual(W.xMax + 1e-4);
        expect(y).toBeGreaterThanOrEqual(W.yMin - 1e-4);
        expect(y).toBeLessThanOrEqual(W.yMax + 1e-4);
        expect(pointInContour(attached.contour, x, y)).toBe(false);
        expect(Number.isFinite(line.speed[i]!)).toBe(true);
        if (i > 0) expect(line.time[i]!).toBeGreaterThan(line.time[i - 1]!);
      }
      // Far upstream the air simply moves downstream.
      for (let i = 1; i < n && line.points[2 * i]! < -0.35; i++) {
        expect(line.points[2 * i]!).toBeGreaterThan(line.points[2 * i - 2]!);
      }
      // Lines run to the edge of the window.
      const lx = line.points[2 * n - 2]!;
      const ly = line.points[2 * n - 1]!;
      const onEdge =
        Math.abs(lx - W.xMax) < 1e-3 ||
        Math.abs(ly - W.yMax) < 1e-3 ||
        Math.abs(ly - W.yMin) < 1e-3;
      expect(onEdge).toBe(true);
    }
  });

  it('shows that air over the top arrives first (no equal transit time)', () => {
    // Nearest streamlines above and below the airfoil at mid-chord.
    let upper: Streamline2D | null = null;
    let lower: Streamline2D | null = null;
    let upperY = Infinity;
    let lowerY = -Infinity;
    for (const line of attached.streamlines) {
      const y = yAtX(line, 0.5);
      if (!Number.isFinite(y)) continue;
      if (y > 0.05 && y < upperY) {
        upperY = y;
        upper = line;
      }
      if (y < -0.02 && y > lowerY) {
        lowerY = y;
        lower = line;
      }
    }
    expect(upper).not.toBeNull();
    expect(lower).not.toBeNull();
    expect(upperY).toBeLessThan(0.15);
    expect(lowerY).toBeGreaterThan(-0.12);
    const tUpper = timeAtX(upper!, 1.0);
    const tLower = timeAtX(lower!, 1.0);
    expect(tUpper).toBeLessThan(tLower - 0.05);
    // Started on the same seed line, upstream of the airfoil.
    expect(upper!.points[0]!).toBeLessThan(0);
    expect(lower!.points[0]!).toBeLessThan(0);
  });

  it('flags stall and draws a separated dead-air region the streamlines avoid', () => {
    expect(stalled.stalled).toBe(true);
    expect(stalled.streamlines.length).toBe(28);
    expect(stalled.attachedFraction).toBeLessThan(0.7);
    expect(flowAt(stallAlpha - 3).stalled).toBe(false);
    const g = stalled.grid;
    // A slow region above the aft upper surface.
    const k = node(stalled, 0.9, 0.12);
    expect(Math.hypot(g.uv[2 * k]!, g.uv[2 * k + 1]!)).toBeLessThan(0.3);
    expect(stalled.separated[k]).toBe(1);
    expect(attached.separated.every((v) => v === 0)).toBe(true);
    let slow = 0;
    let total = 0;
    for (let i = 0; i < g.nx * g.ny; i++) {
      if (!stalled.separated[i]) continue;
      total++;
      if (Math.hypot(g.uv[2 * i]!, g.uv[2 * i + 1]!) < 0.3) slow++;
    }
    expect(total).toBeGreaterThan(50);
    expect(slow / total).toBeGreaterThan(0.95);
    // Streamlines detour around the bubble instead of crossing it.
    let inBubble = 0;
    for (const line of stalled.streamlines) {
      for (let i = 0; i < line.points.length / 2; i++) {
        if (stalled.separated[node(stalled, line.points[2 * i]!, line.points[2 * i + 1]!)]) {
          inBubble++;
        }
      }
    }
    expect(inBubble).toBeLessThan(5);
    // The drawn flow carries the polar's (reduced) lift, not the attached-flow lift.
    expect(stalled.fieldCl).toBeGreaterThan(stalled.cl - 0.15);
    expect(stalled.fieldCl).toBeLessThan(stalled.cl + 0.15);
    expect(stalled.fieldCl).toBeLessThan(model.solver.clAt(stalled.alphaEffective) - 0.5);
  });

  it('keeps the flow continuous through the onset of stall', () => {
    // Just past stall the separated bubble is small and the circulation barely changes.
    const before = flowAt(stallAlpha - 0.3);
    const after = flowAt(stallAlpha + 0.3);
    expect(after.stalled).toBe(true);
    expect(Math.abs(after.fieldCl - before.fieldCl)).toBeLessThan(0.25);
    const dx = after.stagnation[0] - before.stagnation[0];
    const dy = after.stagnation[1] - before.stagnation[1];
    expect(Math.hypot(dx, dy)).toBeLessThan(0.01);
  });

  it('handles negative stall and extreme angles without breaking', () => {
    const neg = flowAt(model.polar.alphaStallNegative(RE) / DEG - 4);
    expect(neg.stalled).toBe(true);
    expect(neg.cl).toBeLessThan(0);
    for (const a of [-60, 30, 45, 89, 135, 180]) {
      const f = flowAt(a);
      expect(f.streamlines.length).toBeGreaterThan(20);
      for (let i = 0; i < f.grid.uv.length; i++) expect(Number.isFinite(f.grid.uv[i]!)).toBe(true);
    }
  });

  it('spreads seeds densely near the stagnation streamline, never on it', () => {
    const offs = seedOffsets(28, -0.7, 0.8, 0.05);
    expect(offs.length).toBe(28);
    for (const o of offs) expect(Math.abs(o - 0.05)).toBeGreaterThan(0.005);
    const sorted = [...offs].sort((a, b) => a - b);
    expect(sorted).toEqual(offs);
    expect(offs[0]!).toBeGreaterThanOrEqual(-0.7);
    expect(offs[27]!).toBeLessThanOrEqual(0.8);
    const near = offs.filter((o) => Math.abs(o - 0.05) < 0.2).length;
    const far = offs.filter((o) => Math.abs(o - 0.05) > 0.5).length;
    expect(near).toBeGreaterThan(far);
  });

  it('runs within the interactive budget', () => {
    const t0 = performance.now();
    flowAt(7);
    const tAttached = performance.now() - t0;
    const t1 = performance.now();
    flowAt(stallAlpha + 6);
    const tStalled = performance.now() - t1;
    // eslint-disable-next-line no-console -- timing log requested for perf tracking
    console.info(
      `sectionFlow: attached ${tAttached.toFixed(1)} ms, stalled ${tStalled.toFixed(1)} ms`,
    );
    expect(tAttached).toBeLessThan(300); // target < 120 ms; generous for CI noise
    expect(tStalled).toBeLessThan(300);
  });
});
