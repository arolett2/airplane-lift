import { describe, expect, it } from 'vitest';
import { tunnelDomain } from '../../physics/domain';
import { makeTestWing } from './testFixtures';
import { crossCutX, stationAt, wingFraming } from './framing';
import { computeShot, extentsFromDomain, fitPoints } from './shots';
import type { Vec3 } from '../../physics/types';

describe('wingFraming', () => {
  const geo = makeTestWing({ semispan: 5, rootChord: 1.6, tipChord: 0.8, sweepDeg: 15 });

  it('bounds every surface from leading to trailing edge', () => {
    const f = wingFraming(geo, 0.35);
    expect(f.min[1]).toBeCloseTo(-5, 6);
    expect(f.max[1]).toBeCloseTo(5, 6);
    // Root leading edge is the most upstream point; a tip trailing edge the most downstream.
    expect(f.min[0]).toBeCloseTo(0, 6);
    expect(f.max[0]).toBeGreaterThan(1.6);
  });

  it('interpolates the station chord and mirrors negative etas to the left wing', () => {
    const right = stationAt(geo, 0.5);
    expect(right.chord).toBeCloseTo(1.2, 6);
    expect(right.le[1]).toBeCloseTo(2.5, 6);
    const left = stationAt(geo, -0.5);
    expect(left.le[1]).toBeCloseTo(-2.5, 6);
    expect(left.chord).toBeCloseTo(right.chord, 9);
    expect(stationAt(geo, 7).le[1]).toBeCloseTo(5, 6); // clamped
  });

  it('finds the outermost right tip, winglet included', () => {
    const plain = wingFraming(geo, 0).tip;
    const winglet = wingFraming(makeTestWing({ winglet: true }), 0).tip;
    expect(plain.le[1]).toBeCloseTo(5, 6);
    expect(winglet.le[2]).toBeGreaterThan(plain.le[2]);
  });

  it('puts the cross-flow cut behind the trailing edge', () => {
    expect(crossCutX(2, 10)).toBeGreaterThan(2);
  });
});

describe('fitPoints', () => {
  it('pulls back until every point is inside the requested share of the view', () => {
    const pts: Vec3[] = [
      [0, -4, 0],
      [0, 4, 0],
    ];
    // Looking down -x from +x: the points span 8 units across the screen.
    const d = fitPoints(pts, [0, 0, 0], [1, 0, 0], 40, 1.5, 0.5, 0.5);
    const halfW = d * Math.tan((20 * Math.PI) / 180) * 1.5;
    expect(4 / halfW).toBeCloseTo(0.5, 6);
  });
});

describe('wing-centred shots', () => {
  const geo = makeTestWing({ semispan: 15, rootChord: 4, tipChord: 1.2, sweepDeg: 25 });
  const domain = tunnelDomain(30, 4);
  const framing = wingFraming(geo, 0.35);
  const ext = extentsFromDomain(domain, geo.pivot, undefined, 15, framing);

  it('frames the wing to about two thirds of the visible width in the overview', () => {
    const aspect = 1.0; // the gap between the floating panels is roughly square
    const pose = computeShot('overview', ext, 40, aspect);
    const toCam: Vec3 = [
      pose.position[0] - pose.target[0],
      pose.position[1] - pose.target[1],
      pose.position[2] - pose.target[2],
    ];
    const dist = Math.hypot(...toCam);
    const tips: Vec3[] = [
      [ext.wing.max[0], ext.wing.min[1], ext.wing.max[2]],
      [ext.wing.max[0], ext.wing.max[1], ext.wing.max[2]],
    ];
    // The overview must not be wider than its fit (0.8 of the half-width) allows.
    expect(dist).toBeGreaterThanOrEqual(
      fitPoints(tips, pose.target, toCam, 40, aspect, 0.8, 0.75) - 1e-9,
    );
    // ...and the wing is not a small object in a big tunnel any more: far closer than the old
    // whole-tunnel framing (radius 0.4 x the tunnel diagonal).
    const oldRadius = 0.4 * Math.hypot(...ext.size);
    expect(dist).toBeLessThan(oldRadius / Math.sin((20 * Math.PI) / 180));
  });

  it('side and section look along +y at the rake station', () => {
    for (const shot of ['side', 'section'] as const) {
      const p = computeShot(shot, ext, 26, 1.2);
      expect(p.target[1]).toBeCloseTo(ext.wing.station.le[1], 9);
      expect(p.position[1]).toBeLessThan(p.target[1]);
      const c = ext.wing.station.chord;
      expect(p.target[0]).toBeGreaterThan(ext.wing.station.le[0]);
      expect(p.target[0]).toBeLessThan(ext.wing.station.le[0] + 2 * c);
    }
  });

  it('tip looks back up the wake at the right tip, from downstream', () => {
    const p = computeShot('tip', ext, 24, 1.2);
    expect(p.position[0]).toBeGreaterThan(p.target[0]);
    expect(Math.abs(p.target[1] - ext.wing.tip.le[1])).toBeLessThan(0.2 * ext.semispan);
  });
});
