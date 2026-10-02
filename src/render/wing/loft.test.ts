import { describe, expect, it } from 'vitest';
import { makeTestWing } from '../util/testFixtures';
import { VERTEX_CAP, VERTEX_SKIN, VERTEX_SLAT, loftSurface, loftWing, sectionAxes } from './loft';
import type { LoftedWing } from './loft';
import type { Vec3 } from '../../physics/types';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Volume enclosed by the triangles (divergence theorem), optionally restricted to a vertex range. */
function meshVolume(m: LoftedWing, surface?: number, kind?: number): number {
  const p = m.positions;
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]!;
    if (surface !== undefined && m.surfaceIndex[a] !== surface) continue;
    if (kind !== undefined && m.kind[a] !== kind) continue;
    const b = m.indices[t + 1]!;
    const c = m.indices[t + 2]!;
    const ax = p[3 * a]!;
    const ay = p[3 * a + 1]!;
    const az = p[3 * a + 2]!;
    const bx = p[3 * b]!;
    const by = p[3 * b + 1]!;
    const bz = p[3 * b + 2]!;
    const cx = p[3 * c]!;
    const cy = p[3 * c + 1]!;
    const cz = p[3 * c + 2]!;
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

describe('sectionAxes', () => {
  it('gives orthonormal axes for any roll and twist, on both sides', () => {
    for (const side of ['right', 'left'] as const) {
      for (const roll of [0, 0.3, 1.2, Math.PI / 2, -Math.PI / 2]) {
        for (const twist of [0, 0.1, -0.2]) {
          const c: Vec3 = [0, 0, 0];
          const n: Vec3 = [0, 0, 0];
          sectionAxes(roll, twist, side, c, n);
          expect(Math.hypot(...c)).toBeCloseTo(1, 12);
          expect(Math.hypot(...n)).toBeCloseTo(1, 12);
          expect(dot(c, n)).toBeCloseTo(0, 12);
        }
      }
    }
  });

  it('flat wing: positive twist lowers the trailing edge (nose up) and keeps the normal up-ish', () => {
    const c: Vec3 = [0, 0, 0];
    const n: Vec3 = [0, 0, 0];
    sectionAxes(0, 0.2, 'right', c, n);
    expect(c[2]).toBeLessThan(0); // TE below the LE
    expect(n[0]).toBeGreaterThan(0); // upper-surface normal leans aft
    expect(n[2]).toBeGreaterThan(0.9);
  });

  it('left side mirrors the right side in y only', () => {
    const cr: Vec3 = [0, 0, 0];
    const nr: Vec3 = [0, 0, 0];
    const cl: Vec3 = [0, 0, 0];
    const nl: Vec3 = [0, 0, 0];
    sectionAxes(0.4, 0.15, 'right', cr, nr);
    sectionAxes(0.4, 0.15, 'left', cl, nl);
    expect(cl).toEqual([cr[0], -cr[1], cr[2]]);
    expect(nl).toEqual([nr[0], -nr[1], nr[2]]);
  });

  it('matches the documented right-hand formulas', () => {
    // t = (0, cos r, sin r); chordDir = x rotated about t by twist; n = (0, -sin r, cos r) untwisted.
    const r = 0.5;
    const c: Vec3 = [0, 0, 0];
    const n: Vec3 = [0, 0, 0];
    sectionAxes(r, 0, 'right', c, n);
    expect(c).toEqual([1, 0, -0]);
    expect(n[1]).toBeCloseTo(-Math.sin(r), 12);
    expect(n[2]).toBeCloseTo(Math.cos(r), 12);
  });
});

