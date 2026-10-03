import { describe, expect, it } from 'vitest';
import type { LiftingSurface, WingGeometry, WingSection } from '../types';
import { DEFAULT_WING, NO_TIP_DEVICE, TIP_DEVICE_DEFAULTS } from '../../state/params';
import type { TipDeviceConfig, TipDeviceKind, WingConfig } from '../../state/params';
import { buildWingGeometry, sectionFrame, sectionTrailingEdge } from './geometry';
import { buildTipDeviceSurfaces } from './tipDevices';

const DEG = Math.PI / 180;

/** Flat, untwisted wing so device twist is purely the device's own. Semispan 15 m, c_t = 1.5 m. */
const BASE: WingConfig = {
  ...DEFAULT_WING,
  span: 30,
  rootChord: 5,
  taperRatio: 0.3,
  sweepDeg: 28,
  dihedralDeg: 0,
  rootIncidenceDeg: 0,
  washoutDeg: 0,
  airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
};
const SEMISPAN = 15;
const TIP_CHORD = 1.5;

function device(kind: TipDeviceKind, overrides: Partial<TipDeviceConfig> = {}): TipDeviceConfig {
  return { ...TIP_DEVICE_DEFAULTS[kind], ...overrides };
}

function build(
  tipDevice: TipDeviceConfig,
  wing: Partial<WingConfig> = {},
): { g: WingGeometry; tip: WingSection; h: number } {
  const g = buildWingGeometry({ ...BASE, ...wing, tipDevice });
  const wingRight = g.surfaces.find((s) => s.id === 'wing-right')!;
  return { g, tip: wingRight.sections.at(-1)!, h: tipDevice.size * (g.referenceSpan / 2) };
}

function surf(g: WingGeometry, id: string): LiftingSurface {
  const s = g.surfaces.find((x) => x.id === id);
  if (!s) throw new Error(`missing surface ${id}`);
  return s;
}

/** Length of a surface measured along its span (y-z distance between consecutive sections). */
function spanPathLength(s: LiftingSurface): number {
  let total = 0;
  for (let i = 1; i < s.sections.length; i++) {
    const a = s.sections[i - 1]!;
    const b = s.sections[i]!;
    total += Math.hypot(b.le[1] - a.le[1], b.le[2] - a.le[2]);
  }
  return total;
}

const first = (s: LiftingSurface): WingSection => s.sections[0]!;
const last = (s: LiftingSurface): WingSection => s.sections.at(-1)!;

/** > 0 when the section's leading edge lies further from the centreline than its trailing edge. */
function leOutboardness(sec: WingSection, side: 'right' | 'left'): number {
  const te = sectionTrailingEdge(sec, side);
  return Math.abs(sec.le[1]) - Math.abs(te[1]);
}

function expectMirrored(g: WingGeometry, id: string): void {
  const r = surf(g, `${id}-right`);
  const l = surf(g, `${id}-left`);
  expect(r.side).toBe('right');
  expect(l.side).toBe('left');
  expect(l.role).toBe(r.role);
  expect(l.sections).toHaveLength(r.sections.length);
  r.sections.forEach((rs, i) => {
    const ls = l.sections[i]!;
    expect(ls.le[0]).toBeCloseTo(rs.le[0], 12);
    expect(ls.le[1]).toBeCloseTo(-rs.le[1], 12);
    expect(ls.le[2]).toBeCloseTo(rs.le[2], 12);
    expect(ls.chord).toBe(rs.chord);
    expect(ls.twist).toBe(rs.twist);
    expect(ls.roll).toBe(rs.roll);
    expect(ls.flap).toBeNull();
    expect(ls.slat).toBe(false);
  });
}

describe('no device', () => {
  it('builds nothing for kind none, however large the size', () => {
    const { tip } = build(NO_TIP_DEVICE);
    expect(buildTipDeviceSurfaces(tip, NO_TIP_DEVICE, SEMISPAN)).toEqual([]);
    expect(buildTipDeviceSurfaces(tip, { ...NO_TIP_DEVICE, size: 0.2 }, SEMISPAN)).toEqual([]);
  });

  it.each([
    'canted-winglet',
    'blended-winglet',
    'raked-tip',
    'split-winglet',
    'wingtip-fence',
  ] as const)('builds nothing for %s with size <= 0', (kind) => {
    const { tip } = build(NO_TIP_DEVICE);
    for (const size of [0, -0.1, NaN]) {
      expect(buildTipDeviceSurfaces(tip, device(kind, { size }), SEMISPAN)).toEqual([]);
    }
  });

  it('leaves the geometry as a bare wing', () => {
    const { g } = build(NO_TIP_DEVICE);
    expect(g.surfaces.map((s) => s.id)).toEqual(['wing-right', 'wing-left']);
    expect(g.overallSpan).toBeCloseTo(30, 10);
  });
});

