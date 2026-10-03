/**
 * Adversarial checks of the VLM layout and coupling (independent review): swept and dihedral
 * wings, wing-root and tip-device junctions, degenerate device slivers, deep stall with flaps and
 * the extremes of the UI sliders. Each case here failed before the fix it guards.
 */
import { describe, expect, it } from 'vitest';
import type { LiftingSurface, Naca4Params, SectionPolar, Vec3, WingGeometry } from '../types';
import {
  buildVlmModel,
  solveCoupled,
  solveVlm,
  type StripPolarProvider,
  type VlmModel,
  type VlmOptions,
} from './vlm';
import { segmentUsable } from './vlmLayout';
import {
  makeFlatPlateStallPolar,
  makeMockPolar,
  makeTestWing,
  type TestWingSpec,
} from './vlmTestFixtures';

const DEG = Math.PI / 180;
const NACA4412: Naca4Params = { camber: 0.04, camberPos: 0.4, thickness: 0.12 };
const FINE: Partial<VlmOptions> = {
  spanwisePanelsWing: 64,
  chordwisePanels: 8,
  spanwisePanelsDevice: 16,
};

function spanEfficiency(geo: WingGeometry, model: VlmModel, alpha = 4 * DEG): number {
  const s = solveVlm(model, { alpha });
  return (s.CL * s.CL) / (Math.PI * geo.aspectRatio * s.CDi);
}

function relSpread(values: number[]): number {
  return (Math.max(...values) - Math.min(...values)) / Math.abs(values[0]!);
}

/** Every right-half lattice point (bound, trailing-edge, control and edge points). */
function rightHalfPoints(m: VlmModel): Float64Array[] {
  const n = 3 * m.halfPanelCount;
  return [
    m.boundA.subarray(0, n),
    m.boundB.subarray(0, n),
    m.trailingA.subarray(0, n),
    m.trailingB.subarray(0, n),
    m.controlPoints.subarray(0, n),
    m.solver.edgeA,
    m.solver.edgeB,
  ];
}

const mirrorSurface = (s: LiftingSurface, id: string): LiftingSurface => ({
  ...s,
  id,
  side: 'left',
  sections: s.sections.map((sec) => ({ ...sec, le: [sec.le[0], -sec.le[1], sec.le[2]] as Vec3 })),
});

/** Base wing of `spec` plus extra right-side device surfaces (mirrored to the left). */
function withDevices(spec: TestWingSpec, devices: LiftingSurface[]): WingGeometry {
  const geo = makeTestWing(spec);
  const right = geo.surfaces.filter((s) => s.side === 'right');
  const left = geo.surfaces.filter((s) => s.side === 'left');
  return {
    ...geo,
    surfaces: [
      ...right,
      ...devices,
      ...left,
      ...devices.map((d) => mirrorSurface(d, d.id.replace('right', 'left'))),
    ],
  };
}

