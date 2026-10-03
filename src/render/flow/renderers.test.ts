/**
 * Smoke tests for the three.js wrappers. They build and update the scene-graph objects and read
 * the CPU-side attribute arrays; nothing here needs a WebGL context.
 */
import { describe, expect, it } from 'vitest';
import type { BufferAttribute, BufferGeometry, Object3D, Points } from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { StreamlineRenderer, MAX_PULSES, PUFFS_PER_TRANSIT } from './StreamlineRenderer';
import { ParticleSystem } from './ParticleSystem';
import {
  defaultAnalyticParams,
  makeAnalyticFlowGrid,
  makeAnalyticStreamlines,
  traceAnalyticStreamline,
} from './fixtures';
import { tunnelDomain } from '../../physics/domain';
import { pathDuration } from './pathSampling';
import type { Streamline3D, WingGeometry } from '../../physics/types';

const vInf = 50;
const domain = tunnelDomain(10, 1.5);
const params = defaultAnalyticParams(vInf);

function findPoints(root: Object3D, index: number): Points {
  const found: Points[] = [];
  root.traverse((o) => {
    if ((o as Points).isPoints) found.push(o as Points);
  });
  return found[index]!;
}
function attr(geometry: BufferGeometry, name: string): Float32Array {
  return (geometry.getAttribute(name) as BufferAttribute).array as Float32Array;
}

/** Time at which a line first reaches x >= xTarget. */
function arrivalTime(line: Streamline3D, xTarget: number): number {
  const n = line.time.length;
  for (let i = 1; i < n; i++) {
    const x0 = line.points[(i - 1) * 3]!;
    const x1 = line.points[i * 3]!;
    if (x1 >= xTarget) {
      const f = (xTarget - x0) / (x1 - x0);
      return line.time[i - 1]! + f * (line.time[i]! - line.time[i - 1]!);
    }
  }
  return Infinity;
}

describe('analytic fixtures', () => {
  it('flow over the top of the lifting cylinder is faster than underneath', () => {
    const lines = makeAnalyticStreamlines(domain, params, 2, 1.5);
    const bottom = lines[0]!;
    const top = lines[1]!;
    expect(arrivalTime(top, 4)).toBeLessThan(arrivalTime(bottom, 4));
  });
});