describe('canted winglet', () => {
  const dev = device('canted-winglet', { toeDeg: 0 }); // size .06, cant 30, sweep 60, taper .35
  const { g, tip, h } = build(dev);
  const fin = surf(g, 'winglet-right');

  it('is a separate tip-device surface for each side', () => {
    expect(fin.role).toBe('tip-device');
    expect(fin.side).toBe('right');
    expect(surf(g, 'winglet-left').side).toBe('left');
    expect(g.surfaces).toHaveLength(4);
    expectMirrored(g, 'winglet');
  });

  it('starts at the wing tip, TE-aligned, with 0.9 of the tip chord', () => {
    const root = first(fin);
    expect(root.le[1]).toBeCloseTo(tip.le[1], 12);
    expect(root.le[2]).toBeCloseTo(tip.le[2], 12);
    expect(root.chord).toBeCloseTo(0.9 * TIP_CHORD, 12);
    expect(root.le[0] + root.chord).toBeCloseTo(tip.le[0] + tip.chord, 12);
  });

  it('rises at roll = 90 deg - cant to a height of h along its span', () => {
    expect(h).toBeCloseTo(0.06 * SEMISPAN, 12);
    for (const s of fin.sections) expect(s.roll).toBeCloseTo(60 * DEG, 12);
    expect(spanPathLength(fin)).toBeCloseTo(h, 10);
    const top = last(fin);
    expect(top.le[2] - tip.le[2]).toBeCloseTo(h * Math.cos(30 * DEG), 10);
    expect(top.le[1] - tip.le[1]).toBeCloseTo(h * Math.sin(30 * DEG), 10);
  });

  it('has z increasing upward and leans outboard', () => {
    for (let i = 1; i < fin.sections.length; i++) {
      expect(fin.sections[i]!.le[2]).toBeGreaterThan(fin.sections[i - 1]!.le[2]);
      expect(fin.sections[i]!.le[1]).toBeGreaterThan(fin.sections[i - 1]!.le[1]);
    }
  });

  it('tapers to taper * tip chord and sweeps the leading edge back', () => {
    expect(last(fin).chord).toBeCloseTo(0.35 * TIP_CHORD, 12);
    const dx = last(fin).le[0] - first(fin).le[0];
    expect(dx).toBeCloseTo(h * Math.tan(60 * DEG), 10);
  });

  it('grows the overall span by 2 h sin(cant)', () => {
    expect(g.overallSpan).toBeCloseTo(30 + 2 * h * Math.sin(30 * DEG), 8);
  });

  it('turns into a flat span extension at 90 deg cant', () => {
    const flat = build(device('canted-winglet', { cantDeg: 90, toeDeg: 0 }));
    const f = surf(flat.g, 'winglet-right');
    expect(last(f).le[2]).toBeCloseTo(flat.tip.le[2], 10);
    expect(last(f).le[1] - flat.tip.le[1]).toBeCloseTo(flat.h, 10);
  });

  it('is vertical at 0 deg cant', () => {
    const vertical = build(device('canted-winglet', { cantDeg: 0, toeDeg: 0 }));
    const f = surf(vertical.g, 'winglet-right');
    expect(last(f).le[1]).toBeCloseTo(vertical.tip.le[1], 10);
    expect(last(f).le[2] - vertical.tip.le[2]).toBeCloseTo(vertical.h, 10);
    expect(vertical.g.overallSpan).toBeCloseTo(30, 10);
  });
});

