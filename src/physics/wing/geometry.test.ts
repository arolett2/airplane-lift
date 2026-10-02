import { describe, expect, it } from 'vitest';
import type { LiftingSurface, WingGeometry, WingSection } from '../types';
import { DEFAULT_WING, NO_TIP_DEVICE, TIP_DEVICE_DEFAULTS } from '../../state/params';
import type { TipDeviceKind, WingConfig } from '../../state/params';
import {
  buildWingGeometry,
  interpolateSection,
  sectionFrame,
  sectionTrailingEdge,
} from './geometry';

const DEG = Math.PI / 180;

/** A swept, tapered airliner-like wing used by most tests. */
const AIRLINER: WingConfig = {
  ...DEFAULT_WING,
  span: 34,
  rootChord: 6,
  taperRatio: 0.25,
  sweepDeg: 25,
  dihedralDeg: 5,
  rootIncidenceDeg: 2,
  washoutDeg: 3,
  airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
};

function surfaceById(g: WingGeometry, id: string): LiftingSurface {
  const s = g.surfaces.find((x) => x.id === id);
  if (!s) throw new Error(`no surface ${id}`);
  return s;
}

const quarterChordX = (s: WingSection): number => s.le[0] + s.chord / 4;

/** Assert that every left surface is the exact y -> -y mirror of its right-hand twin. */
function expectMirrorSymmetric(g: WingGeometry): void {
  const rights = g.surfaces.filter((s) => s.side === 'right');
  expect(rights.length).toBeGreaterThan(0);
  expect(g.surfaces.length).toBe(2 * rights.length);
  for (const r of rights) {
    const l = surfaceById(g, r.id.replace(/-right$/, '-left'));
    expect(l.side).toBe('left');
    expect(l.role).toBe(r.role);
    expect(l.sections.length).toBe(r.sections.length);
    r.sections.forEach((rs, i) => {
      const ls = l.sections[i]!;
      expect(ls.le[0]).toBeCloseTo(rs.le[0], 12);
      expect(ls.le[1]).toBeCloseTo(-rs.le[1], 12);
      expect(ls.le[2]).toBeCloseTo(rs.le[2], 12);
      expect(ls.chord).toBe(rs.chord);
      expect(ls.twist).toBe(rs.twist);
      expect(ls.roll).toBe(rs.roll);
      expect(ls.airfoil).toEqual(rs.airfoil);
      expect(ls.flap).toEqual(rs.flap);
      expect(ls.slat).toBe(rs.slat);
      // Section axes mirror too: the left TE is the mirror of the right TE.
      const rte = sectionTrailingEdge(rs, 'right');
      const lte = sectionTrailingEdge(ls, 'left');
      expect(lte[0]).toBeCloseTo(rte[0], 12);
      expect(lte[1]).toBeCloseTo(-rte[1], 12);
      expect(lte[2]).toBeCloseTo(rte[2], 12);
    });
  }
}

