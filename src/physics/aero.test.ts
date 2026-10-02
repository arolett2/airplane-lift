/**
 * Unit tests for the aero assembly logic with the physics modules mocked by small analytic fakes,
 * so they run before (and independently of) the real solvers. End-to-end checks against the real
 * solvers live in aero.e2e.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AirfoilKey } from './airfoil/index';
import type { CoupledSolution, StripPolarProvider, VlmModel, VlmStrip } from './wing/vlm';
import type { SectionPolar, WingGeometry, WingSection } from './types';
import type { WingConfig } from '../state/params';
import type * as AtmosphereModule from './atmosphere';
import type * as VlmModule from './wing/vlm';
import { DEFAULT_FLOW, DEFAULT_WING, TIP_DEVICE_DEFAULTS } from '../state/params';
import { bodyDirToTunnel, bodyToTunnel } from './math/frames';

const fakes = vi.hoisted(() => {
  const DEG = Math.PI / 180;
  const STRIPS_PER_SIDE = 4;

  /** Thin-airfoil polar with a linear post-stall drop. Flaps shift the zero-lift angle. */
  function fakePolar(key: AirfoilKey): SectionPolar {
    const a0 = -0.03 - (key.flap ? 0.1 : 0);
    const aStall = 0.25;
    const slope = 2 * Math.PI;
    const clMax = slope * (aStall - a0);
    return {
      alphaZeroLift: a0,
      liftSlope: slope,
      clMax: () => clMax,
      alphaStall: () => aStall,
      cl: (a) => (a <= aStall ? slope * (a - a0) : clMax - 3 * (a - aStall)),
      cd: (a) => 0.008 + 0.01 * a * a + (key.flap ? 0.02 : 0),
      cm: () => -0.05,
      attachedFraction: (a) => (a <= aStall ? 1 : 0.4),
    };
  }

  const chordwiseCp = vi.fn((_alpha: number, _re: number, _n?: number, _cl?: number) => ({
    xc: new Float32Array([0, 0.5, 1]),
    upper: new Float32Array([1, -0.5, 0.1]),
    lower: new Float32Array([1, 0.2, 0.1]),
  }));

  const getAirfoilModel = vi.fn((key: AirfoilKey) => ({
    key,
    geometry: null as never,
    solver: null as never,
    polar: fakePolar(key),
    chordwiseCp,
  }));

  const isaAtmosphere = vi.fn((h: number) => {
    const T = 288.15 - 0.0065 * h;
    const p = 101325 * (T / 288.15) ** 5.2559;
    return {
      altitude: h,
      temperature: T,
      pressure: p,
      density: p / (287.05 * T),
      speedOfSound: Math.sqrt(1.4 * 287.05 * T),
      dynamicViscosity: 1.789e-5,
    };
  });

  function buildWingGeometry(wing: WingConfig): WingGeometry {
    const semi = wing.span / 2;
    const cr = wing.rootChord;
    const ct = cr * wing.taperRatio;
    const S = (wing.span * (cr + ct)) / 2;
    const sec = (y: number, chord: number, z = 0, roll = 0): WingSection => ({
      le: [0, y, z],
      chord,
      twist: 0,
      roll,
      airfoil: wing.airfoil,
      flap:
        wing.flaps.deflectionDeg > 0
          ? { chordFrac: wing.flaps.chordFrac, deflection: wing.flaps.deflectionDeg * DEG }
          : null,
      slat: false,
    });
    const surfaces: WingGeometry['surfaces'] = [
      {
        id: 'wing-R',
        name: 'Right wing',
        side: 'right',
        role: 'wing',
        sections: [sec(0, cr), sec(semi, ct)],
      },
      {
        id: 'wing-L',
        name: 'Left wing',
        side: 'left',
        role: 'wing',
        sections: [sec(0, cr), sec(-semi, ct)],
      },
    ];
    if (wing.tipDevice.kind !== 'none') {
      const h = wing.tipDevice.size * semi;
      surfaces.push(
        {
          id: 'tip-R',
          name: 'Right winglet',
          side: 'right',
          role: 'tip-device',
          sections: [sec(semi, ct, 0, Math.PI / 2), sec(semi, ct * 0.3, h, Math.PI / 2)],
        },
        {
          id: 'tip-L',
          name: 'Left winglet',
          side: 'left',
          role: 'tip-device',
          sections: [sec(-semi, ct, 0, Math.PI / 2), sec(-semi, ct * 0.3, h, Math.PI / 2)],
        },
      );
    }
    const lam = wing.taperRatio;
    return {
      surfaces,
      pivot: [cr / 4, 0, 0],
      referenceArea: S,
      referenceSpan: wing.span,
      meanAeroChord: ((2 / 3) * cr * (1 + lam + lam * lam)) / (1 + lam),
      aspectRatio: (wing.span * wing.span) / S,
      overallSpan: wing.span,
      wettedArea: 2.04 * S,
      sweepQuarterChord: wing.sweepDeg * DEG,
    };
  }

  /** Strip layout: 4 base-wing strips per side, plus one vertical tip-device strip per side. */
  function buildVlmModel(geometry: WingGeometry, _options?: { mach?: number }): VlmModel {
    const strips: VlmStrip[] = [];
    const right = geometry.surfaces[0]!;
    const semi = geometry.referenceSpan / 2;
    const cr = right.sections[0]!.chord;
    const ct = right.sections[1]!.chord;
    const airfoil = right.sections[0]!.airfoil;
    const flap = geometry.surfaces[0]!.sections[0]!.flap;
    for (const side of ['right', 'left'] as const) {
      const sy = side === 'right' ? 1 : -1;
      for (let k = 0; k < STRIPS_PER_SIDE; k++) {
        const eta = (k + 0.5) / STRIPS_PER_SIDE;
        const chord = cr + (ct - cr) * eta;
        strips.push({
          index: strips.length,
          surfaceId: side === 'right' ? 'wing-R' : 'wing-L',
          side,
          eta,
          width: semi / STRIPS_PER_SIDE,
          chord,
          center: [chord / 4, sy * eta * semi, 0],
          normal: [0, 0, 1],
          spanTangent: [0, sy, 0],
          // Interpolation noise must not split the airfoil key.
          airfoil: { ...airfoil, thickness: airfoil.thickness + (k % 2) * 1e-12 },
          flap: k < 2 ? flap : null,
          slat: false,
          twist: 0,
          panelStart: strips.length * 2,
          panelCount: 2,
        });
      }
      if (geometry.surfaces.length > 2) {
        strips.push({
          index: strips.length,
          surfaceId: side === 'right' ? 'tip-R' : 'tip-L',
          side,
          eta: 1.05,
          width: 0.5,
          chord: ct * 0.6,
          center: [ct * 0.15, sy * semi, 0.25],
          normal: [0, -sy, 0],
          spanTangent: [0, 0, 1],
          airfoil: { ...airfoil, thickness: 0.1 },
          flap: null,
          slat: false,
          twist: 0,
          panelStart: strips.length * 2,
          panelCount: 2,
        });
      }
    }
    const panelCount = strips.length * 2;
    const z = () => new Float64Array(3 * panelCount);
    return {
      geometry,
      options: { chordwisePanels: 2, spanwisePanelsWing: 4, spanwisePanelsDevice: 1, mach: 0 },
      panelCount,
      strips,
      boundA: z(),
      boundB: z(),
      trailingA: z(),
      trailingB: z(),
      controlPoints: z(),
      normals: z(),
      panelAreas: new Float64Array(panelCount),
    };
  }

  function solveCoupled(
    model: VlmModel,
    alpha: number,
    provider: StripPolarProvider,
  ): CoupledSolution {
    const n = model.strips.length;
    const f = () => new Float64Array(n);
    const sol = {
      alpha,
      gamma: new Float64Array(model.panelCount),
      stripCirculation: f(),
      stripCl: f(),
      stripAlphaInduced: f(),
      stripClViscous: f(),
      stripAlphaEffective: f(),
      stripCd: f(),
      stripClMax: f(),
      stripStalled: new Uint8Array(n),
      stripAttachedFraction: f(),
      CL: 0,
      CDi: 0,
      Cm: -0.05,
      iterations: 3,
      converged: true,
    };
    let liftSum = 0;
    let areaSum = 0;
    model.strips.forEach((s, i) => {
      const re = provider.reynolds(s);
      const polar = provider.polar(s);
      const vertical = Math.abs(s.normal[2]) < 0.5;
      // Downwash grows toward the tip so the root is the last part of the wing to stall.
      const aEff = vertical ? 0.02 : alpha * (0.95 - 0.2 * s.eta);
      const cl = polar.cl(aEff, re);
      sol.stripAlphaEffective[i] = aEff;
      sol.stripAlphaInduced[i] = alpha - aEff;
      sol.stripClViscous[i] = cl;
      sol.stripCl[i] = cl;
      sol.stripClMax[i] = polar.clMax(re);
      sol.stripStalled[i] = aEff > polar.alphaStall(re) ? 1 : 0;
      sol.stripCd[i] = polar.cd(aEff, re);
      sol.stripAttachedFraction[i] = polar.attachedFraction(aEff, re);
      sol.stripCirculation[i] = 0.5 * cl * s.chord;
      if (!vertical) {
        liftSum += cl * s.chord * s.width;
        areaSum += s.chord * s.width;
      }
    });
    const g = model.geometry;
    sol.CL = liftSum / g.referenceArea;
    sol.CDi = (sol.CL * sol.CL) / (Math.PI * g.aspectRatio * 0.9);
    void areaSum;
    return sol;
  }

  return {
    DEG,
    STRIPS_PER_SIDE,
    chordwiseCp,
    getAirfoilModel,
    isaAtmosphere,
    buildWingGeometry: vi.fn(buildWingGeometry),
    buildVlmModel: vi.fn(buildVlmModel),
    solveCoupled: vi.fn(solveCoupled),
    solveVlm: vi.fn((_m: VlmModel, input: { alpha: number }) => ({
      alpha: input.alpha,
      CL: 4.5 * (input.alpha + 0.03),
    })),
    vlmLatticeToTunnel: vi.fn((model: VlmModel) => ({
      count: model.panelCount,
      a: new Float32Array(3 * model.panelCount),
      b: new Float32Array(3 * model.panelCount),
      teA: new Float32Array(3 * model.panelCount),
      teB: new Float32Array(3 * model.panelCount),
      gamma: new Float32Array(model.panelCount),
      sources: {
        count: 0,
        p0: new Float32Array(0),
        p1: new Float32Array(0),
        sigma: new Float32Array(0),
      },
      coreRadius: 0.05,
    })),
    buildThicknessSources: vi.fn(() => ({
      count: 1,
      p0: new Float32Array([0, -1, 0]),
      p1: new Float32Array([0, 1, 0]),
      sigma: new Float32Array([0.5]),
    })),
    computeSectionFlow: vi.fn((model: unknown, input: Record<string, number>) => ({
      ...input,
      model,
    })),
  };
});