describe('loftWing: plain trapezoid', () => {
  const geo = makeTestWing({ flap: null, slats: false });
  const m = loftWing(geo);

  it('has the expected vertex and ring structure', () => {
    expect(m.surfaces).toHaveLength(2);
    const s = m.surfaces[0]!;
    expect(s.ringSize).toBe(81);
    expect(s.ringCount).toBe(21); // 2 segments x 10 subdivisions, shared middle ring
    // rings + tip cap (root of a wing at y=0 is left open)
    expect(s.vertexCount).toBe(21 * 81 + 81);
    expect(m.vertexCount).toBe(m.surfaces[0]!.vertexCount + m.surfaces[1]!.vertexCount);
  });

  it('produces valid, finite, unit-normal data', () => {
    expect(m.indices.length % 3).toBe(0);
    for (const idx of m.indices) expect(idx).toBeLessThan(m.vertexCount);
    for (const x of m.positions) expect(Number.isFinite(x)).toBe(true);
    for (let v = 0; v < m.vertexCount; v++) {
      const len = Math.hypot(m.normals[3 * v]!, m.normals[3 * v + 1]!, m.normals[3 * v + 2]!);
      expect(len).toBeCloseTo(1, 5);
    }
    for (const x of m.u) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1 + 1e-6);
    }
    for (const x of m.xc) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('closes the airfoil contour at the trailing edge on every ring', () => {
    for (const s of m.surfaces) {
      for (let r = 0; r < s.ringCount; r++) {
        const a = s.vertexStart + r * s.ringSize;
        const b = a + s.ringSize - 1;
        for (let k = 0; k < 3; k++) {
          expect(m.positions[3 * a + k]).toBeCloseTo(m.positions[3 * b + k]!, 6);
        }
        // first vertex is the lower TE, last the upper TE; the LE vertex is upper-flagged
        expect(m.upper[a]).toBe(0);
        expect(m.upper[b]).toBe(1);
        expect(m.xc[a]).toBeCloseTo(1, 6);
        expect(m.xc[a + 40]).toBeCloseTo(0, 6);
      }
    }
  });

  it('left surface is the exact mirror of the right surface', () => {
    const right = m.surfaces[0]!;
    const left = m.surfaces[1]!;
    expect(left.vertexCount).toBe(right.vertexCount);
    for (let i = 0; i < right.vertexCount; i++) {
      const r = right.vertexStart + i;
      const l = left.vertexStart + i;
      expect(m.positions[3 * l]).toBeCloseTo(m.positions[3 * r]!, 6);
      expect(m.positions[3 * l + 1]).toBeCloseTo(-m.positions[3 * r + 1]!, 6);
      expect(m.positions[3 * l + 2]).toBeCloseTo(m.positions[3 * r + 2]!, 6);
      expect(m.normals[3 * l]).toBeCloseTo(m.normals[3 * r]!, 4);
      expect(m.normals[3 * l + 1]).toBeCloseTo(-m.normals[3 * r + 1]!, 4);
      expect(m.normals[3 * l + 2]).toBeCloseTo(m.normals[3 * r + 2]!, 4);
    }
  });

  it('normals point outward on both sides (upper up, lower down, nose forward)', () => {
    for (const s of m.surfaces) {
      const mid = s.vertexStart + 10 * s.ringSize; // a mid-span ring
      const lowerMid = mid + 20; // x/c ~ 0.5 on the lower surface
      const upperMid = mid + 60; // x/c ~ 0.5 on the upper surface
      const le = mid + 40;
      expect(m.normals[3 * upperMid + 2]).toBeGreaterThan(0.8);
      expect(m.normals[3 * lowerMid + 2]).toBeLessThan(-0.8);
      expect(m.normals[3 * le]).toBeLessThan(-0.8);
    }
  });

  it('tip caps face outboard', () => {
    for (const s of m.surfaces) {
      const sign = s.side === 'right' ? 1 : -1;
      let found = 0;
      for (let v = s.vertexStart; v < s.vertexStart + s.vertexCount; v++) {
        if (m.kind[v] !== VERTEX_CAP) continue;
        found++;
        expect(sign * m.normals[3 * v + 1]!).toBeGreaterThan(0.9);
      }
      expect(found).toBe(81);
    }
  });

  it('encloses the volume of a NACA 2412 trapezoid wing (outward winding, correct scale)', () => {
    // Section area of a NACA 4-digit with t = 12 % is ~0.0822 c^2; V = A0 * s * (c0^2+c0c1+c1^2)/3.
    const s = 5;
    const c0 = 1.6;
    const c1 = 0.8;
    const expected = 0.0822 * s * ((c0 * c0 + c0 * c1 + c1 * c1) / 3);
    expect(meshVolume(m, 0)).toBeGreaterThan(0.97 * expected);
    expect(meshVolume(m, 0)).toBeLessThan(1.03 * expected);
    expect(meshVolume(m, 1)).toBeGreaterThan(0.97 * expected);
    expect(meshVolume(m, 1)).toBeLessThan(1.03 * expected);
  });

  it('spanwise parameter runs 0..1 monotonically along the rings', () => {
    const s = m.surfaces[0]!;
    let prev = -1;
    for (let r = 0; r < s.ringCount; r++) {
      const u = m.u[s.vertexStart + r * s.ringSize]!;
      expect(u).toBeGreaterThanOrEqual(prev);
      prev = u;
    }
    expect(m.u[s.vertexStart]).toBeCloseTo(0, 6);
    expect(m.u[s.vertexStart + (s.ringCount - 1) * s.ringSize]).toBeCloseTo(1, 6);
  });

  it('labels vertices with their surface index', () => {
    for (let i = 0; i < m.surfaces.length; i++) {
      const s = m.surfaces[i]!;
      expect(m.surfaceIndex[s.vertexStart]).toBe(i);
      expect(m.surfaceIndex[s.vertexStart + s.vertexCount - 1]).toBe(i);
    }
  });

  it('honours custom resolution', () => {
    const coarse = loftWing(geo, { contourPanels: 40, subdivisions: 4 });
    expect(coarse.surfaces[0]!.ringSize).toBe(41);
    expect(coarse.surfaces[0]!.ringCount).toBe(9);
    expect(coarse.vertexCount).toBeLessThan(m.vertexCount / 3);
  });
});

