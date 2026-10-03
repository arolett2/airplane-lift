import { describe, expect, it } from 'vitest';
import { makeTestStrips, makeTestWing } from '../util/testFixtures';
import { loftWing, VERTEX_SLAT } from './loft';
import {
  NEUTRAL_LINEAR,
  STALL_TINT_LINEAR,
  bindStrips,
  colorizeWing,
  sampleChordwise,
  WING_CP_MIN,
  writePressureColor,
} from './surfaceColors';
import { srgbToLinear, wingPressureColor } from '../util/palette';
import type { StripResult } from '../../physics/types';

describe('writePressureColor', () => {
  it('matches the 3D wing palette (in linear space)', () => {
    const out = new Float32Array(3);
    for (const cp of [-2.5, -1.2, -0.3, 0, 0.4, 1, -9, 3]) {
      writePressureColor(cp, out, 0);
      const ref = wingPressureColor(Math.min(1, Math.max(WING_CP_MIN, cp)));
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(srgbToLinear(ref[k]!), 2);
    }
  });

  it('reads clearly blue at airliner cruise suction (Cp about -0.6)', () => {
    const o = new Float32Array(3);
    writePressureColor(-0.6, o, 0);
    expect(o[2]).toBeGreaterThan(2.5 * o[0]!);
    writePressureColor(0.5, o, 0);
    expect(o[0]).toBeGreaterThan(3 * o[2]!);
  });

  it('is blue for suction, light for freestream and red for stagnation', () => {
    const o = new Float32Array(3);
    writePressureColor(-2, o, 0);
    expect(o[2]).toBeGreaterThan(o[0]!);
    writePressureColor(0, o, 0);
    expect(Math.min(...o)).toBeGreaterThan(0.7);
    writePressureColor(1, o, 0);
    expect(o[0]).toBeGreaterThan(o[2]! * 5);
    writePressureColor(NaN, o, 0);
    expect(Math.min(...o)).toBeGreaterThan(0.7);
  });
});

describe('sampleChordwise', () => {
  const cp = {
    xc: Float32Array.from([0, 0.5, 1]),
    upper: Float32Array.from([1, -1, 0]),
    lower: Float32Array.from([2, 2, 2]),
  };
  it('interpolates linearly and clamps outside the range', () => {
    expect(sampleChordwise(cp, 0.25, true)).toBeCloseTo(0, 6);
    expect(sampleChordwise(cp, 0.75, true)).toBeCloseTo(-0.5, 6);
    expect(sampleChordwise(cp, -1, true)).toBe(1);
    expect(sampleChordwise(cp, 2, true)).toBe(0);
    expect(sampleChordwise(cp, 0.3, false)).toBe(2);
  });
});

describe('bindStrips', () => {
  const geo = makeTestWing({ winglet: true });
  const lofted = loftWing(geo);
  const strips = makeTestStrips(geo, { perSurface: 8 });

  it('assigns strips to their surface in root-to-tip order, independent of input order', () => {
    const shuffled = [...strips].reverse();
    const b = bindStrips(lofted, shuffled);
    expect(b).toHaveLength(4);
    for (const binding of b) {
      expect(binding).not.toBeNull();
      expect(binding!.strips).toHaveLength(8);
      for (let k = 1; k < 8; k++) {
        expect(binding!.u[k]).toBeGreaterThan(binding!.u[k - 1]!);
        expect(binding!.strips[k]!.eta).toBeGreaterThan(binding!.strips[k - 1]!.eta);
      }
      expect(binding!.u[0]).toBeCloseTo(1 / 16, 6);
      expect(binding!.u[7]).toBeCloseTo(15 / 16, 6);
    }
  });

  it('returns null bindings when there are no strips or the ids do not match', () => {
    expect(bindStrips(lofted, null).every((x) => x === null)).toBe(true);
    const foreign: StripResult[] = strips.map((s) => ({ ...s, surfaceId: 'nope' }));
    expect(bindStrips(lofted, foreign).every((x) => x === null)).toBe(true);
  });
});

