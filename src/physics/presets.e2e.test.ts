/**
 * Every aircraft preset through the REAL solvers: cruise trim, drag, Mach margins, maximum lift
 * (clean, high-lift and at cruise Mach), tip devices and worker stage timings. These pin the
 * numbers that docs/AIRCRAFT_DATA.md and the lessons quote, so a solver change that breaks a
 * preset shows up here first.
 */
import { describe, expect, it } from 'vitest';
import type { AircraftPreset, PresetCategory } from '../state/presets';
import type { PhysicsResponse } from '../worker/protocol';
import type { TipDeviceKind, WingConfig } from '../state/params';
import { PRESETS, getPreset } from '../state/presets';
import { DEFAULT_VIEW, TIP_DEVICE_DEFAULTS } from '../state/params';
import { STAGE_ORDER } from '../worker/protocol';
import { createWorkerState, handleRequest, STAGE_BUDGET_MS } from '../worker/physics.worker';
import { computeAero, computePolarSweep, createAeroCache } from './aero';

const G = 9.80665;
/** Presets that model a real aircraft (the teaching wing has no meaningful weight). */
const AIRCRAFT = PRESETS.filter((p) => p.category !== 'teaching');
const AIRLINERS = AIRCRAFT.filter((p) => p.category === 'airliner');

/** Wing-alone lift-to-drag ratio at cruise, by class (no fuselage, tail or engines). */
const LD_RANGE: Record<Exclude<PresetCategory, 'teaching'>, [number, number]> = {
  airliner: [22, 40],
  'general-aviation': [15, 32],
  glider: [30, 70],
  fighter: [10, 30],
};

const cruise = (p: AircraftPreset) => computeAero(p.wing, p.cruise, 1, createAeroCache()).aero;

const withHighLift = (w: WingConfig, flapDeg: number): WingConfig => ({
  ...w,
  flaps: { ...w.flaps, deflectionDeg: flapDeg },
  slats: true,
});