describe('vlm virtual twist and geometric angle on swept and dihedral wings', () => {
  it('a uniform virtual twist equals the same change of alpha on swept wings too', () => {
    // The virtual twist is an incidence change about the section span tangent (0, cos r, sin r),
    // exactly like WingSection.twist. (Rotating about the swept quarter-chord line instead only
    // changes the incidence by delta * cos(sweep): -5% CL at 35 deg, -14% at 60 deg.)
    for (const sweepQuarterDeg of [35, 60]) {
      const m = buildVlmModel(makeTestWing({ span: 8, rootChord: 1, taper: 0.5, sweepQuarterDeg }));
      const d = 0.02;
      const a = solveVlm(m, {
        alpha: 0.05,
        stripIncidence: new Float64Array(m.strips.length).fill(d),
      });
      const b = solveVlm(m, { alpha: 0.05 + d });
      // Equal up to the O(delta^2) of the small-angle virtual twist.
      expect(a.CL / b.CL).toBeCloseTo(1, 3);
      for (let j = 0; j < m.halfStripCount; j++) {
        expect(a.stripCirculation[j]! / b.stripCirculation[j]!).toBeCloseTo(1, 3);
      }
    }
  });

  it('reports the streamwise geometric angle: alpha + twist, whatever the sweep', () => {
    const alpha = 5 * DEG;
    const provider: StripPolarProvider = {
      polar: () => makeMockPolar({ alphaZeroLift: 0, alphaStall: 60 * DEG }),
      reynolds: () => 1e6,
    };
    for (const sweepQuarterDeg of [0, 35, 60]) {
      const m = buildVlmModel(
        makeTestWing({ span: 8, rootChord: 1, taper: 0.4, sweepQuarterDeg, washoutDeg: 4 }),
      );
      const c = solveCoupled(m, alpha, provider);
      for (let j = 0; j < m.strips.length; j++) {
        // alpha/cos(sweep) + twist before the fix: 6.1 deg instead of 5 at the swept root.
        expect(c.stripAlphaGeometric[j]).toBeCloseTo(alpha + m.strips[j]!.twist, 9);
      }
    }
    // Dihedral tilts the section normal: tan(a_geo) = tan(a) cos(dihedral) for an untwisted wing.
    const dih = buildVlmModel(makeTestWing({ span: 8, rootChord: 1, dihedralDeg: 12 }));
    const cd = solveCoupled(dih, alpha, provider);
    expect(Math.tan(cd.stripAlphaGeometric[3]!)).toBeCloseTo(
      Math.tan(alpha) * Math.cos(12 * DEG),
      9,
    );
    // A vertical winglet sees only its own incidence (toe), not the wing's alpha.
    const wl = buildVlmModel(
      makeTestWing({ span: 8, rootChord: 1, devices: [{ heightFrac: 0.15, twistDeg: -2 }] }),
    );
    const cw = solveCoupled(wl, alpha, provider);
    const j = wl.strips.findIndex((s) => s.surfaceId === 'device0-right');
    expect(cw.stripAlphaGeometric[j + 2]).toBeCloseTo(-2 * DEG, 9);
  });
});