describe('colorizeWing', () => {
  const geo = makeTestWing({ slats: true });
  const lofted = loftWing(geo);
  const n = lofted.vertexCount;
  const colors = new Float32Array(3 * n);
  const stall = new Float32Array(n);

  /** Colour of the first vertex of surface 0 matching a predicate. */
  function find(pred: (v: number) => boolean): number {
    for (let v = 0; v < n; v++) if (pred(v)) return v;
    throw new Error('vertex not found');
  }

  it('is a uniform neutral colour without strips, slats grey', () => {
    colorizeWing(lofted, null, colors, stall);
    const skin = find((v) => lofted.kind[v] === 0);
    const ref = new Float32Array(3);
    writePressureColor(0, ref, 0);
    for (let k = 0; k < 3; k++) expect(colors[3 * skin + k]).toBeCloseTo(ref[k]!, 6);
    const slat = find((v) => lofted.kind[v] === VERTEX_SLAT);
    for (let k = 0; k < 3; k++) expect(colors[3 * slat + k]).toBeCloseTo(NEUTRAL_LINEAR[k]!, 6);
    for (const s of stall) expect(s).toBe(0);
  });

  it('colours the suction side blue and the pressure side lighter/redder', () => {
    const strips = makeTestStrips(geo, { perSurface: 10 });
    colorizeWing(lofted, bindStrips(lofted, strips), colors, stall);
    const mid = lofted.surfaces[0]!.vertexStart + 10 * lofted.surfaces[0]!.ringSize;
    const upper = mid + 50; // x/c ~ 0.25 on the upper surface: strong suction
    const lower = mid + 30;
    expect(lofted.upper[upper]).toBe(1);
    expect(lofted.upper[lower]).toBe(0);
    expect(colors[3 * upper + 2]).toBeGreaterThan(colors[3 * upper]!); // blue > red
    expect(colors[3 * lower]).toBeGreaterThanOrEqual(colors[3 * lower + 2]! - 0.05); // not blue
    for (const s of stall) expect(s).toBe(0);
  });

  it('interpolates spanwise between strips', () => {
    const base = makeTestStrips(geo, { perSurface: 2 });
    // Two strips on the right wing: force constant, different Cp.
    const mk = (s: StripResult, value: number): StripResult => ({
      ...s,
      cp: {
        xc: s.cp.xc,
        upper: new Float32Array(s.cp.xc.length).fill(value),
        lower: new Float32Array(s.cp.xc.length).fill(value),
      },
    });
    const right = base.filter((s) => s.surfaceId === 'right-wing');
    const strips = [mk(right[0]!, -1), mk(right[1]!, 0)];
    const binding = bindStrips(lofted, strips);
    colorizeWing(lofted, binding, colors, stall);
    // Strip centres sit at u = 0.25 and 0.75: Cp varies linearly between them.
    const surf = lofted.surfaces[0]!;
    let target = -1;
    for (let r = 0; r < surf.ringCount; r++) {
      const v = surf.vertexStart + r * surf.ringSize + 60;
      const u = lofted.u[v]!;
      if (u > 0.3 && u < 0.7) target = v;
    }
    expect(target).toBeGreaterThan(-1);
    const uT = lofted.u[target]!;
    const expected = new Float32Array(3);
    writePressureColor(-1 + (uT - 0.25) / 0.5, expected, 0);
    for (let k = 0; k < 3; k++) expect(colors[3 * target + k]).toBeCloseTo(expected[k]!, 3);
    // Outboard of the last strip the colour is clamped to that strip (Cp = 0).
    const tipRing = surf.vertexStart + (surf.ringCount - 1) * surf.ringSize + 60;
    writePressureColor(0, expected, 0);
    for (let k = 0; k < 3; k++) expect(colors[3 * tipRing + k]).toBeCloseTo(expected[k]!, 3);
  });

  it('tints the separated upper surface aft of the separation point, never the lower', () => {
    const strips = makeTestStrips(geo, { perSurface: 10, stallFromEta: 0.5 });
    colorizeWing(lofted, bindStrips(lofted, strips), colors, stall);
    const surf = lofted.surfaces[0]!;
    const tipRing = surf.vertexStart + (surf.ringCount - 1) * surf.ringSize;
    // Upper vertex at x/c ~ 0.9 (stalled strip: attached fraction 0.55): fully tinted.
    let aft = -1;
    let fore = -1;
    let lowerAft = -1;
    for (let j = 40; j < surf.ringSize; j++) {
      if (aft < 0 && lofted.xc[tipRing + j]! > 0.85) aft = tipRing + j;
      if (fore < 0 && lofted.xc[tipRing + j]! > 0.2) fore = tipRing + j;
    }
    for (let j = 0; j < 40; j++) if (lofted.xc[tipRing + j]! < 0.85) lowerAft = tipRing + j;
    expect(stall[aft]).toBeGreaterThan(0.95);
    expect(stall[fore]).toBe(0); // forward of separation
    expect(stall[lowerAft]).toBe(0);
    // Tinted colour is orange-ish: red clearly above blue.
    expect(colors[3 * aft]).toBeGreaterThan(colors[3 * aft + 2]! * 1.5);
    expect(colors[3 * aft]).toBeLessThanOrEqual(STALL_TINT_LINEAR[0] + 0.2);
    // Root strip is attached: no tint anywhere near the root.
    const rootRing = surf.vertexStart;
    for (let j = 0; j < surf.ringSize; j++) expect(stall[rootRing + j]).toBe(0);
  });
});