describe('aircraft presets at cruise (real solvers)', { timeout: 120_000 }, () => {
  it.each(AIRCRAFT.map((p) => [p.id, p] as const))(
    '%s: lift equals the cruise weight within 3 %%',
    (_id, p) => {
      const aero = cruise(p);
      const weight = p.typicalCruiseMassKg * G;
      expect(Math.abs(aero.lift / weight - 1)).toBeLessThan(0.03);
    },
  );

  it.each(AIRCRAFT.map((p) => [p.id, p] as const))(
    '%s: finite results, attached flow and a plausible wing-alone L/D',
    (_id, p) => {
      const aero = cruise(p);
      for (const v of [aero.CL, aero.CD, aero.CDi, aero.CD0, aero.lift, aero.drag, aero.Cm]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      for (const s of aero.strips) {
        expect(Number.isFinite(s.cl) && Number.isFinite(s.cd), `${p.id} strip ${s.eta}`).toBe(true);
        expect(s.cp.upper.every(Number.isFinite) && s.cp.lower.every(Number.isFinite)).toBe(true);
      }
      expect(aero.stall.any).toBe(false);
      // Every strip at least 0.15 below its maximum lift. The tightest one is the root strip of
      // the 747-400's winglet (about 0.2), which the lattice hangs along the whole tip chord.
      expect(aero.stall.margin).toBeGreaterThan(0.15);
      const [lo, hi] = LD_RANGE[p.category as keyof typeof LD_RANGE];
      expect(aero.liftToDrag).toBeGreaterThan(lo);
      expect(aero.liftToDrag).toBeLessThan(hi);
      expect(aero.warnings).toEqual([]);
    },
  );

  it.each(AIRLINERS.map((p) => [p.id, p] as const))(
    '%s: cruises at 1-4 deg, between the critical and the drag-divergence Mach number',
    (_id, p) => {
      const aero = cruise(p);
      expect(p.cruise.alphaDeg).toBeGreaterThanOrEqual(1);
      expect(p.cruise.alphaDeg).toBeLessThanOrEqual(4);
      expect(aero.mach).toBeGreaterThan(aero.machCritical);
      expect(aero.mach).toBeLessThanOrEqual(aero.machDragDivergence);
      // Near drag divergence, not far below it, and only a little wave drag.
      expect(aero.machDragDivergence - aero.mach).toBeLessThan(0.07);
      expect(aero.CDw).toBeLessThan(0.0025);
    },
  );
});

describe('maximum lift of the presets (real solvers)', { timeout: 120_000 }, () => {
  it.each(AIRLINERS.map((p) => [p.id, p] as const))(
    '%s: clean CLmax 1.3-1.65 and 2.3-3.0 with flaps and slats at approach speed',
    (_id, p) => {
      const cache = createAeroCache();
      const clean = computePolarSweep(p.wing, p.approach, 1, cache);
      expect(clean.CLmax).toBeGreaterThan(1.3);
      expect(clean.CLmax).toBeLessThan(1.65);
      const landing = computePolarSweep(withHighLift(p.wing, 30), p.approach, 1, cache);
      expect(landing.CLmax).toBeGreaterThan(2.3);
      expect(landing.CLmax).toBeLessThan(3.0);
    },
  );

  it.each(AIRLINERS.map((p) => [p.id, p] as const))(
    '%s: at cruise Mach the wing buffets near CL 0.8-1.2, 2-7 deg above cruise',
    (_id, p) => {
      const cache = createAeroCache();
      const polar = computePolarSweep(p.wing, p.cruise, 1, cache);
      expect(polar.CLmax).toBeGreaterThan(0.8);
      expect(polar.CLmax).toBeLessThan(1.2);
      const margin = polar.alphaStallDeg - p.cruise.alphaDeg;
      expect(margin).toBeGreaterThanOrEqual(2);
      expect(margin).toBeLessThanOrEqual(7);
      const past = computeAero(
        p.wing,
        { ...p.cruise, alphaDeg: polar.alphaStallDeg + 2 },
        1,
        cache,
      );
      expect(past.aero.stall.any).toBe(true);
      expect(past.aero.warnings.some((w) => w.includes('buffet'))).toBe(true);
    },
  );

  it('loses maximum lift smoothly as Mach rises (737-800)', () => {
    const p = getPreset('b737-800')!;
    const cache = createAeroCache(8);
    let prev = Infinity;
    for (let mach = 0.3; mach <= 0.861; mach += 0.04) {
      const airspeed = mach * 295.07; // speed of sound at 11 km
      const { CLmax } = computePolarSweep(p.wing, { ...p.cruise, airspeed }, 1, cache);
      // Rises slightly with Reynolds number at first (and the 1 deg sweep samples the peak),
      // then falls steeply but continuously towards cruise Mach.
      expect(CLmax, `Mach ${mach.toFixed(2)}`).toBeLessThan(prev + 0.07);
      if (Number.isFinite(prev)) expect(prev - CLmax, `Mach ${mach.toFixed(2)}`).toBeLessThan(0.3);
      prev = CLmax;
    }
    expect(prev).toBeLessThan(1.0);
  });

  it.each(['cessna-172', 'glider-18m'].map((id) => [id, getPreset(id)!] as const))(
    '%s: low-speed stall is untouched by the Mach model (CLmax 1.3-1.7 at 13-20 deg)',
    (_id, p) => {
      const polar = computePolarSweep(p.wing, p.cruise, 1, createAeroCache());
      expect(polar.CLmax).toBeGreaterThan(1.3);
      expect(polar.CLmax).toBeLessThan(1.7);
      expect(polar.alphaStallDeg).toBeGreaterThanOrEqual(13);
      expect(polar.alphaStallDeg).toBeLessThanOrEqual(20);
    },
  );
});

describe('flaps at cruise Mach (real solvers)', { timeout: 120_000 }, () => {
  // Flaps are never lowered at cruise Mach, but the slider allows it: past the buffet limit the
  // wing must still pay for every extra degree of flap, and never lift less than the clean wing.
  it.each(AIRLINERS.map((p) => [p.id, p] as const))(
    '%s: drag rises with every flap step and lift stays above the clean wing',
    (_id, p) => {
      const at = (deg: number) =>
        computeAero(
          { ...p.wing, flaps: { ...p.wing.flaps, deflectionDeg: deg } },
          p.cruise,
          1,
          createAeroCache(),
        ).aero;
      const clean = at(0);
      let prev = clean;
      for (let deg = 5; deg <= 40; deg += 5) {
        const aero = at(deg);
        expect(aero.CD, `${p.id} flaps ${deg}`).toBeGreaterThan(prev.CD);
        expect(aero.CL, `${p.id} flaps ${deg}`).toBeGreaterThan(clean.CL);
        prev = aero;
      }
    },
  );
});

describe('tip devices on the 737-800 wing (real solvers)', { timeout: 120_000 }, () => {
  const base = getPreset('b737-800')!;
  /** Root angle (deg) that gives `target` CL, by bisection. */
  function trim(wing: WingConfig, target: number): ReturnType<typeof computeAero>['aero'] {
    const cache = createAeroCache(64);
    const at = (a: number) => computeAero(wing, { ...base.cruise, alphaDeg: a }, 1, cache).aero;
    let lo = -2;
    let hi = 10;
    for (let i = 0; i < 30; i++) {
      const mid = 0.5 * (lo + hi);
      if (at(mid).CL < target) lo = mid;
      else hi = mid;
    }
    return at(0.5 * (lo + hi));
  }
  const none = trim({ ...base.wing, tipDevice: TIP_DEVICE_DEFAULTS.none }, 0.6);
  const kinds = (Object.keys(TIP_DEVICE_DEFAULTS) as TipDeviceKind[]).filter((k) => k !== 'none');

  it.each(kinds)('%s cuts induced drag at the same lift (CL 0.6, cruise)', (kind) => {
    const dev = trim({ ...base.wing, tipDevice: TIP_DEVICE_DEFAULTS[kind] }, 0.6);
    expect(dev.CL).toBeCloseTo(none.CL, 3);
    expect(dev.CDi).toBeLessThan(0.99 * none.CDi);
    expect(dev.CDi).toBeGreaterThan(0.75 * none.CDi);
  });
});

describe('worker pipeline per preset', { timeout: 120_000 }, () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))(
    '%s: every stage succeeds, each well inside the time budget',
    async (_id, p) => {
      const posted: PhysicsResponse[] = [];
      await handleRequest(
        {
          type: 'compute',
          requestId: 1,
          wing: p.wing,
          flow: p.cruise,
          rake: DEFAULT_VIEW.rake,
          sectionEta: 0.35,
          stages: [...STAGE_ORDER],
          fieldQuality: 1,
        },
        (msg) => posted.push(msg),
        () => false,
        createWorkerState(),
      );
      expect(posted.filter((m) => m.type === 'error')).toEqual([]);
      expect(posted.map((m) => m.type)).toEqual([...STAGE_ORDER, 'done']);
      const done = posted.at(-1)!;
      if (done.type !== 'done') throw new Error('expected done');
      for (const stage of STAGE_ORDER) {
        const ms = done.timingsMs?.[stage] ?? NaN;
        // The worker itself warns above STAGE_BUDGET_MS; fail only far beyond it (slow CI).
        expect(ms, `${p.id} ${stage}`).toBeLessThan(5 * STAGE_BUDGET_MS);
      }
    },
  );
});