describe('vlm junctions', () => {
  const base: TestWingSpec = { span: 60, rootChord: 12, taper: 0.3, sweepQuarterDeg: 35 };

  it('keeps a dihedral, twisted or cambered wing root on the symmetry plane (mesh-converged)', () => {
    // With dihedral the section plane is tilted, so camber and twist used to push the root's
    // camber line across y = 0, where it overlapped its own mirror image. CL then grew without
    // bound under refinement (0.62 -> 1.30 for the cambered case at 96 strips).
    for (const spec of [
      { ...base, dihedralDeg: 7, airfoil: NACA4412 },
      { ...base, dihedralDeg: 7, rootIncidenceDeg: 3 },
      { ...base, dihedralDeg: -10, rootIncidenceDeg: 6, washoutDeg: -3, airfoil: NACA4412 },
    ]) {
      const geo = makeTestWing(spec);
      const coarse = buildVlmModel(geo);
      const fine = buildVlmModel(geo, FINE);
      for (const m of [coarse, fine]) {
        for (const pts of rightHalfPoints(m)) {
          for (let i = 1; i < pts.length; i += 3) expect(pts[i]).toBeGreaterThanOrEqual(-1e-12);
        }
      }
      const cl = [coarse, fine].map((m) => solveVlm(m, { alpha: 4 * DEG }).CL);
      expect(relSpread(cl)).toBeLessThan(0.01);
      const e = [coarse, fine].map((m) => spanEfficiency(geo, m));
      expect(relSpread(e)).toBeLessThan(0.01);
      expect(e[0]).toBeGreaterThan(0.85);
      expect(e[0]).toBeLessThan(1.0);
    }
  });

  it('starts a tip device exactly on the wing tip edge, so their trailing legs coincide', () => {
    // A canted, toed winglet on a washed-out dihedral wing: built from its own sections, the
    // winglet's root edge differs from the wing tip edge (other roll and twist).
    const geo = makeTestWing({
      ...base,
      dihedralDeg: 7,
      washoutDeg: 3.5,
      airfoil: NACA4412,
      devices: [{ heightFrac: 0.06, cantDeg: 30, sweepDeg: 60, taper: 0.35, twistDeg: 3 }],
    });
    for (const opts of [{}, FINE]) {
      const m = buildVlmModel(geo, opts);
      const nc = m.options.chordwisePanels;
      const tip = m.strips.filter((s) => s.surfaceId === 'wing-right').length - 1;
      const dev = tip + 1;
      expect(m.strips[dev]!.surfaceId).toBe('device0-right');
      for (let k = 0; k <= nc; k++) {
        for (let c = 0; c < 3; c++) {
          expect(m.solver.edgeA[3 * ((nc + 1) * dev + k) + c]).toBe(
            m.solver.edgeB[3 * ((nc + 1) * tip + k) + c],
          );
        }
      }
      const pt = m.strips[tip]!.panelStart;
      const pd = m.strips[dev]!.panelStart;
      for (let c = 0; c < 3; c++) expect(m.trailingA[3 * pd + c]).toBe(m.trailingB[3 * pt + c]);
    }
  });

  it('converges for a fence that overhangs the tip chord (A380 style)', () => {
    // Fence root 15% of the tip chord ahead of the wing LE, 80% of its chord, above and below the
    // tip. Separately built root edges put the washed-out wing tip's trailing leg across the
    // fence: e scattered 0.91..0.99 over these meshes.
    const spec: TestWingSpec = {
      span: 80,
      rootChord: 22,
      taper: 0.16,
      sweepQuarterDeg: 33,
      dihedralDeg: 5.5,
      washoutDeg: 3.5,
      airfoil: NACA4412,
    };
    const tip = makeTestWing(spec).surfaces[0]!.sections[1]!;
    const c = tip.chord;
    const fence = (id: string, up: number): LiftingSurface => ({
      id,
      name: id,
      side: 'right',
      role: 'tip-device',
      sections: [
        {
          ...tip,
          le: [tip.le[0] - 0.15 * c, tip.le[1], tip.le[2]],
          chord: 0.8 * c,
          twist: 0,
          roll: up * 90 * DEG,
        },
        {
          ...tip,
          le: [tip.le[0] + 0.2 * c, tip.le[1], tip.le[2] + up * 0.04 * 40],
          chord: 0.5 * c,
          twist: 0,
          roll: up * 90 * DEG,
        },
      ],
    });
    const geo = withDevices(spec, [fence('fence-right', 1), fence('fence-lower-right', -1)]);
    const e = [
      {},
      { spanwisePanelsWing: 48, chordwisePanels: 12, spanwisePanelsDevice: 12 },
      FINE,
    ].map((o) => spanEfficiency(geo, buildVlmModel(geo, o)));
    expect(relSpread(e)).toBeLessThan(0.015);
  });
});