describe('blended winglet', () => {
  const dev = device('blended-winglet', { toeDeg: 0 }); // size .14, cant 15, sweep 50, taper .3
  const { g, tip, h } = build(dev, { dihedralDeg: 5 });
  const winglet = surf(g, 'winglet-right');

  it('has 4-5 sections and mirrors', () => {
    expect(winglet.sections.length).toBeGreaterThanOrEqual(4);
    expect(winglet.sections.length).toBeLessThanOrEqual(6);
    expectMirrored(g, 'winglet');
  });

  it('starts exactly where the wing tip is, with the tip chord, twist and roll', () => {
    const root = first(winglet);
    expect(root.le).toEqual(tip.le);
    expect(root.chord).toBeCloseTo(tip.chord, 12);
    expect(root.twist).toBeCloseTo(tip.twist, 12);
    expect(root.roll).toBeCloseTo(tip.roll, 12);
  });

  it('ramps the roll smoothly from the dihedral to 90 deg - cant', () => {
    const rolls = winglet.sections.map((s) => s.roll);
    expect(rolls[0]).toBeCloseTo(5 * DEG, 12);
    expect(rolls.at(-1)).toBeCloseTo(75 * DEG, 12);
    for (let i = 1; i < rolls.length; i++) expect(rolls[i]!).toBeGreaterThanOrEqual(rolls[i - 1]!);
    // Equal steps over the arc (constant curvature), then straight.
    const steps = rolls.slice(1).map((r, i) => r - rolls[i]!);
    expect(steps[0]).toBeCloseTo(steps[1]!, 12);
    expect(steps[1]).toBeCloseTo(steps[2]!, 12);
    expect(steps[3] ?? 0).toBeCloseTo(0, 12);
  });

  it('bends with a radius of about 0.3 h', () => {
    const arcSections = winglet.sections.slice(0, 4);
    const arcLength = spanPathLength({ ...winglet, sections: arcSections });
    const turned = arcSections[3]!.roll - arcSections[0]!.roll;
    expect(arcLength / turned).toBeCloseTo(0.3 * h, 2);
  });

  it('reaches a total span-length of h and rises most of it', () => {
    expect(spanPathLength(winglet)).toBeCloseTo(h, 10);
    const rise = last(winglet).le[2] - tip.le[2];
    expect(rise).toBeGreaterThan(0.8 * h);
    expect(rise).toBeLessThanOrEqual(h);
    for (let i = 1; i < winglet.sections.length; i++) {
      expect(winglet.sections[i]!.le[2]).toBeGreaterThan(winglet.sections[i - 1]!.le[2]);
      expect(winglet.sections[i]!.le[1]).toBeGreaterThan(winglet.sections[i - 1]!.le[1]);
    }
  });

  it('tapers linearly from the tip chord to taper * tip chord', () => {
    expect(first(winglet).chord).toBeCloseTo(TIP_CHORD, 12);
    expect(last(winglet).chord).toBeCloseTo(0.3 * TIP_CHORD, 12);
    for (let i = 1; i < winglet.sections.length; i++) {
      expect(winglet.sections[i]!.chord).toBeLessThan(winglet.sections[i - 1]!.chord);
    }
  });

  it('sweeps the leading edge at the requested angle along its span', () => {
    for (let i = 1; i < winglet.sections.length; i++) {
      const a = winglet.sections[i - 1]!;
      const b = winglet.sections[i]!;
      const ds = Math.hypot(b.le[1] - a.le[1], b.le[2] - a.le[2]);
      expect((b.le[0] - a.le[0]) / ds).toBeCloseTo(Math.tan(50 * DEG), 10);
    }
  });

  it('extends the overall span by about the lean-out of the arc', () => {
    expect(g.overallSpan).toBeGreaterThan(30);
    expect(g.overallSpan).toBeLessThan(30 + 2 * h);
  });

  it('degenerates to a straight extension when the cant already matches the dihedral', () => {
    const flat = build(device('blended-winglet', { cantDeg: 90, toeDeg: 0 }));
    const f = surf(flat.g, 'winglet-right');
    expect(f.sections.length).toBeGreaterThanOrEqual(2);
    for (const s of f.sections) expect(s.roll).toBeCloseTo(0, 12);
    expect(last(f).le[1] - flat.tip.le[1]).toBeCloseTo(flat.h, 10);
  });

  it('fades the wing-tip washout out as it turns vertical', () => {
    const washed = build(dev, { washoutDeg: 4 });
    const w = surf(washed.g, 'winglet-right');
    expect(first(w).twist).toBeCloseTo(-4 * DEG, 12);
    expect(Math.abs(last(w).twist)).toBeLessThan(1e-12);
  });
});

