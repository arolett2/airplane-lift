import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../types';
import { bodyToTunnel } from '../math/frames';
import { camberLine } from '../airfoil/naca';
import { createWingSolidTester, isInsideWing } from './index';
import { WingSolid } from './solid';
import { makeTestWing } from './testFixtures';

const deg = Math.PI / 180;

describe('createWingSolidTester', () => {
  const wing = makeTestWing({
    span: 10,
    rootChord: 2,
    tipChord: 1,
    sweep: 20 * deg,
    dihedral: 5 * deg,
    winglet: { height: 1, taper: 0.5 },
  });
  const alpha = 8 * deg;
  const inside = createWingSolidTester(wing, alpha);
  const T = (p: Vec3) => bodyToTunnel(p, wing.pivot, alpha);
  const test = (p: Vec3) => {
    const q = T(p);
    return inside(q[0], q[1], q[2]);
  };

  // Body-frame helpers for the right wing at spanwise fraction s.
  const station = (s: number, side = 1) => {
    const y = s * 5;
    const chord = 2 + (1 - 2) * s;
    const le: Vec3 = [y * Math.tan(20 * deg), side * y, y * Math.tan(5 * deg)];
    return { le, chord };
  };

  it('finds interior points on both wings', () => {
    for (const side of [1, -1]) {
      const { le, chord } = station(0.4, side);
      // Mid-chord on the camber line (NACA 2412 camber ~0.02c there).
      expect(test([le[0] + 0.4 * chord, le[1], le[2] + 0.02 * chord])).toBe(true);
      // Just inside the upper and lower surface at 30% chord.
      expect(test([le[0] + 0.3 * chord, le[1], le[2] + 0.07 * chord])).toBe(true);
      expect(test([le[0] + 0.3 * chord, le[1], le[2] - 0.035 * chord])).toBe(true);
    }
  });

  it('rejects points outside the envelope', () => {
    const { le, chord } = station(0.4);
    expect(test([le[0] + 0.3 * chord, le[1], le[2] + 0.12 * chord])).toBe(false);
    expect(test([le[0] + 0.3 * chord, le[1], le[2] - 0.08 * chord])).toBe(false);
    expect(test([le[0] - 0.02 * chord, le[1], le[2]])).toBe(false);
    expect(test([le[0] + 1.02 * chord, le[1], le[2]])).toBe(false);
    // Beyond the wingtip (but not on the winglet) and far away.
    const tip = station(1);
    expect(test([tip.le[0] + 0.5, 5.3, tip.le[2]])).toBe(false);
    expect(test([0, 0, 3])).toBe(false);
    expect(test([40, 2, 0])).toBe(false);
  });

  it('finds the inside of a vertical winglet and not beside it', () => {
    const tip = station(1);
    // Winglet section at half height: LE moved aft by 0.6 * 0.5 m, chord 0.75 m.
    const h = 0.5;
    const le: Vec3 = [tip.le[0] + 0.6 * h, 5, tip.le[2] + h];
    const chord = 0.75;
    // Winglet "up" (airfoil y) points inboard (-y) on the right side; camber ~0.02c.
    expect(test([le[0] + 0.4 * chord, le[1] - 0.02 * chord, le[2]])).toBe(true);
    expect(test([le[0] + 0.4 * chord, le[1] - 0.15 * chord, le[2]])).toBe(false);
    expect(test([le[0] + 0.4 * chord, le[1] + 0.1 * chord, le[2]])).toBe(false);
    // Left winglet mirrors it.
    expect(test([le[0] + 0.4 * chord, -le[1] + 0.02 * chord, le[2]])).toBe(true);
  });

  it('agrees with isInsideWing', () => {
    let agree = 0;
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const x = -1 + (i % 20) * 0.25;
      const y = -6 + Math.floor(i / 20) * 0.6;
      const z = ((i * 37) % 11) * 0.05 - 0.25;
      n++;
      if (inside(x, y, z) === isInsideWing(wing, alpha, x, y, z)) agree++;
    }
    expect(agree).toBe(n);
  });

  it('follows a deflected flap', () => {
    const flap = { chordFrac: 0.3, deflection: 30 * deg };
    const flapped = makeTestWing({
      span: 10,
      rootChord: 2,
      airfoil: { camber: 0, camberPos: 0.4, thickness: 0.12 },
      flap,
    });
    const t = createWingSolidTester(flapped, 0);
    // Near the TE the camber line has dropped ~0.27c * tan(30 deg) ~ 0.31 m below the chord line.
    const yc = camberLine({ camber: 0, camberPos: 0.4, thickness: 0.12 }, flap, 0.97).yc * 2;
    expect(yc).toBeLessThan(-0.25);
    expect(t(0.97 * 2, 2, yc)).toBe(true);
    expect(t(0.97 * 2, 2, 0)).toBe(false);
  });

  it('pushes points out to just above the surface', () => {
    const solid = new WingSolid(wing, alpha);
    const { le, chord } = station(0.5);
    const p = T([le[0] + 0.3 * chord, le[1], le[2] + 0.06 * chord]);
    expect(solid.contains(p[0], p[1], p[2])).toBe(true);
    const q = Float64Array.from(p);
    expect(solid.pushOut(q)).toBe(true);
    expect(solid.contains(q[0]!, q[1]!, q[2]!)).toBe(false);
    // Moved only a little (to the nearer, upper surface).
    expect(Math.hypot(q[0]! - p[0], q[1]! - p[1], q[2]! - p[2])).toBeLessThan(0.05 * chord);
    expect(q[2]!).toBeGreaterThan(p[2]);
  });
});