vi.mock('./atmosphere', async (importOriginal) => ({
  ...(await importOriginal<typeof AtmosphereModule>()),
  isaAtmosphere: fakes.isaAtmosphere,
}));
vi.mock('./wing/geometry', () => ({
  buildWingGeometry: fakes.buildWingGeometry,
  interpolateSection: vi.fn(),
}));
vi.mock('./wing/vlm', async (importOriginal) => ({
  ...(await importOriginal<typeof VlmModule>()),
  buildVlmModel: fakes.buildVlmModel,
  solveVlm: fakes.solveVlm,
  solveCoupled: fakes.solveCoupled,
  vlmLatticeToTunnel: fakes.vlmLatticeToTunnel,
}));
vi.mock('./airfoil/index', () => ({ getAirfoilModel: fakes.getAirfoilModel }));
vi.mock('./airfoil/sectionFlow', () => ({ computeSectionFlow: fakes.computeSectionFlow }));
vi.mock('./flow/index', () => ({ buildThicknessSources: fakes.buildThicknessSources }));

// Imported after the mocks are registered (vi.mock is hoisted above imports).
import {
  computeAero,
  computePolarSweep,
  computeSection,
  createAeroCache,
  machBucketIndex,
  MACH_BUCKET,
  POLAR_ALPHA_MAX_DEG,
  POLAR_ALPHA_MIN_DEG,
  stableKey,
  stripGeometricAlpha,
} from './aero';