describe('reference quantities', () => {
  const g = buildWingGeometry(AIRLINER);

  it('computes trapezoid area, aspect ratio and mean aerodynamic chord', () => {
    const lambda = 0.25;
    const S = (34 * 6 * (1 + lambda)) / 2; // 127.5 m^2
    expect(g.referenceArea).toBeCloseTo(S, 10);
    expect(g.referenceSpan).toBe(34);
    expect(g.aspectRatio).toBeCloseTo((34 * 34) / S, 10);
    expect(g.meanAeroChord).toBeCloseTo(
      ((2 / 3) * 6 * (1 + lambda + lambda ** 2)) / (1 + lambda),
      10,
    );
    expect(g.sweepQuarterChord).toBeCloseTo(25 * DEG, 12);
  });

  it('puts the pivot on the root quarter chord', () => {
    expect(g.pivot).toEqual([1.5, 0, 0]);
  });

  it('matches the rectangular-wing identities', () => {
    const rect = buildWingGeometry({ ...DEFAULT_WING, span: 10, rootChord: 1.5, taperRatio: 1 });
    expect(rect.referenceArea).toBeCloseTo(15, 12);
    expect(rect.aspectRatio).toBeCloseTo(100 / 15, 12);
    expect(rect.meanAeroChord).toBeCloseTo(1.5, 12);
    expect(rect.overallSpan).toBeCloseTo(10, 12);
  });

  it('has overall span equal to the span when there is no tip device', () => {
    expect(g.overallSpan).toBeCloseTo(34, 1);
  });

  it('excludes the Yehudi and tip devices from the reference area', () => {
    const fancy = buildWingGeometry({
      ...AIRLINER,
      yehudi: { spanFrac: 0.3, chordFrac: 0.4 },
      tipDevice: TIP_DEVICE_DEFAULTS['blended-winglet'],
    });
    expect(fancy.referenceArea).toBeCloseTo(g.referenceArea, 10);
    expect(fancy.referenceSpan).toBe(34);
    expect(fancy.aspectRatio).toBeCloseTo(g.aspectRatio, 10);
  });

  it('computes the wetted area of a flat rectangular wing as 2 (1 + 0.25 t/c) S', () => {
    const rect = buildWingGeometry({
      ...DEFAULT_WING,
      span: 10,
      rootChord: 2,
      taperRatio: 1,
      airfoil: { camber: 0, camberPos: 0.4, thickness: 0.12 },
    });
    expect(rect.wettedArea).toBeCloseTo(2 * (1 + 0.25 * 0.12) * 20, 10);
  });

  it('counts the span-tangent length for a dihedral wing', () => {
    const flat = buildWingGeometry({ ...DEFAULT_WING, taperRatio: 1 });
    const dihedral = buildWingGeometry({ ...DEFAULT_WING, taperRatio: 1, dihedralDeg: 10 });
    expect(dihedral.wettedArea).toBeCloseTo(flat.wettedArea / Math.cos(10 * DEG), 8);
  });

  it('adds device area to the wetted area', () => {
    const bare = buildWingGeometry(AIRLINER);
    const withDevice = buildWingGeometry({
      ...AIRLINER,
      tipDevice: TIP_DEVICE_DEFAULTS['blended-winglet'],
    });
    expect(withDevice.wettedArea).toBeGreaterThan(bare.wettedArea);
  });
});