describe('vlm degenerate device slivers', () => {
  it('leaves out a device far shorter than its chord instead of going singular', () => {
    // 2 cm "winglet" under a 4 m tip chord tapering to 0.4 m: its trailing edge runs almost
    // streamwise, so its bound vortices would lie along their own trailing legs.
    const spec: TestWingSpec = { span: 8, rootChord: 4, airfoil: NACA4412 };
    const geo = makeTestWing({ ...spec, devices: [{ heightFrac: 0.005, taper: 0.1 }] });
    expect(
      segmentUsable(
        geo.surfaces.find((s) => s.id === 'device0-right')!,
        0,
      ),
    ).toBe(false);
    const m = buildVlmModel(geo);
    expect(m.strips.some((s) => s.surfaceId.startsWith('device'))).toBe(false);
    const plain = solveVlm(buildVlmModel(makeTestWing(spec)), { alpha: 4 * DEG });
    const s = solveVlm(m, { alpha: 4 * DEG });
    expect(s.CL).toBeCloseTo(plain.CL, 12);
    expect(s.CDi).toBeGreaterThan(0);
  });

  it('skips a blend piece that folds over itself and joins the device to the wing tip', () => {
    // A 5 cm blend piece rolling to 60 deg with +12 deg twist on a 6 m chord: its trailing edge
    // swings 1 m inboard of its leading edge. The rest of the winglet is sound.
    const spec: TestWingSpec = { span: 24, rootChord: 6, airfoil: NACA4412, washoutDeg: 2 };
    const tip = makeTestWing(spec).surfaces[0]!.sections[1]!;
    const roll = 60 * DEG;
    const piece: Vec3 = [
      tip.le[0],
      tip.le[1] + 0.05 * Math.cos(roll),
      tip.le[2] + 0.05 * Math.sin(roll),
    ];
    const device: LiftingSurface = {
      id: 'winglet-right',
      name: 'winglet',
      side: 'right',
      role: 'tip-device',
      sections: [
        { ...tip },
        { ...tip, le: piece, roll, twist: 12 * DEG },
        {
          ...tip,
          le: [piece[0] + 1.5, piece[1] + 1.2 * Math.cos(roll), piece[2] + 1.2 * Math.sin(roll)],
          roll,
          twist: 0,
          chord: 3,
        },
      ],
    };
    expect(segmentUsable(device, 0)).toBe(false);
    expect(segmentUsable(device, 1)).toBe(true);
    const geo = withDevices(spec, [device]);
    const coarse = buildVlmModel(geo);
    const fine = buildVlmModel(geo, FINE);
    const plain = solveVlm(buildVlmModel(makeTestWing(spec)), { alpha: 4 * DEG });
    const cl: number[] = [];
    for (const m of [coarse, fine]) {
      const s = solveVlm(m, { alpha: 4 * DEG });
      expect(s.CDi).toBeGreaterThan(0);
      // A 1.2 m winglet on a 12 m semispan (AR 4 wing) adds lift and cuts induced drag.
      expect(s.CL / plain.CL).toBeGreaterThan(1);
      expect(s.CL / plain.CL).toBeLessThan(1.2);
      expect(s.CDi / (s.CL * s.CL)).toBeLessThan(plain.CDi / (plain.CL * plain.CL));
      cl.push(s.CL);
    }
    expect(relSpread(cl)).toBeLessThan(0.01);
  });
});