const { DEG } = fakes;

const flapsDown: WingConfig = {
  ...DEFAULT_WING,
  flaps: { ...DEFAULT_WING.flaps, deflectionDeg: 20 },
};
const withWinglets: WingConfig = {
  ...DEFAULT_WING,
  tipDevice: TIP_DEVICE_DEFAULTS['blended-winglet'],
};
const tapered: WingConfig = { ...DEFAULT_WING, taperRatio: 0.5 };

function lastSolution(): CoupledSolution {
  return fakes.solveCoupled.mock.results.at(-1)!.value as CoupledSolution;
}
function lastModel(): VlmModel {
  return fakes.buildVlmModel.mock.results.at(-1)!.value as VlmModel;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stableKey', () => {
  it('ignores property order', () => {
    expect(stableKey({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      stableKey({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
  });
});

describe('machBucketIndex', () => {
  it('buckets Mach to 0.02', () => {
    expect(MACH_BUCKET).toBe(0.02);
    expect(machBucketIndex(0.176)).toBe(9);
    expect(machBucketIndex(0.18)).toBe(9);
    expect(machBucketIndex(0.79)).toBe(40);
  });
});

describe('stripGeometricAlpha', () => {
  const strip = (side: 'right' | 'left', t: [number, number, number], twist = 0): VlmStrip =>
    ({ side, spanTangent: t, twist }) as VlmStrip;

  it('is alpha + twist on a flat wing, on either side', () => {
    expect(stripGeometricAlpha(strip('right', [0, 1, 0], 0.02), 0.1)).toBeCloseTo(0.12, 12);
    expect(stripGeometricAlpha(strip('left', [0, -1, 0], 0.02), 0.1)).toBeCloseTo(0.12, 12);
  });

  it('ignores the chordwise part of a swept span tangent', () => {
    const t: [number, number, number] = [0.4, Math.sqrt(1 - 0.16), 0];
    expect(stripGeometricAlpha(strip('right', t), 0.1)).toBeCloseTo(0.1, 12);
  });

  it('reduces alpha by the dihedral projection', () => {
    const g = 10 * DEG;
    const right = strip('right', [0, Math.cos(g), Math.sin(g)]);
    const left = strip('left', [0, -Math.cos(g), Math.sin(g)]);
    const expected = Math.atan(Math.tan(0.1) * Math.cos(g));
    expect(stripGeometricAlpha(right, 0.1)).toBeCloseTo(expected, 12);
    expect(stripGeometricAlpha(left, 0.1)).toBeCloseTo(expected, 12);
  });

  it('gives a vertical winglet only its own twist (toe)', () => {
    expect(stripGeometricAlpha(strip('right', [0, 0, 1], -0.03), 0.2)).toBeCloseTo(-0.03, 12);
    expect(stripGeometricAlpha(strip('left', [0, 0, 1], -0.03), 0.2)).toBeCloseTo(-0.03, 12);
  });
});

describe('computeAero', () => {
  it('derives atmosphere, Mach, dynamic pressure and Reynolds numbers', () => {
    const flow = { alphaDeg: 4, airspeed: 60, altitude: 1000 };
    const { aero, geometry } = computeAero(tapered, flow, 7, createAeroCache());
    const atm = fakes.isaAtmosphere(1000);
    const re = (len: number) => (atm.density * 60 * len) / atm.dynamicViscosity;
    expect(aero.requestId).toBe(7);
    expect(aero.atmosphere).toEqual(atm);
    expect(aero.velocity).toBe(60);
    expect(aero.alpha).toBeCloseTo(4 * DEG, 14);
    expect(aero.mach).toBeCloseTo(60 / atm.speedOfSound, 12);
    expect(aero.dynamicPressure).toBeCloseTo(0.5 * atm.density * 60 * 60, 9);
    expect(aero.reynoldsMac).toBeCloseTo(re(geometry.meanAeroChord), 3);

    // The coupled solve runs at the root alpha with local-chord Reynolds numbers per strip.
    const [model, alpha, provider] = fakes.solveCoupled.mock.calls[0]!;
    expect(alpha).toBeCloseTo(4 * DEG, 14);
    const chords = new Set(model.strips.map((s) => s.chord));
    expect(chords.size).toBeGreaterThan(1);
    for (const s of model.strips) expect(provider.reynolds(s)).toBeCloseTo(re(s.chord), 3);
  });

  it('assembles coefficients, forces and span efficiency', () => {
    const { aero, geometry } = computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, createAeroCache());
    const sol = lastSolution();
    const model = lastModel();
    expect(aero.CL).toBe(sol.CL);
    expect(aero.CDi).toBe(sol.CDi);
    expect(aero.Cm).toBe(sol.Cm);
    let cdArea = 0;
    model.strips.forEach((s, i) => (cdArea += sol.stripCd[i]! * s.chord * s.width));
    expect(aero.CD0).toBeCloseTo(cdArea / geometry.referenceArea, 14);
    expect(aero.CDw).toBe(0);
    expect(aero.CD).toBeCloseTo(aero.CD0 + aero.CDi + aero.CDw, 14);
    const qS = aero.dynamicPressure * geometry.referenceArea;
    expect(aero.lift).toBeCloseTo(qS * aero.CL, 6);
    expect(aero.drag).toBeCloseTo(qS * aero.CD, 6);
    expect(aero.inducedDrag).toBeCloseTo(qS * aero.CDi, 6);
    expect(aero.force).toEqual([aero.drag, 0, aero.lift]);
    expect(aero.liftToDrag).toBeCloseTo(aero.CL / aero.CD, 12);
    // The fake's CDi is CL^2 / (pi AR 0.9).
    expect(aero.spanEfficiency).toBeCloseTo(0.9, 12);
    // Central difference of the fake linear solve CL = 4.5 (alpha + 0.03).
    expect(aero.liftSlope).toBeCloseTo(4.5, 9);
    expect(aero.machDragDivergence).toBeGreaterThan(aero.machCritical);
    expect(aero.warnings).toEqual([]);
  });

  it('reports NaN span efficiency when the wing carries no lift', () => {
    const real = fakes.solveCoupled.getMockImplementation()!;
    fakes.solveCoupled.mockImplementationOnce((m, a, p) => ({ ...real(m, a, p), CL: 0 }));
    const { aero } = computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, createAeroCache());
    expect(aero.spanEfficiency).toBeNaN();
  });

  it('reports every strip in the tunnel frame with consistent angles', () => {
    const flow = { ...DEFAULT_FLOW, alphaDeg: 8 };
    const alpha = 8 * DEG;
    const { aero, geometry } = computeAero(withWinglets, flow, 1, createAeroCache());
    const sol = lastSolution();
    const model = lastModel();
    expect(aero.strips).toHaveLength(model.strips.length);
    aero.strips.forEach((r, i) => {
      const s = model.strips[i]!;
      expect(r.surfaceId).toBe(s.surfaceId);
      expect(r.side).toBe(s.side);
      expect(r.eta).toBe(s.eta);
      expect(r.center).toEqual(bodyToTunnel(s.center, geometry.pivot, alpha));
      expect(r.normal).toEqual(bodyDirToTunnel(s.normal, alpha));
      expect(r.cl).toBe(sol.stripClViscous[i]);
      expect(r.clMax).toBe(sol.stripClMax[i]);
      expect(r.cd).toBe(sol.stripCd[i]);
      expect(r.alphaEffective).toBe(sol.stripAlphaEffective[i]);
      expect(r.alphaGeometric - r.alphaInduced).toBeCloseTo(r.alphaEffective, 14);
      expect(r.liftPerSpan).toBeCloseTo(aero.dynamicPressure * s.chord * r.cl, 9);
      expect(r.circulation).toBeCloseTo(sol.stripCirculation[i]! * 60, 12);
      expect(r.stalled).toBe(false);
      expect(r.attachedFraction).toBe(1);
      expect(r.cp.xc).toHaveLength(3);
    });
    // Flat base-wing strips see the root alpha; vertical winglets only their own twist.
    expect(aero.strips[0]!.alphaGeometric).toBeCloseTo(alpha, 12);
    const tip = aero.strips.find((s) => s.surfaceId === 'tip-R')!;
    expect(tip.alphaGeometric).toBeCloseTo(0, 12);
    // Chordwise Cp: effective alpha, local Reynolds number, 41 stations, scaled to the strip cl.
    expect(fakes.chordwiseCp).toHaveBeenCalledTimes(model.strips.length);
    const [a, re, n, cl] = fakes.chordwiseCp.mock.calls[0]!;
    expect(a).toBe(aero.strips[0]!.alphaEffective);
    expect(re).toBeGreaterThan(1e6);
    expect(n).toBe(41);
    expect(cl).toBe(aero.strips[0]!.cl);
  });

  it('builds the tunnel-frame lattice with thickness sources', () => {
    const { aero, geometry } = computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, createAeroCache());
    const alpha = DEFAULT_FLOW.alphaDeg * DEG;
    expect(fakes.vlmLatticeToTunnel).toHaveBeenCalledWith(lastModel(), lastSolution(), alpha, 60);
    expect(fakes.buildThicknessSources).toHaveBeenCalledWith(geometry, alpha, 60);
    expect(aero.lattice.count).toBe(lastModel().panelCount);
    expect(aero.lattice.sources.count).toBe(1);
  });

  it('puts the centre of pressure on the centreline, among the strips', () => {
    const { aero } = computeAero(tapered, DEFAULT_FLOW, 1, createAeroCache());
    const xs = aero.strips.map((s) => s.center[0]);
    expect(aero.centerOfPressure[1]).toBeCloseTo(0, 9);
    expect(aero.centerOfPressure[0]).toBeGreaterThanOrEqual(Math.min(...xs));
    expect(aero.centerOfPressure[0]).toBeLessThanOrEqual(Math.max(...xs));
  });

  it('has a positive stall margin and no stall at a moderate angle', () => {
    const { aero } = computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, createAeroCache());
    expect(aero.stall.any).toBe(false);
    expect(aero.stall.fraction).toBe(0);
    expect(aero.stall.firstEta).toBeNull();
    expect(aero.stall.margin).toBeGreaterThan(0.15);
  });

  it('flags where stall will start when a strip nears clMax', () => {
    // alpha 15 deg: the root strip (eta 0.125) reaches alpha_eff ~ 0.242, just below stall.
    const { aero } = computeAero(
      DEFAULT_WING,
      { ...DEFAULT_FLOW, alphaDeg: 15 },
      1,
      createAeroCache(),
    );
    expect(aero.stall.any).toBe(false);
    expect(aero.stall.margin).toBeGreaterThan(0);
    expect(aero.stall.margin).toBeLessThan(0.15);
    expect(aero.stall.firstEta).toBeCloseTo(0.125, 12);
  });

  it('summarises stall over the base-wing span only, with a negative margin', () => {
    // alpha 16 deg: only the root strip of each base wing (1/4 of its span) is stalled.
    const flow = { ...DEFAULT_FLOW, alphaDeg: 16 };
    const { aero } = computeAero(withWinglets, flow, 1, createAeroCache());
    expect(aero.stall.any).toBe(true);
    expect(aero.stall.fraction).toBeCloseTo(0.25, 12);
    expect(aero.stall.margin).toBeLessThan(0);
    expect(aero.stall.firstEta).toBeCloseTo(0.125, 12);
    expect(aero.strips.filter((s) => s.stalled)).toHaveLength(2);
    expect(aero.warnings.some((w) => w.includes('Stall') && w.includes('25%'))).toBe(true);
  });

  it('warns about compressibility above the critical Mach number', () => {
    const flow = { alphaDeg: 2, airspeed: 280, altitude: 11000 };
    const { aero } = computeAero(DEFAULT_WING, flow, 1, createAeroCache());
    expect(aero.mach).toBeGreaterThan(0.9);
    expect(aero.CDw).toBeGreaterThan(0);
    expect(aero.CD).toBeCloseTo(aero.CD0 + aero.CDi + aero.CDw, 14);
    expect(aero.warnings.some((w) => w.includes('compressibility'))).toBe(true);
    expect(aero.warnings.some((w) => w.includes('critical Mach'))).toBe(true);
  });

  it('warns about very low Reynolds numbers', () => {
    const tiny = { ...DEFAULT_WING, span: 0.5, rootChord: 0.1 };
    const { aero } = computeAero(tiny, { ...DEFAULT_FLOW, airspeed: 5 }, 1, createAeroCache());
    expect(aero.reynoldsMac).toBeLessThan(1e5);
    expect(aero.warnings.some((w) => w.includes('Reynolds'))).toBe(true);
  });
});

