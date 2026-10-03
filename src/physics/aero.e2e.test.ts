/**
 * End-to-end physics checks against the REAL solvers (airfoil, geometry, VLM, flow). They are
 * skipped until every module the pipeline needs is implemented, then run automatically.
 * Assertions are sanity ranges from textbook aerodynamics, not exact values.
 */
import { describe, expect, it } from 'vitest';
import type { FlowConditions, WingConfig } from '../state/params';
import type { PhysicsResponse } from '../worker/protocol';
import { DEFAULT_FLOW, DEFAULT_VIEW, DEFAULT_WING, TIP_DEVICE_DEFAULTS } from '../state/params';
import { isaAtmosphere } from './atmosphere';
import { buildWingGeometry } from './wing/geometry';
import { buildVlmModel, solveCoupled, solveVlm, vlmLatticeToTunnel } from './wing/vlm';
import { getAirfoilModel } from './airfoil/index';
import { computeSectionFlow } from './airfoil/sectionFlow';
import {
  buildFlowFieldGrid,
  buildThicknessSources,
  seedStreamlines,
  traceStreamlines,
} from './flow/index';
import { computeAero, computePolarSweep, computeSection, createAeroCache } from './aero';
import { STAGE_ORDER } from '../worker/protocol';
import { createWorkerState, fieldTargetNodes, handleRequest } from '../worker/physics.worker';

/** True unless calling `fn` hits a contract stub ("Not implemented yet: ..."). */
function implemented(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    return !(err instanceof Error && err.message.startsWith('Not implemented yet'));
  }
}

const anything = undefined as never;
const physicsReady = [
  () => isaAtmosphere(0),
  () => buildWingGeometry(DEFAULT_WING),
  () =>
    getAirfoilModel({
      params: DEFAULT_WING.airfoil,
      flap: null,
      slat: false,
      supercritical: false,
    }),
  // With placeholder arguments a real implementation throws a TypeError (fine); a stub throws
  // "Not implemented yet".
  () => computeSectionFlow(anything, anything),
  () => buildVlmModel(anything),
  () => solveVlm(anything, anything),
  () => solveCoupled(anything, anything, anything),
  () => vlmLatticeToTunnel(anything, anything, anything, anything),
  () => buildThicknessSources(anything, anything, anything),
  () => buildFlowFieldGrid(anything, anything, anything, anything, anything, anything),
  () => seedStreamlines(anything, anything, anything, anything),
  () => traceStreamlines(anything, anything, anything, anything, anything, anything),
].every(implemented);

const DEG = Math.PI / 180;

/** A 737-800-like wing (reference trapezoid ~132 m^2, AR ~8.9, 25 deg sweep). */
const B737_LIKE: WingConfig = {
  ...DEFAULT_WING,
  span: 34.3,
  rootChord: 6.2,
  taperRatio: 0.24,
  sweepDeg: 25,
  dihedralDeg: 6,
  rootIncidenceDeg: 1.5,
  washoutDeg: 3,
  airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
  supercritical: true,
};
/** Cruise: FL350, Mach ~0.78. */
const CRUISE: FlowConditions = { alphaDeg: 2.5, airspeed: 231, altitude: 10668 };

const solve = (wing: WingConfig, flow: FlowConditions) =>
  computeAero(wing, flow, 1, createAeroCache());

/** Evaluate once, on first use inside a test (never during collection). */
function lazy<T>(make: () => T): () => T {
  let value: { v: T } | null = null;
  return () => (value ??= { v: make() }).v;
}