describe('vlm lattice consistency on extreme wings', () => {
  const alpha = 5 * DEG;
  const meshes: Partial<VlmOptions>[] = [
    {},
    { spanwisePanelsWing: 48, chordwisePanels: 12 },
    { spanwisePanelsWing: 64, chordwisePanels: 8 },
  ];

  it('keeps every wing edge in its own streamwise plane (deep flaps on anhedral, short twisted span)', () => {
    // With dihedral the section planes are tilted, so flap droop, twist and camber move each
    // edge's trailing edge sideways by drop * sin(roll). Near the root that exceeds the strip
    // width: edges crossed y = 0 and each other (before: CDi < 0, or CL 0.22 -> 0.08 under
    // refinement).
    for (const spec of [
      {
        span: 34,
        rootChord: 15,
        taper: 0.42,
        sweepQuarterDeg: 60,
        dihedralDeg: -10,
        rootIncidenceDeg: 8,
        washoutDeg: -3.4,
        airfoil: { camber: 0.086, camberPos: 0.41, thickness: 0.2 },
        flap: { chordFrac: 0.4, deflectionDeg: 40, spanFrac: 0.53 },
      },
      {
        span: 4,
        rootChord: 8,
        dihedralDeg: 13,
        rootIncidenceDeg: 8,
        washoutDeg: -5,
        airfoil: { camber: 0.06, camberPos: 0.4, thickness: 0.12 },
      },
    ] satisfies TestWingSpec[]) {
      const cl: number[] = [];
      for (const o of meshes) {
        const m = buildVlmModel(makeTestWing(spec), o);
        for (const pts of rightHalfPoints(m)) {
          for (let i = 1; i < pts.length; i += 3) expect(pts[i]).toBeGreaterThanOrEqual(-1e-12);
        }
        const s = solveVlm(m, { alpha });
        expect(s.CDi).toBeGreaterThan(0);
        cl.push(s.CL);
      }
      expect(relSpread(cl)).toBeLessThan(0.03);
    }
  });

  it('puts bound vortices and control points on the flat panels the trailing legs follow', () => {
    // 9% camber at 86% chord on a 20 m chord with a 2 m semispan: on the analytic camber line the
    // aft control points sat ~0.3 m off the legs' piecewise-flat sheet, more than a strip width,
    // and the lattice went singular (CL -5000 at 5 deg; -5e5 on a finer mesh).
    for (const sweepQuarterDeg of [0, 60]) {
      const spec: TestWingSpec = {
        span: 4,
        rootChord: 20,
        taper: 0.24,
        sweepQuarterDeg,
        rootIncidenceDeg: -3.4,
        washoutDeg: -1.6,
        airfoil: { camber: 0.09, camberPos: 0.86, thickness: 0.04 },
      };
      for (const o of meshes) {
        const s = solveVlm(buildVlmModel(makeTestWing(spec), o), { alpha });
        // Aspect ratio 0.3: CL_alpha ~ pi A / 2 ~ 0.5 per rad, plus the camber.
        expect(s.CL).toBeGreaterThan(0.03);
        expect(s.CL).toBeLessThan(0.2);
        expect(s.CDi).toBeGreaterThan(0);
        expect(s.CDi).toBeLessThan(0.1);
      }
    }
  });

  it('leaves out tip devices that cut through the wing surface, and says so', () => {
    // A vertical winglet with 9% camber and 8 deg toe on a 9 m tip chord: its camber surface
    // bulges across the wing tip's. Unchecked, CL came out 4.1 instead of ~0.9.
    const spec: TestWingSpec = {
      span: 58,
      rootChord: 14,
      taper: 0.62,
      sweepQuarterDeg: 57,
      rootIncidenceDeg: 7,
      washoutDeg: 5.7,
      airfoil: { camber: 0.09, camberPos: 0.62, thickness: 0.04 },
    };
    const m = buildVlmModel(
      makeTestWing({
        ...spec,
        devices: [{ heightFrac: 0.05, cantDeg: 0, taper: 0.1, twistDeg: 8 }],
      }),
    );
    expect(m.warnings).toHaveLength(1);
    expect(m.warnings[0]).toMatch(/wingtip devices were left out/);
    expect(m.strips.some((s) => s.surfaceId.startsWith('device'))).toBe(false);
    const plain = buildVlmModel(makeTestWing(spec));
    expect(plain.warnings).toHaveLength(0);
    expect(solveVlm(m, { alpha }).CL).toBeCloseTo(solveVlm(plain, { alpha }).CL, 12);
    // A sound winglet on the same wing is kept.
    const sound = buildVlmModel(
      makeTestWing({ ...spec, airfoil: NACA4412, devices: [{ heightFrac: 0.05, cantDeg: 20 }] }),
    );
    expect(sound.warnings).toHaveLength(0);
    expect(sound.strips.some((s) => s.surfaceId.startsWith('device'))).toBe(true);
  });
});