describe('raked tip', () => {
  const dev = device('raked-tip'); // size .06, sweep 55, taper .25, toe 0
  const { g, tip, h } = build(dev, { dihedralDeg: 4 });
  const rake = surf(g, 'raked-tip-right');

  it('is an in-plane surface with three sections that mirrors', () => {
    expect(rake.role).toBe('tip-device');
    expect(rake.sections).toHaveLength(3);
    for (const s of rake.sections) expect(s.roll).toBeCloseTo(tip.roll, 12);
    expectMirrored(g, 'raked-tip');
  });

  it('starts at the wing tip and extends h further out in y', () => {
    expect(first(rake).le).toEqual(tip.le);
    expect(last(rake).le[1] - tip.le[1]).toBeCloseTo(h, 10);
    // It continues the wing plane: z = y tan(dihedral).
    for (const s of rake.sections) expect(s.le[2]).toBeCloseTo(s.le[1] * Math.tan(4 * DEG), 10);
  });

  it('grows the overall span by 2 h', () => {
    expect(g.overallSpan).toBeCloseTo(30 + 2 * h, 8);
    const flat = build(dev);
    expect(flat.g.overallSpan).toBeCloseTo(30 + 2 * flat.h, 8);
    expect(flat.h).toBeCloseTo(0.06 * SEMISPAN, 12);
  });

  it('sweeps the leading edge much harder than the wing, increasingly toward the tip', () => {
    const [a, b, c] = rake.sections as [WingSection, WingSection, WingSection];
    const slope1 = (b.le[0] - a.le[0]) / (b.le[1] - a.le[1]);
    const slope2 = (c.le[0] - b.le[0]) / (c.le[1] - b.le[1]);
    expect(slope2).toBeGreaterThan(slope1);
    const wingSlope = Math.tan(28 * DEG) * 1; // wing LE slope is about the QC sweep
    expect(slope1).toBeGreaterThan(wingSlope);
    // Overall LE sweep = sweepDeg (measured along the span).
    const lengthAlong = Math.hypot(c.le[1] - a.le[1], c.le[2] - a.le[2]);
    expect((c.le[0] - a.le[0]) / lengthAlong).toBeCloseTo(Math.tan(55 * DEG), 10);
  });

  it('tapers to taper * tip chord', () => {
    expect(first(rake).chord).toBeCloseTo(TIP_CHORD, 12);
    expect(last(rake).chord).toBeCloseTo(0.25 * TIP_CHORD, 12);
  });

  it('ignores the cant angle', () => {
    const a = build(device('raked-tip', { cantDeg: 0 })).g;
    const b = build(device('raked-tip', { cantDeg: 80 })).g;
    expect(surf(a, 'raked-tip-right').sections).toEqual(surf(b, 'raked-tip-right').sections);
  });

  it('inherits the wing-tip incidence', () => {
    const washed = build(dev, { washoutDeg: 3 });
    const r = surf(washed.g, 'raked-tip-right');
    for (const s of r.sections) expect(s.twist).toBeCloseTo(-3 * DEG, 12);
  });
});

describe('split winglet', () => {
  const dev = device('split-winglet', { toeDeg: 0 }); // size .13, cant 20, sweep 55, taper .3
  const { g, tip, h } = build(dev);
  const upper = surf(g, 'winglet-right');
  const lower = surf(g, 'winglet-lower-right');

  it('has an upper winglet and a ventral fin on each side', () => {
    expect(g.surfaces).toHaveLength(6);
    expect(upper.role).toBe('tip-device');
    expect(lower.role).toBe('tip-device');
    expectMirrored(g, 'winglet');
    expectMirrored(g, 'winglet-lower');
  });

  it('has an upper surface like a blended winglet with a tighter blend', () => {
    const blended = surf(build({ ...dev, kind: 'blended-winglet' }).g, 'winglet-right');
    expect(upper.sections).toHaveLength(blended.sections.length);
    expect(spanPathLength(upper)).toBeCloseTo(h, 10);
    expect(last(upper).roll).toBeCloseTo(70 * DEG, 12);
    // Tighter radius: the blend finishes sooner, so the winglet is straighter and rises more.
    expect(last(upper).le[2] - tip.le[2]).toBeGreaterThan(last(blended).le[2] - tip.le[2]);
    for (let i = 1; i < upper.sections.length; i++) {
      expect(upper.sections[i]!.le[2]).toBeGreaterThan(upper.sections[i - 1]!.le[2]);
    }
  });

  it('points the ventral fin down, about 0.4 h long', () => {
    for (const s of lower.sections) expect(s.roll).toBeCloseTo(-65 * DEG, 12);
    expect(spanPathLength(lower)).toBeCloseTo(0.4 * h, 10);
    for (let i = 1; i < lower.sections.length; i++) {
      expect(lower.sections[i]!.le[2]).toBeLessThan(lower.sections[i - 1]!.le[2]);
    }
    expect(first(lower).le[2] - last(lower).le[2]).toBeCloseTo(0.4 * h * Math.sin(65 * DEG), 10);
  });

  it('starts the fin at the tip, 0.3 tip-chords aft of the tip leading edge', () => {
    const root = first(lower);
    expect(root.le[0] - tip.le[0]).toBeCloseTo(0.3 * TIP_CHORD, 12);
    expect(root.le[1]).toBeCloseTo(tip.le[1], 12);
    expect(root.le[2]).toBeCloseTo(tip.le[2], 12);
    expect(root.chord).toBeCloseTo(0.55 * TIP_CHORD, 12);
    expect(last(lower).chord / root.chord).toBeCloseTo(0.3, 12);
  });
});