describe('base wing planform', () => {
  const g = buildWingGeometry(AIRLINER);
  const right = surfaceById(g, 'wing-right');
  const left = surfaceById(g, 'wing-left');

  it('creates the two wing surfaces with the documented ids and roles', () => {
    expect(right.role).toBe('wing');
    expect(right.side).toBe('right');
    expect(left.role).toBe('wing');
    expect(left.side).toBe('left');
    expect(g.surfaces.filter((s) => s.role === 'tip-device')).toHaveLength(0);
  });

  it('starts at the origin with the root chord and ends at the semispan with the tip chord', () => {
    const root = right.sections[0]!;
    const tip = right.sections[right.sections.length - 1]!;
    expect(root.le).toEqual([0, 0, 0]);
    expect(root.chord).toBeCloseTo(6, 12);
    expect(tip.le[1]).toBeCloseTo(17, 12);
    expect(tip.chord).toBeCloseTo(1.5, 12);
  });

  it('orders sections root -> tip', () => {
    for (let i = 1; i < right.sections.length; i++) {
      expect(right.sections[i]!.le[1]).toBeGreaterThan(right.sections[i - 1]!.le[1]);
    }
  });

  it('moves the leading edge aft going outboard for positive sweep', () => {
    for (let i = 1; i < right.sections.length; i++) {
      expect(right.sections[i]!.le[0]).toBeGreaterThan(right.sections[i - 1]!.le[0]);
    }
  });

  it('recovers the quarter-chord sweep from the sections', () => {
    for (const sweepDeg of [-10, 0, 25, 45, 60]) {
      const geo = buildWingGeometry({ ...AIRLINER, sweepDeg, flaps: { ...AIRLINER.flaps } });
      const secs = surfaceById(geo, 'wing-right').sections;
      const root = secs[0]!;
      const tip = secs[secs.length - 1]!;
      const slope = (quarterChordX(tip) - quarterChordX(root)) / (tip.le[1] - root.le[1]);
      expect(slope).toBeCloseTo(Math.tan(sweepDeg * DEG), 10);
      expect(quarterChordX(root)).toBeCloseTo(6 / 4, 12);
    }
  });

  it('keeps the quarter-chord line straight through inserted stations', () => {
    const geo = buildWingGeometry({
      ...AIRLINER,
      flaps: { deflectionDeg: 10, chordFrac: 0.25, spanFrac: 0.55 },
    });
    const secs = surfaceById(geo, 'wing-right').sections;
    expect(secs).toHaveLength(3);
    const tanSweep = Math.tan(25 * DEG);
    for (const s of secs) {
      expect(quarterChordX(s)).toBeCloseTo(1.5 + s.le[1] * tanSweep, 10);
    }
  });

  it('tapers the chord linearly in y', () => {
    const geo = buildWingGeometry({
      ...AIRLINER,
      flaps: { deflectionDeg: 10, chordFrac: 0.25, spanFrac: 0.4 },
    });
    for (const s of surfaceById(geo, 'wing-right').sections) {
      expect(s.chord).toBeCloseTo(6 + (1.5 - 6) * (s.le[1] / 17), 10);
    }
  });

  it('lifts the sections by y tan(dihedral) and rolls them by the dihedral', () => {
    for (const s of right.sections) {
      expect(s.le[2]).toBeCloseTo(s.le[1] * Math.tan(5 * DEG), 12);
      expect(s.roll).toBeCloseTo(5 * DEG, 12);
    }
    const anhedral = buildWingGeometry({ ...AIRLINER, dihedralDeg: -8 });
    const tip = surfaceById(anhedral, 'wing-right').sections.at(-1)!;
    expect(tip.le[2]).toBeLessThan(0);
  });

  it('sets incidence to the root incidence minus linear washout', () => {
    const secs = right.sections;
    expect(secs[0]!.twist).toBeCloseTo(2 * DEG, 12);
    expect(secs[secs.length - 1]!.twist).toBeCloseTo(-1 * DEG, 12);
    const mid = interpolateSection(right, 0.5);
    expect(mid.twist).toBeCloseTo(0.5 * DEG, 12);
  });

  it('applies the airfoil everywhere', () => {
    const geo = buildWingGeometry({
      ...AIRLINER,
      airfoil: { camber: 0.04, camberPos: 0.5, thickness: 0.09 },
    });
    for (const surf of geo.surfaces) {
      for (const s of surf.sections) {
        expect(s.airfoil).toEqual({ camber: 0.04, camberPos: 0.5, thickness: 0.09 });
      }
    }
  });

  it('does not share airfoil objects with the config or between sections', () => {
    const airfoil = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };
    const geo = buildWingGeometry({ ...AIRLINER, airfoil });
    const a = surfaceById(geo, 'wing-right').sections[0]!.airfoil;
    const b = surfaceById(geo, 'wing-left').sections[0]!.airfoil;
    expect(a).not.toBe(airfoil);
    expect(a).not.toBe(b);
  });

  it('mirrors exactly to the left wing', () => {
    expectMirrorSymmetric(g);
    expect(left.sections[0]!.le[1]).toBe(0);
    expect(Object.is(left.sections[0]!.le[1], -0)).toBe(false);
  });
});