describe('vlm extreme slider combinations', () => {
  it('stays finite with positive induced drag over the slider extremes', () => {
    // Deterministic corners of the UI ranges (span 4..90, root chord 0.3..20, taper 0.1..1,
    // sweep -10..60, dihedral -10..15, washout -5..10, incidence -5..8, camber 0..0.09,
    // winglets 0..0.2 of the semispan, flaps 0..40 deg).
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const pick = (lo: number, hi: number) => {
      const r = rnd();
      return r < 0.3 ? lo : r > 0.7 ? hi : lo + (hi - lo) * rnd();
    };
    for (let k = 0; k < 40; k++) {
      const span = pick(4, 90);
      const rootChord = Math.min(pick(0.3, 20), span);
      const spec: TestWingSpec = {
        span,
        rootChord,
        taper: pick(0.1, 1),
        sweepQuarterDeg: pick(-10, 60),
        dihedralDeg: pick(-10, 15),
        washoutDeg: pick(-5, 10),
        rootIncidenceDeg: pick(-5, 8),
        airfoil: { camber: pick(0, 0.09), camberPos: pick(0.2, 0.8), thickness: 0.12 },
        flap:
          rnd() < 0.5
            ? undefined
            : { chordFrac: pick(0.1, 0.4), deflectionDeg: pick(0, 40), spanFrac: pick(0.1, 0.9) },
        devices:
          rnd() < 0.5
            ? []
            : [
                {
                  heightFrac: pick(0, 0.2),
                  cantDeg: pick(0, 90),
                  sweepDeg: pick(0, 70),
                  taper: pick(0.1, 1),
                  twistDeg: pick(-8, 8),
                },
              ],
      };
      const m = buildVlmModel(makeTestWing(spec), { mach: pick(0, 0.9) });
      for (const ad of [-10, 5, 25]) {
        const s = solveVlm(m, { alpha: ad * DEG });
        const label = JSON.stringify({ spec, ad });
        expect([s.CL, s.CDi, s.Cm].every(Number.isFinite), label).toBe(true);
        expect(Math.abs(s.CL), label).toBeLessThan(6);
        expect(s.CDi, label).toBeGreaterThan(-1e-6);
        for (const g of s.stripCl) expect(Math.abs(g), label).toBeLessThan(15);
      }
    }
  });
});

describe('solveCoupled in deep stall with flaps', () => {
  it('stays close to the polar, converges and keeps the stall region contiguous', () => {
    const geo = makeTestWing({
      span: 30,
      rootChord: 5,
      taper: 0.35,
      sweepQuarterDeg: 25,
      washoutDeg: 3,
      airfoil: NACA4412,
      flap: { chordFrac: 0.3, deflectionDeg: 30, spanFrac: 0.6 },
    });
    const m = buildVlmModel(geo);
    // Polars that flatten to the flat-plate curve past stall, like the airfoil module's.
    const clean = makeFlatPlateStallPolar(-4 * DEG, 14 * DEG);
    const flapped = makeFlatPlateStallPolar(-16 * DEG, 8 * DEG);
    const provider: StripPolarProvider = {
      polar: (s): SectionPolar => (s.flap ? flapped : clean),
      reynolds: () => 1e7,
    };
    const half = m.halfStripCount;
    let worst = 0;
    let converged = 0;
    for (let ad = 8; ad <= 25; ad++) {
      const c = solveCoupled(m, ad * DEG, provider);
      if (c.converged) converged++;
      for (let j = 0; j < half; j++) {
        worst = Math.max(worst, Math.abs(c.stripClViscous[j]! - c.stripClPolar[j]!));
      }
      // At most one stalled region on each side of the flap end.
      const flapEnd = m.strips.findIndex((s) => !s.flap);
      const pattern = Array.from(c.stripStalled.slice(0, half)).join('');
      expect(pattern.slice(0, flapEnd), `alpha ${ad}`).toMatch(/^0*1*0*$/);
      expect(pattern.slice(flapEnd), `alpha ${ad}`).toMatch(/^0*1*0*$/);
    }
    // The single strong viscosity stage of the original design left 1.21 here; now ~0.78.
    expect(worst).toBeLessThan(0.9);
    expect(converged).toBeGreaterThanOrEqual(17);
  });
});