describe('wingtip fence', () => {
  const dev = device('wingtip-fence', { toeDeg: 0 }); // size .04, sweep 50, taper .5
  const { g, tip, h } = build(dev);
  const up = surf(g, 'fence-right');
  const down = surf(g, 'fence-lower-right');

  it('has an upper and a lower fence on each side', () => {
    expect(g.surfaces).toHaveLength(6);
    expectMirrored(g, 'fence');
    expectMirrored(g, 'fence-lower');
  });

  it('stands vertical, 0.6 h above and 0.4 h below the tip', () => {
    for (const s of up.sections) expect(s.roll).toBeCloseTo(90 * DEG, 12);
    for (const s of down.sections) expect(s.roll).toBeCloseTo(-90 * DEG, 12);
    expect(last(up).le[2] - tip.le[2]).toBeCloseTo(0.6 * h, 10);
    expect(tip.le[2] - last(down).le[2]).toBeCloseTo(0.4 * h, 10);
    for (const s of [...up.sections, ...down.sections]) expect(s.le[1]).toBeCloseTo(tip.le[1], 12);
    expect(g.overallSpan).toBeCloseTo(30, 8);
  });

  it('starts 0.15 tip-chords ahead of the tip leading edge with 0.8 of its chord', () => {
    for (const fence of [up, down]) {
      expect(first(fence).le[0] - tip.le[0]).toBeCloseTo(-0.15 * TIP_CHORD, 12);
      expect(first(fence).chord).toBeCloseTo(0.8 * TIP_CHORD, 12);
      expect(last(fence).chord).toBeCloseTo(0.5 * TIP_CHORD, 12);
    }
  });

  it('sweeps back and never gets wider than its root chord', () => {
    expect(last(up).le[0]).toBeGreaterThan(first(up).le[0]);
    const wide = build(device('wingtip-fence', { taper: 1 })).g;
    expect(last(surf(wide, 'fence-right')).chord).toBeCloseTo(0.8 * TIP_CHORD, 12);
  });
});

describe('toe', () => {
  const twistable: [TipDeviceKind, string[]][] = [
    ['canted-winglet', ['winglet']],
    ['blended-winglet', ['winglet']],
    ['split-winglet', ['winglet', 'winglet-lower']],
    ['wingtip-fence', ['fence', 'fence-lower']],
  ];

  it.each(twistable)(
    'turns the %s leading edge outboard on both sides for positive toe',
    (kind, ids) => {
      for (const toeDeg of [5, -5, 0]) {
        const { g } = build(device(kind, { toeDeg, cantDeg: 0 }));
        for (const id of ids) {
          for (const side of ['right', 'left'] as const) {
            const surface = surf(g, `${id}-${side}`);
            const out = leOutboardness(last(surface), side);
            if (toeDeg > 0) expect(out).toBeGreaterThan(0.01);
            else if (toeDeg < 0) expect(out).toBeLessThan(-0.01);
            else expect(Math.abs(out)).toBeLessThan(1e-9);
          }
        }
      }
    },
  );

  it('gives a toe angle equal to the requested value on a vertical fin', () => {
    const { g } = build(device('wingtip-fence', { toeDeg: 4 }));
    for (const id of ['fence-right', 'fence-lower-right', 'fence-left', 'fence-lower-left']) {
      const s = last(surf(g, id));
      const f = sectionFrame(s, id.endsWith('left') ? 'left' : 'right');
      // The chord direction lies in the x-y plane, rotated 4 deg from +x.
      expect(Math.abs(f.chordDir[1])).toBeCloseTo(Math.sin(4 * DEG), 10);
      expect(f.chordDir[0]).toBeCloseTo(Math.cos(4 * DEG), 10);
      expect(Math.abs(f.chordDir[2])).toBeLessThan(1e-12);
    }
  });

  it('uses opposite twist signs for upper and lower surfaces to get the same toe', () => {
    const { g } = build(device('wingtip-fence', { toeDeg: 4 }));
    const upper = last(surf(g, 'fence-right'));
    const lower = last(surf(g, 'fence-lower-right'));
    expect(upper.twist).toBeCloseTo(-4 * DEG, 12);
    expect(lower.twist).toBeCloseTo(4 * DEG, 12);
  });

  it('keeps the left twist equal to the right twist (the mirror keeps twist values)', () => {
    const { g } = build(device('blended-winglet', { toeDeg: 3 }));
    const r = surf(g, 'winglet-right').sections;
    const l = surf(g, 'winglet-left').sections;
    r.forEach((s, i) => expect(l[i]!.twist).toBe(s.twist));
  });
});