describe('AeroCache', () => {
  it('reuses geometry and the VLM model across angles and nearby speeds', () => {
    const cache = createAeroCache();
    computeAero(DEFAULT_WING, { alphaDeg: 2, airspeed: 60, altitude: 0 }, 1, cache);
    computeAero(DEFAULT_WING, { alphaDeg: 6, airspeed: 60, altitude: 0 }, 2, cache);
    computeAero(DEFAULT_WING, { alphaDeg: 6, airspeed: 61, altitude: 0 }, 3, cache);
    expect(fakes.buildWingGeometry).toHaveBeenCalledTimes(1);
    expect(fakes.buildVlmModel).toHaveBeenCalledTimes(1);
    expect(fakes.buildVlmModel.mock.calls[0]![1]).toEqual({ mach: 9 * MACH_BUCKET });
    expect(fakes.solveCoupled).toHaveBeenCalledTimes(3);
    // A new Mach bucket needs a new (Prandtl-Glauert) model, but not new geometry.
    computeAero(DEFAULT_WING, { alphaDeg: 6, airspeed: 120, altitude: 0 }, 4, cache);
    expect(fakes.buildVlmModel).toHaveBeenCalledTimes(2);
    expect(fakes.buildWingGeometry).toHaveBeenCalledTimes(1);
    expect(cache.stats.modelBuilds).toBe(2);
  });

  it('returns the cached solution for unchanged inputs, echoing the new requestId', () => {
    const cache = createAeroCache();
    const a = computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, cache);
    const b = computeAero({ ...DEFAULT_WING }, { ...DEFAULT_FLOW }, 2, cache);
    expect(fakes.solveCoupled).toHaveBeenCalledTimes(1);
    expect(b.aero.requestId).toBe(2);
    expect(a.aero.requestId).toBe(1);
    expect(b.aero.strips).toBe(a.aero.strips);
    expect(b.geometry).toBe(a.geometry);
  });

  it('treats a wing with reordered keys as the same wing', () => {
    const cache = createAeroCache();
    computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, cache);
    const reordered = Object.fromEntries(Object.entries(DEFAULT_WING).reverse()) as WingConfig;
    computeAero(reordered, DEFAULT_FLOW, 2, cache);
    expect(fakes.buildWingGeometry).toHaveBeenCalledTimes(1);
    expect(fakes.solveCoupled).toHaveBeenCalledTimes(1);
  });

  it('resolves each distinct strip airfoil once per model, despite float noise', () => {
    const wing = { ...flapsDown, tipDevice: withWinglets.tipDevice, supercritical: true };
    computeAero(wing, DEFAULT_FLOW, 1, createAeroCache());
    // Flapped wing, clean wing and winglet sections.
    expect(fakes.getAirfoilModel).toHaveBeenCalledTimes(3);
    const keys = fakes.getAirfoilModel.mock.calls.map((c) => c[0]);
    expect(keys.every((k) => k.supercritical)).toBe(true);
    const flapped = keys.find((k) => k.flap !== null)!;
    expect(flapped.flap!.deflection).toBeCloseTo(20 * DEG, 4);
    expect(flapped.flap!.chordFrac).toBeCloseTo(0.25, 4);
  });

  it('evicts the least recently used entries beyond its capacity', () => {
    const cache = createAeroCache(2);
    for (const span of [8, 9, 10]) {
      computeAero({ ...DEFAULT_WING, span }, DEFAULT_FLOW, span, cache);
    }
    expect(cache.geometries.size).toBe(2);
    expect(cache.models.size).toBe(2);
    expect(cache.solves.size).toBe(2);
    computeAero({ ...DEFAULT_WING, span: 8 }, DEFAULT_FLOW, 11, cache);
    expect(fakes.buildWingGeometry).toHaveBeenCalledTimes(4);
  });
});