describe('StreamlineRenderer', () => {
  const lines = makeAnalyticStreamlines(domain, params, 16, 2.5);

  it('builds one line mesh and a puff buffer sized from the line durations', () => {
    const r = new StreamlineRenderer();
    r.setStreamlines(lines, vInf);
    const meshes: LineSegments2[] = [];
    r.object.traverse((o) => {
      if ((o as LineSegments2).isLineSegments2 && o.name === 'StreamlineLines')
        meshes.push(o as LineSegments2);
    });
    expect(meshes.length).toBe(1);
    const segs = lines.reduce((a, l) => a + (l.time.length - 1), 0);
    expect(meshes[0]!.geometry.instanceCount).toBe(segs);
    expect(r.puffSlots).toBeGreaterThan(lines.length * (PUFFS_PER_TRANSIT / 2));
    r.dispose();
  });

  it('releases puffs at a fixed time interval, so faster air spreads them apart', () => {
    const r = new StreamlineRenderer();
    r.setStreamlines(lines, vInf);
    r.update(0.37, 0.01);
    const puffs = findPoints(r.object, 0);
    const pos = attr(puffs.geometry, 'position');
    const alpha = attr(puffs.geometry, 'aAlpha');
    let visible = 0;
    for (let s = 0; s < alpha.length; s++) if (alpha[s]! > 0.1) visible++;
    expect(visible).toBeGreaterThan(lines.length * 8);

    const index = lines.length - 1; // z = +2.5: above the wing
    const line = lines[index]!;
    const [start, count] = r.puffRange(index);
    const interval = r.puffReleaseInterval;
    // Age of each live puff = the time at which the line passes its x (x is monotonic here).
    const ages: { age: number; x: number }[] = [];
    for (let j = 0; j < count; j++) {
      const s = start + j;
      if (alpha[s]! <= 0) continue;
      const x = pos[s * 3]!;
      ages.push({ age: arrivalTime(line, x), x });
    }
    expect(ages.length).toBeGreaterThan(12);
    ages.sort((p, q) => p.age - q.age);
    const gaps = ages.slice(1).map((v, i) => v.x - ages[i]!.x);
    for (let i = 1; i < ages.length; i++) {
      // Equal TIME spacing between neighbouring puffs on the line...
      expect(ages[i]!.age - ages[i - 1]!.age).toBeCloseTo(interval, 4);
    }
    // ...so equal-time puffs are further apart in space where the air is faster.
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(1.05);
    r.dispose();
  });

  it('is deterministic in simTime (puff positions depend only on the clock)', () => {
    const a = new StreamlineRenderer();
    const b = new StreamlineRenderer();
    a.setStreamlines(lines, vInf);
    b.setStreamlines(lines, vInf);
    a.update(0.1, 0.1);
    a.update(0.5, 0.4);
    b.update(0.5, 0.5);
    const ga = findPoints(a.object, 0).geometry;
    const gb = findPoints(b.object, 0).geometry;
    const pa = attr(ga, 'position');
    const pb = attr(gb, 'position');
    const aa = attr(ga, 'aAlpha');
    const ab = attr(gb, 'aAlpha');
    expect([...aa]).toEqual([...ab]);
    for (let s = 0; s < aa.length; s++) {
      if (aa[s]! > 0)
        expect([pa[s * 3], pa[s * 3 + 1], pa[s * 3 + 2]]).toEqual([
          pb[s * 3],
          pb[s * 3 + 1],
          pb[s * 3 + 2],
        ]);
    }
    a.dispose();
    b.dispose();
  });

  it('fires timelines that reach the end of the upper line earlier than the lower line', () => {
    const two = makeAnalyticStreamlines(domain, params, 2, 1.5); // z = -1.5, +1.5
    const r = new StreamlineRenderer();
    r.setStreamlines(two, vInf);
    r.update(1.0, 0.016);
    r.firePulse();
    expect(r.activePulses).toBe(1);

    const xTarget = 6;
    const tBottom = arrivalTime(two[0]!, xTarget);
    const tTop = arrivalTime(two[1]!, xTarget);
    expect(tTop).toBeLessThan(tBottom);
    const age = 0.5 * (tTop + tBottom);
    r.update(1.0 + age, age);
    const pulses = findPoints(r.object, 1);
    const pos = attr(pulses.geometry, 'position');
    const alpha = attr(pulses.geometry, 'aAlpha');
    // Slot layout: pulse 0 occupies slots [0, nLines).
    const bottomX = pos[0]!;
    const topX = pos[3]!;
    expect(alpha[0]!).toBe(1);
    expect(alpha[1]!).toBe(1);
    expect(topX).toBeGreaterThan(xTarget);
    expect(bottomX).toBeLessThan(xTarget);
    r.dispose();
  });

  it('joins neighbouring timeline markers with a connector, but not across seed groups', () => {
    const rake = makeAnalyticStreamlines(domain, params, 4, 1.5);
    const r = new StreamlineRenderer();
    r.setStreamlines(rake, vInf);
    r.update(0, 0);
    r.firePulse();
    r.update(0.05, 0.05);
    const { alpha: cAlpha, positions: cPos } = r.timelineConnectors;
    const mPos = attr(findPoints(r.object, 1).geometry, 'position');
    // Pulse 0: 3 connectors (0-1, 1-2, 2-3) = segments 0..2; segment 3 (last line) is unused.
    for (let seg = 0; seg < 3; seg++) {
      expect(cAlpha[seg * 2]!).toBeGreaterThan(0.3);
      expect([...cPos.subarray(seg * 6, seg * 6 + 3)]).toEqual([
        ...mPos.subarray(seg * 3, seg * 3 + 3),
      ]);
      expect([...cPos.subarray(seg * 6 + 3, seg * 6 + 6)]).toEqual([
        ...mPos.subarray(seg * 3 + 3, seg * 3 + 6),
      ]);
    }
    expect(cAlpha[3 * 2]!).toBe(0);
    r.dispose();

    const mixed = rake.map((l, i) => ({
      ...l,
      group: i < 2 ? ('rake' as const) : ('tip-vortex' as const),
    }));
    const r2 = new StreamlineRenderer();
    r2.setStreamlines(mixed, vInf);
    r2.update(0, 0);
    r2.firePulse();
    r2.update(0.05, 0.05);
    const a2 = r2.timelineConnectors.alpha;
    expect(a2[0]!).toBeGreaterThan(0); // 0-1 same group
    expect(a2[2]!).toBe(0); // 1-2 crosses groups
    expect(a2[4]!).toBeGreaterThan(0); // 2-3 same group
    r2.dispose();
  });

  it('lets several pulses coexist, caps them, and fades them out after the end', () => {
    const r = new StreamlineRenderer();
    r.setStreamlines(lines, vInf);
    const transit = (domain.max[0] - domain.min[0]) / vInf;
    r.update(0, 0);
    r.firePulse();
    r.update(0.1 * transit, 0.1 * transit);
    r.firePulse();
    r.update(0.2 * transit, 0.1 * transit);
    r.firePulse();
    expect(r.activePulses).toBe(3);
    for (let i = 0; i < MAX_PULSES + 3; i++) r.firePulse();
    expect(r.activePulses).toBe(MAX_PULSES);

    // Long after, everything has finished.
    r.update(50 * transit, 1);
    expect(r.activePulses).toBe(0);
    const alpha = attr(findPoints(r.object, 1).geometry, 'aAlpha');
    expect(Math.max(...alpha)).toBe(0);
    r.dispose();
  });

  it('keeps pulse markers parked at the line end while they fade', () => {
    const r = new StreamlineRenderer();
    const line = lines[3]!;
    r.setStreamlines([line], vInf);
    r.update(0, 0);
    r.firePulse();
    const d = pathDuration(line);
    const transit = (domain.max[0] - domain.min[0]) / vInf;
    r.update(d + 0.09 * transit, 0.1);
    const pulses = findPoints(r.object, 1);
    const alpha = attr(pulses.geometry, 'aAlpha');
    const pos = attr(pulses.geometry, 'position');
    expect(alpha[0]!).toBeGreaterThan(0.2);
    expect(alpha[0]!).toBeLessThan(0.8);
    const n = line.time.length;
    expect(pos[0]!).toBeCloseTo(line.points[(n - 1) * 3]!, 3);
    r.dispose();
  });

  it('recolours in place when the colour mode changes, and hides with setVisible', () => {
    const r = new StreamlineRenderer();
    r.setStreamlines(lines, vInf);
    const mesh = r.object.getObjectByName('StreamlineLines') as LineSegments2;
    const colors = (
      mesh.geometry.getAttribute('instanceColorStart') as unknown as {
        data: { array: Float32Array };
      }
    ).data.array;
    const before = Float32Array.from(colors);
    r.setColorBy('speed');
    expect([...colors]).not.toEqual([...before]);
    r.setColorBy('pressure');
    expect([...colors]).toEqual([...before]);
    r.setVisible(false);
    expect(r.object.visible).toBe(false);
    r.setVisible(true);
    expect(r.object.visible).toBe(true);
    r.dispose();
  });

  it('handles null, empty and degenerate input', () => {
    const r = new StreamlineRenderer();
    r.setStreamlines(null, vInf);
    r.update(1, 0.1);
    r.firePulse();
    expect(r.activePulses).toBe(0);
    r.setStreamlines([], vInf);
    const tiny: Streamline3D = {
      points: new Float32Array([0, 0, 0]),
      speed: new Float32Array([1]),
      time: new Float32Array([0]),
      group: 'rake',
    };
    r.setStreamlines([tiny, lines[0]!], vInf);
    r.update(0.3, 0.1);
    r.firePulse();
    r.update(0.4, 0.1);
    r.setStreamlines(null, vInf);
    r.dispose();
  });

  it('copes with 128 long lines', () => {
    const many: Streamline3D[] = [];
    for (let i = 0; i < 128; i++) {
      many.push(
        traceAnalyticStreamline(domain, params, [domain.min[0] + 1e-3, 0, -3 + (6 * i) / 127]),
      );
    }
    const r = new StreamlineRenderer();
    r.setStreamlines(many, vInf);
    for (let f = 0; f < 5; f++) r.update(0.05 * f, 0.05);
    r.firePulse();
    r.update(0.3, 0.05);
    r.dispose();
  });
});