describe('orientation', () => {
  it('has every winglet rising and every ventral fin or lower fence falling', () => {
    const cases: [TipDeviceKind, string, 'up' | 'down'][] = [
      ['canted-winglet', 'winglet', 'up'],
      ['blended-winglet', 'winglet', 'up'],
      ['split-winglet', 'winglet', 'up'],
      ['split-winglet', 'winglet-lower', 'down'],
      ['wingtip-fence', 'fence', 'up'],
      ['wingtip-fence', 'fence-lower', 'down'],
    ];
    for (const [kind, id, dir] of cases) {
      const { g, tip } = build(device(kind));
      for (const side of ['right', 'left'] as const) {
        const s = surf(g, `${id}-${side}`);
        expect(first(s).le[2]).toBeCloseTo(tip.le[2], 12);
        const dz = last(s).le[2] - first(s).le[2];
        if (dir === 'up') expect(dz).toBeGreaterThan(0.1);
        else expect(dz).toBeLessThan(-0.1);
      }
    }
  });

  it('keeps every device attached at the tip station of its own side', () => {
    for (const kind of Object.keys(TIP_DEVICE_DEFAULTS) as TipDeviceKind[]) {
      if (kind === 'none') continue;
      const { g, tip } = build(device(kind));
      for (const s of g.surfaces.filter((x) => x.role === 'tip-device')) {
        expect(Math.abs(first(s).le[1])).toBeCloseTo(Math.abs(tip.le[1]), 12);
        expect(Math.sign(first(s).le[1])).toBe(s.side === 'right' ? 1 : -1);
      }
    }
  });
});

describe('devices much shorter than the tip chord', () => {
  const teX = (sec: WingSection) => sectionTrailingEdge(sec, 'right')[0];

  it('taper with a trailing edge that runs at most 45 deg off the span', () => {
    for (const kind of [
      'canted-winglet',
      'blended-winglet',
      'raked-tip',
      'wingtip-fence',
    ] as const) {
      for (const size of [0.002, 0.005, 0.01]) {
        const { g } = build(device(kind, { size, toeDeg: 0 }));
        for (const s of g.surfaces.filter((x) => x.role === 'tip-device' && x.side === 'right')) {
          const run = Math.abs(teX(last(s)) - teX(first(s)));
          expect(run, `${kind} ${size}`).toBeLessThanOrEqual(spanPathLength(s) * (1 + 1e-9));
        }
      }
    }
  });

  it('cut a short blend arc into fewer, longer pieces', () => {
    const tiny = surf(build(device('blended-winglet', { size: 0.005 })).g, 'winglet-right');
    const full = surf(build(device('blended-winglet')).g, 'winglet-right');
    expect(tiny.sections.length).toBeLessThan(full.sections.length);
    // The arc is still there: the roll turns in at least one step before the straight part.
    expect(tiny.sections.length).toBeGreaterThanOrEqual(3);
  });

  it('keep the requested taper once they are long enough', () => {
    const { g } = build(device('canted-winglet', { size: 0.1, taper: 0.3 }));
    expect(last(surf(g, 'winglet-right')).chord).toBeCloseTo(0.3 * TIP_CHORD, 12);
  });
});