describe('computePolarSweep', () => {
  const wing = { ...DEFAULT_WING, rootIncidenceDeg: 2 };

  it('sweeps alpha from -6 to 24 deg and finds CLmax', () => {
    const polar = computePolarSweep(wing, DEFAULT_FLOW, 3, createAeroCache());
    const n = POLAR_ALPHA_MAX_DEG - POLAR_ALPHA_MIN_DEG + 1;
    expect(n).toBe(31);
    expect(polar.requestId).toBe(3);
    expect(polar.alphaDeg).toHaveLength(n);
    expect(polar.alphaDeg[0]).toBe(-6);
    expect(polar.alphaDeg[n - 1]).toBe(24);
    expect(fakes.solveCoupled).toHaveBeenCalledTimes(n);
    fakes.solveCoupled.mock.calls.forEach(([, a], k) => {
      expect(a).toBeCloseTo((polar.alphaDeg[k]! * Math.PI) / 180, 12);
      const sol = fakes.solveCoupled.mock.results[k]!.value as CoupledSolution;
      expect(polar.CL[k]).toBeCloseTo(sol.CL, 5);
      expect(polar.CD[k]).toBeGreaterThan(sol.CDi);
    });
    const max = Math.max(...polar.CL);
    expect(polar.CLmax).toBe(max);
    expect(polar.alphaStallDeg).toBe(polar.alphaDeg[polar.CL.indexOf(max)]);
    // The stall peak is inside the sweep, with lift falling off after it.
    expect(polar.alphaStallDeg).toBeGreaterThan(10);
    expect(polar.alphaStallDeg).toBeLessThan(24);
  });

  it('adds the root airfoil 2D lift curve at alpha + root incidence', () => {
    const polar = computePolarSweep(wing, DEFAULT_FLOW, 1, createAeroCache());
    const k = polar.alphaDeg.indexOf(4);
    // Fake polar: cl = 2 pi (alpha + 0.03) below stall.
    expect(polar.sectionCl[k]).toBeCloseTo(2 * Math.PI * (6 * DEG + 0.03), 5);
    // The finite wing makes less lift than its 2D section at the same angle.
    expect(polar.CL[k]).toBeLessThan(polar.sectionCl[k]!);
  });

  it('is cached independently of alpha and shares the model with computeAero', () => {
    const cache = createAeroCache();
    computeAero(wing, DEFAULT_FLOW, 1, cache);
    const p1 = computePolarSweep(wing, DEFAULT_FLOW, 1, cache);
    const p2 = computePolarSweep(wing, { ...DEFAULT_FLOW, alphaDeg: 9 }, 2, cache);
    expect(fakes.buildVlmModel).toHaveBeenCalledTimes(1);
    expect(fakes.solveCoupled).toHaveBeenCalledTimes(1 + 31);
    expect(p2.requestId).toBe(2);
    expect(p2.CL).toBe(p1.CL);
    computePolarSweep(wing, { ...DEFAULT_FLOW, airspeed: 30 }, 3, cache);
    expect(cache.stats.polarSweeps).toBe(2);
  });
});