describe('ParticleSystem', () => {
  const grid = makeAnalyticFlowGrid(domain, params, [60, 40, 30]);

  it('is hidden until it has a field, then simulates ~7000 particles', () => {
    const ps = new ParticleSystem();
    expect(ps.object.visible).toBe(false);
    ps.setDomain(domain, null);
    ps.setField(grid);
    expect(ps.object.visible).toBe(true);
    ps.update(0.003);
    const points = findPoints(ps.object, 0);
    expect(ps.count).toBe(7000);
    expect(points.geometry.drawRange.count).toBe(7000);
    const pos = attr(points.geometry, 'position');
    for (let i = 0; i < 7000 * 3; i++) expect(Number.isFinite(pos[i]!)).toBe(true);
    ps.setField(null);
    expect(ps.object.visible).toBe(false);
    ps.dispose();
  });

  it('sizes the spawn band from the wing geometry and falls back to the tunnel proportions', () => {
    const ps = new ParticleSystem();
    ps.setDomain(domain, { overallSpan: 12, pivot: [0.3, 0, 0.1] } as unknown as WingGeometry);
    const region = ps.spawnRegion!;
    expect(region.bandHalfY).toBeCloseTo(1.15 * 6, 6);
    expect(region.bandHalfZ).toBeCloseTo(0.2 * 6, 6);
    expect(region.bandCenterZ).toBeCloseTo(0.1, 6);
    ps.setDomain(domain, null); // tunnelDomain(10, 1.5): half-width 7.5 = 1.5 semispans of 5
    expect(ps.spawnRegion!.bandHalfY).toBeCloseTo(1.15 * 5, 2);
    ps.dispose();
  });

  it('density changes the draw range and respects the cap', () => {
    const ps = new ParticleSystem();
    ps.setDomain(domain, null);
    ps.setField(grid);
    ps.setDensity(0.25);
    ps.update(0.003);
    expect(findPoints(ps.object, 0).geometry.drawRange.count).toBe(1750);
    ps.setDensity(2);
    ps.update(0.003);
    expect(ps.count).toBe(14000);
    ps.setDensity(99);
    expect(ps.count).toBe(14000);
    ps.dispose();
  });

  it('writes trails whose tail lags the head and respects setTrails', () => {
    const ps = new ParticleSystem();
    ps.setDomain(domain, null);
    ps.setField(grid);
    for (let i = 0; i < 40; i++) ps.update(0.004);
    const trails = ps.object.children.find(
      (c) => (c as { isLineSegments?: boolean }).isLineSegments,
    )!;
    const tp = attr((trails as unknown as Points).geometry, 'position');
    let lagging = 0;
    for (let i = 0; i < 1000; i++) if (tp[i * 6]! - tp[i * 6 + 3]! > 1e-3) lagging++;
    expect(lagging).toBeGreaterThan(500);
    ps.setTrails(false);
    expect(trails.visible).toBe(false);
    ps.setColorBy('speed');
    ps.setVisible(false);
    expect(ps.object.visible).toBe(false);
    ps.dispose();
  });
});