describe.skipIf(!physicsReady)('aero end-to-end (real solvers)', { timeout: 60_000 }, () => {
  describe('rectangular teaching wing (AR 6.7, NACA 2412, 5 deg, 60 m/s)', () => {
    const rect = lazy(() => solve(DEFAULT_WING, DEFAULT_FLOW));

    it('makes lift close to lifting-line theory', () => {
      const { aero } = rect();
      // a = 2 pi AR / (AR + 2) ~ 4.8 /rad; alpha - alpha0 ~ 7 deg => CL ~ 0.6.
      expect(aero.CL).toBeGreaterThan(0.45);
      expect(aero.CL).toBeLessThan(0.8);
      expect(aero.liftSlope).toBeGreaterThan(3.8);
      expect(aero.liftSlope).toBeLessThan(5.5);
    });

    it('has a plausible span efficiency and drag breakdown', () => {
      const { aero, geometry } = rect();
      expect(aero.spanEfficiency).toBeGreaterThan(0.75);
      expect(aero.spanEfficiency).toBeLessThan(1.02);
      expect(aero.CDi).toBeCloseTo(
        (aero.CL * aero.CL) / (Math.PI * geometry.aspectRatio * aero.spanEfficiency),
        10,
      );
      expect(aero.CD0).toBeGreaterThan(0.004);
      expect(aero.CD0).toBeLessThan(0.02);
      expect(aero.CDw).toBe(0);
      expect(aero.liftToDrag).toBeGreaterThan(10);
      expect(aero.liftToDrag).toBeLessThan(40);
    });

    it('reports forces in newtons in the tunnel frame', () => {
      const { aero, geometry } = rect();
      expect(aero.dynamicPressure).toBeCloseTo(0.5 * 1.225 * 60 * 60, 0);
      expect(aero.lift).toBeCloseTo(aero.dynamicPressure * geometry.referenceArea * aero.CL, 6);
      expect(aero.force[2]).toBe(aero.lift);
      expect(aero.force[0]).toBeGreaterThan(0);
      expect(aero.stall.any).toBe(false);
      expect(aero.warnings).toEqual([]);
    });

    it('is symmetric and has downwash on every base-wing strip', () => {
      const { aero, geometry } = rect();
      const right = aero.strips.filter((s) => s.side === 'right' && s.eta <= 1);
      const left = aero.strips.filter((s) => s.side === 'left' && s.eta <= 1);
      expect(right.length).toBeGreaterThan(4);
      expect(left.length).toBe(right.length);
      for (const r of right) {
        const l = left.find((s) => Math.abs(s.eta - r.eta) < 1e-6)!;
        expect(l).toBeDefined();
        expect(l.cl).toBeCloseTo(r.cl, 6);
        expect(l.center[1]).toBeCloseTo(-r.center[1], 6);
        expect(r.alphaInduced).toBeGreaterThan(0);
        expect(r.alphaEffective).toBeLessThan(r.alphaGeometric);
        expect(r.cp.xc.length).toBe(41);
      }
      expect(aero.centerOfPressure[1]).toBeCloseTo(0, 6);
      // Lift acts along the quarter-chord line of an unswept wing (the pivot line).
      expect(Math.abs(aero.centerOfPressure[0] - geometry.pivot[0])).toBeLessThan(0.1 * 1.5);
    });

    it('sucks on the upper surface', () => {
      const { aero } = rect();
      const mid = aero.strips.find((s) => s.side === 'right' && s.eta > 0.3 && s.eta < 0.7)!;
      const mean = (a: Float32Array) => a.reduce((x, y) => x + y, 0) / a.length;
      expect(mean(mid.cp.upper)).toBeLessThan(mean(mid.cp.lower));
    });

    it('builds a tunnel-frame lattice with thickness sources', () => {
      const { aero } = rect();
      expect(aero.lattice.count).toBeGreaterThan(0);
      expect(aero.lattice.sources.count).toBeGreaterThan(0);
      expect(aero.lattice.gamma.every(Number.isFinite)).toBe(true);
    });
  });

  it('scales lift with V^2', () => {
    const slow = solve(DEFAULT_WING, { ...DEFAULT_FLOW, airspeed: 30 }).aero;
    const fast = solve(DEFAULT_WING, { ...DEFAULT_FLOW, airspeed: 60 }).aero;
    expect(fast.dynamicPressure / slow.dynamicPressure).toBeCloseTo(4, 9);
    const ratio = fast.lift / slow.lift;
    expect(ratio).toBeGreaterThan(3.8);
    expect(ratio).toBeLessThan(4.3);
  });

  it('scales lift with air density', () => {
    const low = solve(DEFAULT_WING, { ...DEFAULT_FLOW, altitude: 0 }).aero;
    const high = solve(DEFAULT_WING, { ...DEFAULT_FLOW, altitude: 6000 }).aero;
    const densityRatio = high.atmosphere.density / low.atmosphere.density;
    expect(densityRatio).toBeGreaterThan(0.5);
    expect(densityRatio).toBeLessThan(0.6);
    const liftRatio = high.lift / low.lift;
    expect(liftRatio / densityRatio).toBeGreaterThan(0.95);
    expect(liftRatio / densityRatio).toBeLessThan(1.05);
  });

  it('flaps add lift at the same angle of attack', () => {
    const clean = solve(DEFAULT_WING, DEFAULT_FLOW).aero;
    const flapped = solve(
      { ...DEFAULT_WING, flaps: { ...DEFAULT_WING.flaps, deflectionDeg: 20 } },
      DEFAULT_FLOW,
    ).aero;
    expect(flapped.CL).toBeGreaterThan(clean.CL + 0.2);
    expect(flapped.CD0).toBeGreaterThan(clean.CD0);
  });

  it('winglets raise span efficiency (less induced drag for the same lift)', () => {
    const plain = solve(DEFAULT_WING, DEFAULT_FLOW).aero;
    const winglet = solve(
      { ...DEFAULT_WING, tipDevice: TIP_DEVICE_DEFAULTS['blended-winglet'] },
      DEFAULT_FLOW,
    ).aero;
    expect(winglet.spanEfficiency).toBeGreaterThan(plain.spanEfficiency);
  });

  describe('737-like wing at cruise (FL350, Mach 0.78, alpha 2.5 deg + 1.5 deg incidence)', () => {
    const cruise = lazy(() => solve(B737_LIKE, CRUISE).aero);

    it('cruises at an airliner lift coefficient', () => {
      const aero = cruise();
      expect(aero.mach).toBeGreaterThan(0.76);
      expect(aero.mach).toBeLessThan(0.8);
      expect(aero.CL).toBeGreaterThan(0.3);
      expect(aero.CL).toBeLessThan(0.75);
    });

    it('has a wing-alone L/D in the airliner range', () => {
      const aero = cruise();
      expect(aero.liftToDrag).toBeGreaterThan(12);
      expect(aero.liftToDrag).toBeLessThan(40);
    });

    it('estimates transonic limits near the cruise Mach number', () => {
      const aero = cruise();
      expect(aero.machCritical).toBeGreaterThan(0.6);
      expect(aero.machCritical).toBeLessThan(0.85);
      expect(aero.machDragDivergence).toBeGreaterThan(aero.machCritical);
      expect(aero.reynoldsMac).toBeGreaterThan(1e7);
    });

    it('cruises between the critical and the drag-divergence Mach number, without warnings', () => {
      const aero = cruise();
      expect(aero.mach).toBeGreaterThan(aero.machCritical);
      expect(aero.mach).toBeLessThan(aero.machDragDivergence);
      expect(aero.warnings).toEqual([]);
    });

    it('adds wave drag and a warning when pushed past drag divergence', () => {
      const fast = solve(B737_LIKE, { ...CRUISE, airspeed: 262 }).aero; // Mach ~0.88
      expect(fast.mach).toBeGreaterThan(fast.machDragDivergence);
      expect(fast.CDw).toBeGreaterThan(0.003);
      expect(fast.warnings.some((w) => w.includes('drag divergence'))).toBe(true);
    });
  });

  describe('maximum lift falls with Mach (sweep + shock-induced separation)', () => {
    const cruisePolar = lazy(() => computePolarSweep(B737_LIKE, CRUISE, 1, createAeroCache()));
    const lowPolar = lazy(() =>
      computePolarSweep(B737_LIKE, { ...CRUISE, airspeed: 75, altitude: 0 }, 1, createAeroCache()),
    );

    it('has an airliner-like clean CLmax at low speed', () => {
      const polar = lowPolar();
      expect(polar.CLmax).toBeGreaterThan(1.3);
      expect(polar.CLmax).toBeLessThan(1.7);
    });

    it('buffets at a much lower lift, a few degrees above cruise, near Mach 0.78', () => {
      const polar = cruisePolar();
      expect(polar.CLmax).toBeGreaterThan(0.8);
      expect(polar.CLmax).toBeLessThan(1.25);
      expect(polar.alphaStallDeg).toBeGreaterThan(CRUISE.alphaDeg + 2);
      expect(polar.alphaStallDeg).toBeLessThan(CRUISE.alphaDeg + 9);
      // The 2D "endless wing" curve is limited the same way (no cl ~ 3 at cruise Mach).
      expect(Math.max(...polar.sectionCl)).toBeLessThan(1.4);
    });

    it('reports the high-speed stall in the strips, the summary and the warnings', () => {
      const polar = cruisePolar();
      const deep = solve(B737_LIKE, { ...CRUISE, alphaDeg: polar.alphaStallDeg + 3 }).aero;
      expect(deep.stall.any).toBe(true);
      expect(deep.stall.fraction).toBeGreaterThan(0.1);
      expect(deep.strips.some((s) => s.stalled)).toBe(true);
      expect(deep.CL).toBeLessThan(polar.CLmax);
      expect(deep.warnings.some((w) => w.includes('buffet'))).toBe(true);
      // Every strip's clMax is the real (compressible) maximum, not a Prandtl-Glauert-inflated one.
      for (const s of deep.strips.filter((s) => s.eta <= 1)) expect(s.clMax).toBeLessThan(1.4);
    });
  });

  describe('polar sweep', () => {
    const sweep = lazy(() => computePolarSweep(DEFAULT_WING, DEFAULT_FLOW, 1, createAeroCache()));

    it('rises linearly and then stalls at a realistic CLmax', () => {
      const polar = sweep();
      expect(polar.alphaDeg).toHaveLength(31);
      const at = (deg: number) => polar.alphaDeg.indexOf(deg);
      for (let k = at(-6); k < at(8); k++) expect(polar.CL[k + 1]!).toBeGreaterThan(polar.CL[k]!);
      expect(polar.CLmax).toBeGreaterThan(1.0);
      expect(polar.CLmax).toBeLessThan(1.8);
      expect(polar.alphaStallDeg).toBeGreaterThan(10);
      expect(polar.alphaStallDeg).toBeLessThan(23);
    });

    it('shows the finite wing making less lift than its 2D section', () => {
      const polar = sweep();
      const k = polar.alphaDeg.indexOf(8);
      expect(polar.sectionCl[k]!).toBeGreaterThan(polar.CL[k]!);
      expect(polar.CD.every((cd) => cd > 0)).toBe(true);
    });

    it('stalls in the 3D solution when the sweep says so', () => {
      const polar = sweep();
      const deep = solve(DEFAULT_WING, { ...DEFAULT_FLOW, alphaDeg: polar.alphaStallDeg + 4 }).aero;
      expect(deep.stall.any).toBe(true);
      expect(deep.stall.fraction).toBeGreaterThan(0);
      expect(deep.stall.margin).toBeLessThan(0);
      expect(deep.warnings.some((w) => w.startsWith('Stall'))).toBe(true);
    });
  });

  it('computes the 2D section at the 3D effective angle', () => {
    const cache = createAeroCache();
    const { aero } = computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, cache);
    const section = computeSection(DEFAULT_WING, DEFAULT_FLOW, 0.35, cache);
    expect(section.eta).toBeCloseTo(0.35, 12);
    expect(section.alphaGeometric).toBeCloseTo(DEFAULT_FLOW.alphaDeg * DEG, 3);
    expect(section.alphaInduced).toBeGreaterThan(0);
    expect(section.alphaEffective).toBeLessThan(section.alphaGeometric);
    const near = aero.strips
      .filter((s) => s.side === 'right' && s.eta <= 1)
      .reduce((a, b) => (Math.abs(b.eta - 0.35) < Math.abs(a.eta - 0.35) ? b : a));
    expect(section.cl).toBeGreaterThan(0.85 * near.cl);
    expect(section.cl).toBeLessThan(1.15 * near.cl);
  });

  it('reports the section lift with the same compressibility factor as the strips', () => {
    const cache = createAeroCache();
    const { aero } = computeAero(B737_LIKE, CRUISE, 1, cache);
    const section = computeSection(B737_LIKE, CRUISE, 0.35, cache);
    const near = aero.strips
      .filter((s) => s.side === 'right' && s.eta <= 1)
      .reduce((a, b) => (Math.abs(b.eta - 0.35) < Math.abs(a.eta - 0.35) ? b : a));
    expect(aero.mach).toBeGreaterThan(0.75);
    expect(section.cl).toBeGreaterThan(0.85 * near.cl);
    expect(section.cl).toBeLessThan(1.15 * near.cl);
    let cpLift = 0;
    const { xc, upper, lower } = section.cp;
    for (let k = 1; k < xc.length; k++) {
      const dx = xc[k]! - xc[k - 1]!;
      cpLift += 0.5 * dx * (lower[k]! - upper[k]! + lower[k - 1]! - upper[k - 1]!);
    }
    expect(cpLift).toBeCloseTo(section.cl, 1);
  });

  it('runs the full worker pipeline without errors', async () => {
    const posted: PhysicsResponse[] = [];
    await handleRequest(
      {
        type: 'compute',
        requestId: 1,
        wing: DEFAULT_WING,
        flow: DEFAULT_FLOW,
        rake: DEFAULT_VIEW.rake,
        sectionEta: 0.35,
        stages: [...STAGE_ORDER],
        fieldQuality: 0.1,
      },
      (msg) => posted.push(msg),
      () => false,
      createWorkerState(),
    );
    const errors = posted.filter((m) => m.type === 'error');
    expect(errors).toEqual([]);
    expect(posted.map((m) => m.type)).toEqual([...STAGE_ORDER, 'done']);
    const lines = posted.find((m) => m.type === 'streamlines')!;
    expect(lines.type === 'streamlines' && lines.streamlines.length).toBeGreaterThan(0);
    const field = posted.find((m) => m.type === 'field')!;
    if (field.type !== 'field') throw new Error('unreachable');
    const [nx, ny, nz] = field.field.dims;
    expect(nx * ny * nz).toBeGreaterThan(fieldTargetNodes(0.1) / 3);
    expect(nx * ny * nz).toBeLessThan(fieldTargetNodes(0.1) * 3);
  });
});