describe('computeSection', () => {
  it('interpolates the right base-wing strips at eta and reuses the 3D solution', () => {
    const cache = createAeroCache();
    computeAero(tapered, DEFAULT_FLOW, 1, cache);
    const sol = lastSolution();
    const model = lastModel();
    const atm = fakes.isaAtmosphere(0);
    computeSection(tapered, DEFAULT_FLOW, 0.45, cache);
    expect(fakes.solveCoupled).toHaveBeenCalledTimes(1);
    // Right strips sit at eta 0.125, 0.375, 0.625, 0.875 => between strips 1 and 2, t = 0.3.
    const t = 0.3;
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const [airfoilModel, input] = fakes.computeSectionFlow.mock.calls[0]!;
    const alpha = DEFAULT_FLOW.alphaDeg * DEG;
    const alphaEff = lerp(sol.stripAlphaEffective[1]!, sol.stripAlphaEffective[2]!);
    const reAt = (i: number) => (atm.density * 60 * model.strips[i]!.chord) / atm.dynamicViscosity;
    expect(input.eta).toBe(0.45);
    expect(input.alphaGeometric).toBeCloseTo(alpha, 12);
    expect(input.alphaInduced).toBeCloseTo(alpha - alphaEff, 12);
    expect(input.reynolds).toBeCloseTo(lerp(reAt(1), reAt(2)), 3);
    expect(input.alphaInduced).toBeGreaterThan(0);
    expect(airfoilModel).toBe(fakes.getAirfoilModel.mock.results[0]!.value);
  });

  it('uses the nearest strip airfoil, so flaps show inside the flapped span only', () => {
    const cache = createAeroCache();
    computeSection(flapsDown, DEFAULT_FLOW, 0.45, cache); // nearest: strip 1 (flapped)
    computeSection(flapsDown, DEFAULT_FLOW, 0.55, cache); // nearest: strip 2 (clean)
    const [m1] = fakes.computeSectionFlow.mock.calls[0]! as [{ key: AirfoilKey }, unknown];
    const [m2] = fakes.computeSectionFlow.mock.calls[1]! as [{ key: AirfoilKey }, unknown];
    expect(m1.key.flap).not.toBeNull();
    expect(m2.key.flap).toBeNull();
  });

  it('clamps eta to the wing and holds the end strips beyond their centres', () => {
    const cache = createAeroCache();
    computeSection(DEFAULT_WING, DEFAULT_FLOW, 1.4, cache);
    computeSection(DEFAULT_WING, DEFAULT_FLOW, -1, cache);
    const sol = lastSolution();
    const alpha = DEFAULT_FLOW.alphaDeg * DEG;
    const [, tipIn] = fakes.computeSectionFlow.mock.calls[0]!;
    const [, rootIn] = fakes.computeSectionFlow.mock.calls[1]!;
    expect(tipIn.eta).toBe(1);
    expect(rootIn.eta).toBe(0);
    expect(tipIn.alphaInduced).toBeCloseTo(alpha - sol.stripAlphaEffective[3]!, 12);
    expect(rootIn.alphaInduced).toBeCloseTo(alpha - sol.stripAlphaEffective[0]!, 12);
  });
});