describe('loftWing: flaps', () => {
  const flap = { chordFrac: 0.3, deflection: 0.5 };
  const geo = makeTestWing({ flap });
  const m = loftWing(geo);
  const plain = loftWing(makeTestWing({ flap: null }));

  it('adds a duplicated ring at the flap end and lowers the trailing edge', () => {
    const s = m.surfaces[0]!;
    expect(s.ringCount).toBe(22);
    // Root ring: TE (vertex 0) is lower than the unflapped wing.
    const flapped = m.positions[3 * s.vertexStart + 2]!;
    const unflapped = plain.positions[3 * plain.surfaces[0]!.vertexStart + 2]!;
    expect(flapped).toBeLessThan(unflapped - 0.05);
    // The outboard (unflapped) segment returns to the plain TE height at the tip.
    const tipRing = s.vertexStart + (s.ringCount - 1) * s.ringSize;
    const plainTip = plain.surfaces[0]!.vertexStart + (plain.surfaces[0]!.ringCount - 1) * 81;
    expect(m.positions[3 * tipRing + 2]).toBeCloseTo(plain.positions[3 * plainTip + 2]!, 6);
  });

  it('stays finite with unit normals and still encloses a positive volume', () => {
    for (let v = 0; v < m.vertexCount; v++) {
      const len = Math.hypot(m.normals[3 * v]!, m.normals[3 * v + 1]!, m.normals[3 * v + 2]!);
      expect(len).toBeCloseTo(1, 5);
    }
    expect(meshVolume(m, 0)).toBeGreaterThan(0.3);
  });
});