describe('Yehudi', () => {
  const config: WingConfig = {
    ...AIRLINER,
    sweepDeg: 30,
    yehudi: { spanFrac: 0.3, chordFrac: 0.4 },
  };
  const g = buildWingGeometry(config);
  const secs = surfaceById(g, 'wing-right').sections;

  it('widens only the root chord and keeps the leading edge', () => {
    expect(secs).toHaveLength(3);
    expect(secs[0]!.chord).toBeCloseTo(6 * 1.4, 12);
    expect(secs[0]!.le).toEqual([0, 0, 0]);
  });

  it('puts the kink on the reference trapezoid', () => {
    const yk = 0.3 * 17;
    const kink = secs[1]!;
    expect(kink.le[1]).toBeCloseTo(yk, 12);
    expect(kink.chord).toBeCloseTo(6 + (1.5 - 6) * 0.3, 12);
    // Leading edge lies on the same straight line as without the Yehudi.
    const plain = buildWingGeometry({ ...config, yehudi: { spanFrac: 0, chordFrac: 0 } });
    const plainTip = surfaceById(plain, 'wing-right').sections.at(-1)!;
    expect(secs.at(-1)!.le[0]).toBeCloseTo(plainTip.le[0], 12);
    const tanLe = (plainTip.le[0] - 0) / 17;
    expect(kink.le[0]).toBeCloseTo(yk * tanLe, 12);
  });

  it('keeps the trailing edge straight from the root to the kink', () => {
    const teRoot = secs[0]!.le[0] + secs[0]!.chord;
    const teKink = secs[1]!.le[0] + secs[1]!.chord;
    // A flap station inside the Yehudi region must lie on that straight TE.
    const withFlap = buildWingGeometry({
      ...config,
      flaps: { deflectionDeg: 10, chordFrac: 0.25, spanFrac: 0.15 },
    });
    const s = surfaceById(withFlap, 'wing-right').sections;
    expect(s).toHaveLength(4);
    const f = s[1]!;
    const y = f.le[1];
    const teExpected = teRoot + ((teKink - teRoot) * y) / secs[1]!.le[1];
    expect(f.le[0] + f.chord).toBeCloseTo(teExpected, 10);
    expect(f.chord).toBeGreaterThan(secs[1]!.chord);
    expect(f.chord).toBeLessThan(secs[0]!.chord);
  });

  it('is disabled when either parameter is zero', () => {
    for (const yehudi of [
      { spanFrac: 0, chordFrac: 0.4 },
      { spanFrac: 0.3, chordFrac: 0 },
    ]) {
      const s = surfaceById(buildWingGeometry({ ...config, yehudi }), 'wing-right').sections;
      expect(s).toHaveLength(2);
      expect(s[0]!.chord).toBeCloseTo(6, 12);
    }
  });

  it('adds wetted area', () => {
    const plain = buildWingGeometry({ ...config, yehudi: { spanFrac: 0, chordFrac: 0 } });
    expect(g.wettedArea).toBeGreaterThan(plain.wettedArea);
  });

  it('mirrors', () => expectMirrorSymmetric(g));
});

