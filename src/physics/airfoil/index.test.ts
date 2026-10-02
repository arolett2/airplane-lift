import { describe, expect, it } from 'vitest';
import type { AirfoilKey } from './index';
import { airfoilKeyString, getAirfoilModel } from './index';

const DEG = Math.PI / 180;
const RE = 6e6;
const key2412: AirfoilKey = {
  params: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
  flap: null,
  slat: false,
  supercritical: false,
};

/** Integrate (lower - upper) over x/c with the trapezoid rule. */
function integrate(xc: Float32Array, upper: Float32Array, lower: Float32Array): number {
  let s = 0;
  for (let k = 1; k < xc.length; k++) {
    const d0 = lower[k - 1]! - upper[k - 1]!;
    const d1 = lower[k]! - upper[k]!;
    s += 0.5 * (d0 + d1) * (xc[k]! - xc[k - 1]!);
  }
  return s;
}

describe('airfoil model cache', () => {
  it('memoises by value with 1e-5 rounding', () => {
    const a = getAirfoilModel(key2412);
    const b = getAirfoilModel({
      ...key2412,
      params: { camber: 0.020000001, camberPos: 0.4, thickness: 0.12 },
    });
    expect(b).toBe(a);
    expect(getAirfoilModel({ ...key2412, slat: true })).not.toBe(a);
    // A zero-deflection flap is the clean section.
    expect(airfoilKeyString({ ...key2412, flap: { chordFrac: 0.25, deflection: 0 } })).toBe(
      airfoilKeyString(key2412),
    );
  });

  it('evicts the least recently used models beyond capacity', () => {
    const first = getAirfoilModel({ ...key2412, params: { ...key2412.params, thickness: 0.101 } });
    for (let i = 0; i < 40; i++) {
      getAirfoilModel({ ...key2412, params: { ...key2412.params, thickness: 0.05 + i * 0.001 } });
    }
    const again = getAirfoilModel({ ...key2412, params: { ...key2412.params, thickness: 0.101 } });
    expect(again).not.toBe(first);
  });
});

describe('chordwise Cp', () => {
  const model = getAirfoilModel(key2412);

  it('samples cosine-spaced stations with suction on top at positive lift', () => {
    const cp = model.chordwiseCp(5 * DEG, RE);
    expect(cp.xc.length).toBe(41);
    expect(cp.xc[0]).toBe(0);
    expect(cp.xc[40]).toBeCloseTo(1, 6);
    expect(cp.xc[1]! - cp.xc[0]!).toBeLessThan(cp.xc[21]! - cp.xc[20]!);
    expect(Math.min(...cp.upper)).toBeLessThan(-1);
    expect(cp.upper[0]).toBeCloseTo(cp.lower[0]!, 6);
    expect(cp.upper[40]).toBeCloseTo(cp.lower[40]!, 6);
    for (let k = 5; k < 36; k++) expect(cp.upper[k]).toBeLessThan(cp.lower[k]!);
  });

  it('integrates to the viscous section cl', () => {
    for (const a of [0, 4, 8]) {
      const cp = model.chordwiseCp(a * DEG, RE, 81);
      const cl = model.polar.cl(a * DEG, RE);
      expect(integrate(cp.xc, cp.upper, cp.lower)).toBeCloseTo(cl, 1);
    }
  });

  it('scales to a target cl', () => {
    const cp = model.chordwiseCp(6 * DEG, RE, 41, 0.4);
    expect(integrate(cp.xc, cp.upper, cp.lower)).toBeCloseTo(0.4, 2);
    const zero = model.chordwiseCp(6 * DEG, RE, 41, -0.5);
    for (let k = 0; k < 41; k++) expect(zero.upper[k]).toBeCloseTo(zero.lower[k]!, 6);
  });

  it('flattens the upper surface aft of separation when stalled', () => {
    const as = model.polar.alphaStall(RE);
    const cp = model.chordwiseCp(as + 6 * DEG, RE);
    const f = model.polar.attachedFraction(as + 6 * DEG, RE);
    expect(f).toBeLessThan(0.5);
    const aft = [] as number[];
    for (let k = 0; k < cp.xc.length; k++) if (cp.xc[k]! > f + 0.02) aft.push(cp.upper[k]!);
    expect(aft.length).toBeGreaterThan(5);
    for (const v of aft) expect(v).toBeCloseTo(aft[0]!, 6);
    // Softened suction peak compared with the attached case at the same lift.
    const attached = model.chordwiseCp(4 * DEG, RE);
    expect(Math.min(...cp.upper)).toBeGreaterThan(Math.min(...attached.upper) - 3);
  });

  it('is fast after warm-up', () => {
    model.chordwiseCp(3 * DEG, RE);
    const t0 = performance.now();
    const reps = 600;
    for (let i = 0; i < reps; i++) model.chordwiseCp((i % 25) * DEG, RE * (1 + (i % 7)), 41, 0.5);
    const per = (performance.now() - t0) / reps;
    // eslint-disable-next-line no-console -- timing log requested for perf tracking
    console.info(`chordwiseCp: ${(per * 1000).toFixed(1)} us per call`);
    expect(per).toBeLessThan(0.6); // target < 0.2 ms
  });
});