describe('loftWing: slats', () => {
  it('adds slat slivers ahead of the leading edge only when sections have slat=true', () => {
    const without = loftWing(makeTestWing({ slats: false }));
    const withSlats = loftWing(makeTestWing({ slats: true }));
    expect(withSlats.vertexCount).toBeGreaterThan(without.vertexCount);
    let slatCount = 0;
    let minX = Infinity;
    for (let v = 0; v < withSlats.vertexCount; v++) {
      if (withSlats.kind[v] === VERTEX_SLAT) {
        slatCount++;
        if (withSlats.surfaceIndex[v] === 0) minX = Math.min(minX, withSlats.positions[3 * v]!);
      }
    }
    expect(slatCount).toBeGreaterThan(0);
    // The wing's leading edge at the root is x = 0 - slats start ahead of it (scaled by chord).
    expect(minX).toBeLessThan(-0.03);
    // Skin vertices are unaffected.
    const skinWith = Array.from(withSlats.kind).filter((k) => k === VERTEX_SKIN).length;
    const skinWithout = Array.from(without.kind).filter((k) => k === VERTEX_SKIN).length;
    expect(skinWith).toBe(skinWithout);
    const opt = loftWing(makeTestWing({ slats: true }), { slats: false });
    expect(opt.vertexCount).toBe(without.vertexCount);
  });

  it('slat slivers are closed tubes with outward winding on both sides', () => {
    const m = loftWing(makeTestWing({ slats: true }));
    // Crescent area ~ 0.0017 c^2 (a thin shell hugging the nose); two slatted segments per side.
    for (const surfaceIdx of [0, 1]) {
      const vol = meshVolume(m, surfaceIdx, VERTEX_SLAT);
      expect(vol).toBeGreaterThan(0.0005);
      expect(vol).toBeLessThan(0.05);
    }
  });
});

describe('loftWing: winglets and dihedral', () => {
  const geo = makeTestWing({ winglet: true, dihedralDeg: 5 });
  const m = loftWing(geo);

  it('lofts four surfaces and caps both ends of the tip devices', () => {
    expect(m.surfaces).toHaveLength(4);
    const wl = m.surfaces[2]!;
    expect(wl.role).toBe('tip-device');
    const caps = Array.from({ length: wl.vertexCount }, (_, i) => wl.vertexStart + i).filter(
      (v) => m.kind[v] === VERTEX_CAP,
    );
    expect(caps).toHaveLength(2 * 81);
  });

  it('winglet suction side faces inboard and the surface encloses positive volume', () => {
    // Upper-surface mid-chord vertex of the right winglet: normal ~ (0, -sin roll, cos roll).
    const wl = m.surfaces[2]!;
    const ring = wl.vertexStart + 3 * wl.ringSize;
    const upperMid = ring + 60;
    expect(m.normals[3 * upperMid + 1]).toBeLessThan(-0.7);
    const left = m.surfaces[3]!;
    const lUpper = left.vertexStart + 3 * left.ringSize + 60;
    expect(m.normals[3 * lUpper + 1]).toBeGreaterThan(0.7);
    expect(meshVolume(m, 2)).toBeGreaterThan(0);
    expect(meshVolume(m, 3)).toBeGreaterThan(0);
  });

  it('whole-wing loft equals the sum of single-surface lofts', () => {
    const single = loftSurface(geo.surfaces[0]!);
    expect(single.vertexCount).toBe(m.surfaces[0]!.vertexCount);
  });
});

describe('loftWing: robustness', () => {
  it('survives a tapered-to-point tip, twist and a single-segment surface', () => {
    const geo = makeTestWing({ tipChord: 0.02, twistTipDeg: -4, sweepDeg: 40 });
    const m = loftWing(geo);
    for (const x of m.positions) expect(Number.isFinite(x)).toBe(true);
    for (const x of m.normals) expect(Number.isFinite(x)).toBe(true);
    const base = makeTestWing();
    const two = {
      ...base,
      surfaces: [
        {
          ...base.surfaces[0]!,
          sections: [base.surfaces[0]!.sections[0]!, base.surfaces[0]!.sections[2]!],
        },
      ],
    };
    const m2 = loftWing(two);
    expect(m2.surfaces[0]!.ringCount).toBe(11);
  });

  it('ignores surfaces with fewer than two sections', () => {
    const base = makeTestWing();
    const bad = {
      ...base,
      surfaces: [{ ...base.surfaces[0]!, sections: [base.surfaces[0]!.sections[0]!] }],
    };
    const m = loftWing(bad);
    expect(m.vertexCount).toBe(0);
  });
});