describe('flaps and slats', () => {
  const flapped: WingConfig = {
    ...AIRLINER,
    flaps: { deflectionDeg: 25, chordFrac: 0.3, spanFrac: 0.6 },
  };

  it('has no flaps when retracted', () => {
    const g = buildWingGeometry({ ...flapped, flaps: { ...flapped.flaps, deflectionDeg: 0 } });
    const secs = surfaceById(g, 'wing-right').sections;
    expect(secs).toHaveLength(2);
    for (const s of secs) expect(s.flap).toBeNull();
    for (let i = 0; i < secs.length - 1; i += 0.25) {
      expect(interpolateSection(surfaceById(g, 'wing-right'), i).flap).toBeNull();
    }
  });

  it('inserts a station at the flap end and flags the sections inboard of it', () => {
    const g = buildWingGeometry(flapped);
    const right = surfaceById(g, 'wing-right');
    expect(right.sections).toHaveLength(3);
    const [root, end, tip] = right.sections as [WingSection, WingSection, WingSection];
    expect(end.le[1]).toBeCloseTo(0.6 * 17, 12);
    const expectedFlap = { chordFrac: 0.3, deflection: 25 * DEG };
    expect(root.flap).toEqual(expectedFlap);
    expect(end.flap).toEqual(expectedFlap);
    expect(tip.flap).toBeNull();
    expect(surfaceById(g, 'wing-left').sections.map((s) => s.flap !== null)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('flaps a segment only when both ends carry a flap (via interpolateSection)', () => {
    const right = surfaceById(buildWingGeometry(flapped), 'wing-right');
    // Segment 0 (root -> flap end): both ends flapped.
    for (const s of [0, 0.25, 0.5, 0.99]) {
      const sec = interpolateSection(right, s);
      expect(sec.flap).toEqual({ chordFrac: 0.3, deflection: 25 * DEG });
    }
    // Segment 1 (flap end -> tip): outboard end has none.
    for (const s of [1, 1.25, 1.5, 2]) {
      expect(interpolateSection(right, s).flap).toBeNull();
    }
  });

  it('does not insert a duplicate station when the flap end meets the Yehudi kink', () => {
    const g = buildWingGeometry({
      ...flapped,
      yehudi: { spanFrac: 0.6, chordFrac: 0.3 },
    });
    const secs = surfaceById(g, 'wing-right').sections;
    expect(secs).toHaveLength(3);
    expect(secs[1]!.flap).not.toBeNull();
    expect(secs[2]!.flap).toBeNull();
  });

  it('flaps the whole wing when the flap runs to the tip', () => {
    const g = buildWingGeometry({ ...flapped, flaps: { ...flapped.flaps, spanFrac: 1 } });
    const secs = surfaceById(g, 'wing-right').sections;
    expect(secs).toHaveLength(2);
    for (const s of secs) expect(s.flap).not.toBeNull();
  });

  it('deploys slats on every base-wing section and only those', () => {
    const g = buildWingGeometry({
      ...flapped,
      slats: true,
      tipDevice: TIP_DEVICE_DEFAULTS['blended-winglet'],
    });
    for (const surf of g.surfaces) {
      for (const s of surf.sections) expect(s.slat).toBe(surf.role === 'wing');
    }
    const off = buildWingGeometry({ ...flapped, slats: false });
    for (const surf of off.surfaces) for (const s of surf.sections) expect(s.slat).toBe(false);
  });

  it('keeps tip-device sections free of flaps', () => {
    const g = buildWingGeometry({
      ...flapped,
      flaps: { ...flapped.flaps, spanFrac: 1 },
      tipDevice: TIP_DEVICE_DEFAULTS['blended-winglet'],
    });
    for (const surf of g.surfaces.filter((s) => s.role === 'tip-device')) {
      for (const s of surf.sections) expect(s.flap).toBeNull();
    }
  });

  it('mirrors', () => expectMirrorSymmetric(buildWingGeometry(flapped)));
});

describe('interpolateSection', () => {
  const right = surfaceById(buildWingGeometry(AIRLINER), 'wing-right');

  it('returns the end sections at integer parameters', () => {
    const a = interpolateSection(right, 0);
    expect(a.le).toEqual(right.sections[0]!.le);
    expect(a.chord).toBe(right.sections[0]!.chord);
    const b = interpolateSection(right, 1);
    expect(b.le).toEqual(right.sections[1]!.le);
    expect(b.chord).toBe(right.sections[1]!.chord);
  });

  it('interpolates linearly inside a segment', () => {
    const [a, b] = right.sections as [WingSection, WingSection];
    const m = interpolateSection(right, 0.3);
    expect(m.le[0]).toBeCloseTo(a.le[0] * 0.7 + b.le[0] * 0.3, 12);
    expect(m.le[1]).toBeCloseTo(a.le[1] * 0.7 + b.le[1] * 0.3, 12);
    expect(m.le[2]).toBeCloseTo(a.le[2] * 0.7 + b.le[2] * 0.3, 12);
    expect(m.chord).toBeCloseTo(a.chord * 0.7 + b.chord * 0.3, 12);
    expect(m.twist).toBeCloseTo(a.twist * 0.7 + b.twist * 0.3, 12);
    expect(m.roll).toBeCloseTo(a.roll, 12);
  });

  it('interpolates the airfoil', () => {
    const surface: LiftingSurface = {
      ...right,
      sections: [
        { ...right.sections[0]!, airfoil: { camber: 0, camberPos: 0.2, thickness: 0.1 } },
        { ...right.sections[1]!, airfoil: { camber: 0.04, camberPos: 0.6, thickness: 0.2 } },
      ],
    };
    const m = interpolateSection(surface, 0.5);
    expect(m.airfoil.camber).toBeCloseTo(0.02, 12);
    expect(m.airfoil.camberPos).toBeCloseTo(0.4, 12);
    expect(m.airfoil.thickness).toBeCloseTo(0.15, 12);
  });

  it('clamps out-of-range parameters to the end sections', () => {
    expect(interpolateSection(right, -3).le).toEqual(right.sections[0]!.le);
    expect(interpolateSection(right, 99).le).toEqual(right.sections.at(-1)!.le);
  });

  it('requires both ends for slats too', () => {
    const [a, b] = right.sections as [WingSection, WingSection];
    const mk = (sa: boolean, sb: boolean): LiftingSurface => ({
      ...right,
      sections: [
        { ...a, slat: sa },
        { ...b, slat: sb },
      ],
    });
    expect(interpolateSection(mk(true, true), 0.5).slat).toBe(true);
    expect(interpolateSection(mk(true, false), 0.5).slat).toBe(false);
    expect(interpolateSection(mk(false, true), 0.5).slat).toBe(false);
  });

  it('returns fresh objects, not references into the surface', () => {
    const m = interpolateSection(right, 0);
    expect(m.le).not.toBe(right.sections[0]!.le);
    expect(m.airfoil).not.toBe(right.sections[0]!.airfoil);
  });
});

describe('sectionFrame', () => {
  it('is orthonormal and matches the documented right-hand axes', () => {
    const sec: WingSection = {
      le: [0, 3, 0.3],
      chord: 2,
      twist: 0.1,
      roll: 0.4,
      airfoil: AIRLINER.airfoil,
      flap: null,
      slat: false,
    };
    const f = sectionFrame(sec, 'right');
    expect(f.tangent[1]).toBeCloseTo(Math.cos(0.4), 12);
    expect(f.tangent[2]).toBeCloseTo(Math.sin(0.4), 12);
    expect(f.normal[1]).toBeCloseTo(-Math.sin(0.4), 12);
    expect(f.normal[2]).toBeCloseTo(Math.cos(0.4), 12);
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    expect(dot(f.chordDir, f.chordDir)).toBeCloseTo(1, 12);
    expect(dot(f.chordDir, f.tangent)).toBeCloseTo(0, 12);
    expect(dot(f.tangent, f.normal)).toBeCloseTo(0, 12);
  });

  it('raises the leading edge for positive twist on a flat wing', () => {
    const sec: WingSection = {
      le: [0, 1, 0],
      chord: 1,
      twist: 10 * DEG,
      roll: 0,
      airfoil: AIRLINER.airfoil,
      flap: null,
      slat: false,
    };
    for (const side of ['right', 'left'] as const) {
      const te = sectionTrailingEdge(sec, side);
      expect(te[2]).toBeLessThan(0); // TE below LE = nose up
      expect(te[0]).toBeCloseTo(Math.cos(10 * DEG), 12);
    }
  });
});

describe('robustness across the slider range', () => {
  const kinds = Object.keys(TIP_DEVICE_DEFAULTS) as TipDeviceKind[];

  function expectValid(g: WingGeometry): void {
    for (const v of [
      g.referenceArea,
      g.referenceSpan,
      g.meanAeroChord,
      g.aspectRatio,
      g.overallSpan,
      g.wettedArea,
      g.sweepQuarterChord,
      ...g.pivot,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(g.referenceArea).toBeGreaterThan(0);
    expect(g.wettedArea).toBeGreaterThan(0);
    expect(g.overallSpan).toBeGreaterThanOrEqual(g.referenceSpan - 1e-9);
    for (const surf of g.surfaces) {
      expect(surf.sections.length).toBeGreaterThanOrEqual(2);
      surf.sections.forEach((s, i) => {
        for (const v of [...s.le, s.chord, s.twist, s.roll]) expect(Number.isFinite(v)).toBe(true);
        expect(s.chord).toBeGreaterThan(0);
        if (i > 0) {
          const p = surf.sections[i - 1]!;
          const len = Math.hypot(s.le[0] - p.le[0], s.le[1] - p.le[1], s.le[2] - p.le[2]);
          expect(len).toBeGreaterThan(1e-9);
        }
      });
    }
  }

  it('stays finite with positive chords for extreme planforms and every tip device', () => {
    let count = 0;
    for (const span of [4, 12, 90]) {
      for (const taperRatio of [0.1, 0.5, 1]) {
        for (const sweepDeg of [-10, 0, 60]) {
          for (const kind of kinds) {
            for (const size of [0.005, 0.1, 0.2]) {
              const cfg: WingConfig = {
                ...DEFAULT_WING,
                span,
                rootChord: span > 50 ? 12 : 1.2,
                taperRatio,
                sweepDeg,
                dihedralDeg: sweepDeg === 60 ? 15 : -10,
                washoutDeg: 10,
                rootIncidenceDeg: 8,
                yehudi: { spanFrac: 0.5, chordFrac: 0.6 },
                flaps: { deflectionDeg: 40, chordFrac: 0.4, spanFrac: 0.9 },
                slats: true,
                tipDevice:
                  kind === 'none'
                    ? NO_TIP_DEVICE
                    : {
                        ...TIP_DEVICE_DEFAULTS[kind],
                        size,
                        taper: 0.1,
                        sweepDeg: 70,
                        cantDeg: size > 0.1 ? 90 : 0,
                        toeDeg: -8,
                      },
              };
              const g = buildWingGeometry(cfg);
              expectValid(g);
              expectMirrorSymmetric(g);
              count++;
            }
          }
        }
      }
    }
    expect(count).toBeGreaterThan(100);
  });

  it('handles the minimum span with tiny tip devices', () => {
    const g = buildWingGeometry({
      ...DEFAULT_WING,
      span: 4,
      rootChord: 0.3,
      taperRatio: 0.1,
      sweepDeg: 60,
      tipDevice: { ...TIP_DEVICE_DEFAULTS['split-winglet'], size: 0.005 },
    });
    expectValid(g);
  });

  it('handles a stubby wing at the largest root chord', () => {
    for (const kind of kinds) {
      const g = buildWingGeometry({
        ...DEFAULT_WING,
        span: 4,
        rootChord: 20,
        taperRatio: 0.1,
        sweepDeg: 60,
        yehudi: { spanFrac: 0.5, chordFrac: 0.6 },
        flaps: { deflectionDeg: 40, chordFrac: 0.4, spanFrac: 0.5 },
        tipDevice: kind === 'none' ? NO_TIP_DEVICE : { ...TIP_DEVICE_DEFAULTS[kind], size: 0.2 },
      });
      expectValid(g);
      expectMirrorSymmetric(g);
    }
  });

  it('is deterministic and does not mutate the config', () => {
    const cfg: WingConfig = { ...AIRLINER, tipDevice: TIP_DEVICE_DEFAULTS['canted-winglet'] };
    const snapshot = JSON.stringify(cfg);
    const a = buildWingGeometry(cfg);
    const b = buildWingGeometry(cfg);
    expect(JSON.stringify(cfg)).toBe(snapshot);
    expect(a).toEqual(b);
  });
});