describe('validity', () => {
  it('stays finite with positive chords for every cant, sweep, taper and toe', () => {
    for (const kind of Object.keys(TIP_DEVICE_DEFAULTS) as TipDeviceKind[]) {
      if (kind === 'none') continue;
      for (const cantDeg of [0, 15, 45, 89, 90]) {
        for (const sweepDeg of [0, 35, 70]) {
          for (const taper of [0.1, 0.5, 1]) {
            for (const toeDeg of [-8, 8]) {
              const { g } = build(device(kind, { cantDeg, sweepDeg, taper, toeDeg, size: 0.2 }));
              for (const s of g.surfaces) {
                for (const sec of s.sections) {
                  for (const v of [...sec.le, sec.chord, sec.twist, sec.roll]) {
                    expect(Number.isFinite(v)).toBe(true);
                  }
                  expect(sec.chord).toBeGreaterThan(0);
                }
              }
              expect(Number.isFinite(g.overallSpan)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('does not alias the tip section it was built from', () => {
    const { g, tip } = build(device('blended-winglet'));
    const w = surf(g, 'winglet-right');
    expect(first(w).le).not.toBe(tip.le);
    expect(first(w).airfoil).not.toBe(tip.airfoil);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Independent checks (review): re-derive the section axes from the WingSection doc instead of  */
/* using sectionFrame/sectionTrailingEdge, so a sign error there cannot hide one here.          */
/* ------------------------------------------------------------------------------------------ */

type V3 = [number, number, number];

/** Rodrigues rotation of v about unit axis k by angle a (right-hand rule). */
function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kxv: V3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  const kdv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [0, 1, 2].map((i) => v[i]! * c + kxv[i]! * s + k[i]! * kdv * (1 - c)) as V3;
}

/**
 * Trailing edge from the WingSection doc: chord direction = +x rotated by twist about the
 * right-hand span tangent t = (0, cos roll, sin roll). The left side is the mirror image of that
 * construction (rotating about a mirrored tangent with the right-hand rule would flip the sense of
 * twist, which would make positive twist nose-down on the left wing).
 */
function docTrailingEdge(sec: WingSection, side: 'right' | 'left'): V3 {
  const t: V3 = [0, Math.cos(sec.roll), Math.sin(sec.roll)];
  const d = rotate([1, 0, 0], t, sec.twist);
  if (side === 'left') d[1] = -d[1];
  return [sec.le[0] + sec.chord * d[0], sec.le[1] + sec.chord * d[1], sec.le[2] + sec.chord * d[2]];
}

const DEVICE_SURFACES: [TipDeviceKind, string[]][] = [
  ['canted-winglet', ['winglet']],
  ['blended-winglet', ['winglet']],
  ['split-winglet', ['winglet', 'winglet-lower']],
  ['wingtip-fence', ['fence', 'fence-lower']],
];

describe('toe against an independent rotation', () => {
  it.each(DEVICE_SURFACES)(
    'turns the %s leading edge outboard for positive toe at every cant and dihedral',
    (kind, ids) => {
      for (const cantDeg of [0, 20, 45]) {
        for (const dihedralDeg of [-10, 0, 6, 15]) {
          for (const toeDeg of [4, -4]) {
            const { g } = build(device(kind, { toeDeg, cantDeg }), { dihedralDeg, washoutDeg: 0 });
            for (const id of ids) {
              for (const side of ['right', 'left'] as const) {
                const top = last(surf(g, `${id}-${side}`));
                const te = docTrailingEdge(top, side);
                const out = Math.abs(top.le[1]) - Math.abs(te[1]);
                expect(Math.sign(out)).toBe(Math.sign(toeDeg));
              }
            }
          }
        }
      }
    },
  );

  it('gives a vertical fence exactly the requested toe in plan view', () => {
    const { g } = build(device('wingtip-fence', { toeDeg: 3 }), { washoutDeg: 5 });
    for (const id of ['fence-right', 'fence-lower-right', 'fence-left', 'fence-lower-left']) {
      const s = last(surf(g, id));
      const te = docTrailingEdge(s, id.endsWith('left') ? 'left' : 'right');
      const dx = te[0] - s.le[0];
      const dyOut = Math.abs(s.le[1]) - Math.abs(te[1]);
      expect(Math.atan2(dyOut, dx)).toBeCloseTo(3 * DEG, 12);
      expect(te[2]).toBeCloseTo(s.le[2], 12);
    }
  });

  it('agrees with sectionTrailingEdge for every device section', () => {
    for (const [kind] of DEVICE_SURFACES) {
      const { g } = build(device(kind, { toeDeg: 5 }), { dihedralDeg: 7, washoutDeg: 3 });
      for (const s of g.surfaces) {
        for (const sec of s.sections) {
          const a = docTrailingEdge(sec, s.side);
          const b = sectionTrailingEdge(sec, s.side);
          for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i]!, 12);
        }
      }
    }
  });
});

describe('junction with the wing tip', () => {
  const smooth: [TipDeviceKind, string][] = [
    ['blended-winglet', 'winglet'],
    ['split-winglet', 'winglet'],
    ['raked-tip', 'raked-tip'],
  ];

  it.each(smooth)(
    'starts the %s with exactly the tip section for any toe, cant, dihedral and twist',
    (kind, id) => {
      // cant 90 with 0.5 deg dihedral turns by less than the no-arc threshold (0.02 rad).
      for (const [toeDeg, cantDeg] of [
        [-8, 15],
        [-2, 30],
        [0, 15],
        [8, 15],
        [5, 90],
      ] as const) {
        for (const dihedralDeg of [-10, 0.5, 6, 15]) {
          const wing = { dihedralDeg, washoutDeg: 4, rootIncidenceDeg: 2 };
          const { g, tip } = build(device(kind, { toeDeg, cantDeg }), wing);
          for (const side of ['right', 'left'] as const) {
            const tipSide = surf(g, `wing-${side}`).sections.at(-1)!;
            const root = first(surf(g, `${id}-${side}`));
            expect(root.le).toEqual(tipSide.le);
            expect(root.chord).toBeCloseTo(tipSide.chord, 12);
            expect(root.roll).toBeCloseTo(tipSide.roll, 12);
            expect(root.twist).toBeCloseTo(tip.twist, 12);
            // Same TE too, so the loft has no step at the junction.
            const a = docTrailingEdge(root, side);
            const b = docTrailingEdge(tipSide, side);
            for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 12);
          }
        }
      }
    },
  );
});

describe('continuity across the sliders', () => {
  /** Largest change of any root/tip section field or overall quantity between two geometries. */
  function jump(a: WingGeometry, b: WingGeometry): number {
    let worst = Math.abs(a.overallSpan - b.overallSpan) + Math.abs(a.wettedArea - b.wettedArea);
    expect(b.surfaces.map((s) => s.id)).toEqual(a.surfaces.map((s) => s.id));
    a.surfaces.forEach((sa, i) => {
      const sb = b.surfaces[i]!;
      for (const [x, y] of [
        [first(sa), first(sb)],
        [last(sa), last(sb)],
      ] as const) {
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(x.le[k]! - y.le[k]!));
        worst = Math.max(
          worst,
          Math.abs(x.chord - y.chord),
          Math.abs(x.twist - y.twist),
          Math.abs(x.roll - y.roll),
        );
      }
    });
    return worst;
  }

  const kinds = DEVICE_SURFACES.map(([k]) => k).concat(['raked-tip']);
  const wing = { washoutDeg: 4, rootIncidenceDeg: 3 };

  it.each(kinds)('has no jump in the %s when dihedral or cant moves a little', (kind) => {
    // 88.85409 straddles the cant at which the blend arc appears (turn = 0.02 rad, dihedral 0).
    for (const cantDeg of [0, 30, 75, 88.85409, 89.9, 90]) {
      for (const dihedralDeg of [-10, -0.1, 0, 0.1, 1, 6, 15]) {
        const a = build(device(kind, { cantDeg, toeDeg: 3 }), { ...wing, dihedralDeg }).g;
        const b = build(device(kind, { cantDeg, toeDeg: 3 }), {
          ...wing,
          dihedralDeg: dihedralDeg + 1e-4,
        }).g;
        const c = build(device(kind, { cantDeg: Math.max(0, cantDeg - 1e-4), toeDeg: 3 }), {
          ...wing,
          dihedralDeg,
        }).g;
        expect(jump(a, b)).toBeLessThan(1e-3);
        expect(jump(a, c)).toBeLessThan(1e-3);
      }
    }
  });

  it('gives a flat (90 deg cant) winglet the wing-tip incidence, like a raked tip', () => {
    for (const kind of ['canted-winglet', 'blended-winglet'] as const) {
      for (const dihedralDeg of [0, 0.5]) {
        const { g, tip } = build(device(kind, { cantDeg: 90, toeDeg: 0 }), {
          ...wing,
          dihedralDeg,
        });
        expect(tip.twist).toBeCloseTo(-1 * DEG, 12);
        for (const s of surf(g, 'winglet-right').sections) {
          expect(s.twist).toBeCloseTo(tip.twist, 3);
        }
      }
    }
  });
});
