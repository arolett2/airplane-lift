/**
 * Truth check of the guided tour: every quantitative or qualitative claim the lessons make is
 * computed here with the REAL solvers, at the exact tunnel state the lesson step sets up
 * (replayed with applyLessonUpTo). If a solver or preset change makes a sentence false, the test
 * names the step to fix.
 */
import { describe, expect, it } from 'vitest';
import type { AeroResult } from './types';
import type { AppState, FlowConditions, WingConfig } from '../state/params';
import { DEFAULT_STATE } from '../state/params';
import { getPreset } from '../state/presets';
import { LESSONS } from '../content/lessons';
import { applyLessonUpTo } from '../content/applyStep';
import { computeAero, computePolarSweep, computeSection, createAeroCache } from './aero';

const G = 9.80665;
const KNOT = 0.514444;
const cache = createAeroCache(64);

/** The tunnel state a lesson step sets up (the lesson replayed from the default state). */
function stateAt(lessonId: string, stepId: string): AppState {
  const lesson = LESSONS.find((l) => l.id === lessonId);
  if (!lesson) throw new Error(`no lesson ${lessonId}`);
  const index = lesson.steps.findIndex((s) => s.id === stepId);
  if (index < 0) throw new Error(`no step ${stepId}`);
  return applyLessonUpTo(DEFAULT_STATE, lesson.steps, index);
}

const aero = (wing: WingConfig, flow: FlowConditions): AeroResult =>
  computeAero(wing, flow, 1, cache).aero;
const at = (s: AppState, flow: Partial<FlowConditions> = {}, wing: Partial<WingConfig> = {}) =>
  aero({ ...s.wing, ...wing }, { ...s.flow, ...flow });
const weightOf = (presetId: string) => getPreset(presetId)!.typicalCruiseMassKg * G;

/** First root angle (0.5 deg steps) at which any strip stalls, and where along the span. */
function firstStall(wing: WingConfig, flow: FlowConditions, from = 0, to = 25) {
  for (let a = from; a <= to; a += 0.5) {
    const r = aero(wing, { ...flow, alphaDeg: a });
    if (r.stall.any) {
      const stalled = r.strips.filter((s) => s.side === 'right' && s.eta <= 1 && s.stalled);
      const meanEta = stalled.reduce((sum, s) => sum + s.eta, 0) / Math.max(1, stalled.length);
      return { alphaDeg: a, meanEta };
    }
  }
  return null;
}

describe('lesson claims hold in the tunnel (real solvers)', { timeout: 120_000 }, () => {
  describe('What is lift?', () => {
    it('pressure: blue (suction) on top, slightly red underneath, at 5 deg', () => {
      const s = stateAt('what-is-lift', 'what-is-lift-pressure');
      const r = at(s);
      const mid = r.strips.find((x) => x.side === 'right' && x.eta > 0.3 && x.eta < 0.6)!;
      const mean = (a: Float32Array) => a.reduce((x, y) => x + y, 0) / a.length;
      expect(mean(mid.cp.upper)).toBeLessThan(-0.2);
      expect(mean(mid.cp.lower)).toBeGreaterThan(0);
    });

    it('fast air: the strongest suction sits just behind the leading edge', () => {
      const s = stateAt('what-is-lift', 'what-is-lift-fast-air');
      const mid = at(s).strips.find((x) => x.side === 'right' && x.eta > 0.3 && x.eta < 0.6)!;
      let k = 0;
      for (let i = 1; i < mid.cp.upper.length; i++) if (mid.cp.upper[i]! < mid.cp.upper[k]!) k = i;
      expect(mid.cp.xc[k]!).toBeLessThan(0.15);
    });

    it('raising the angle makes more lift (both-views step)', () => {
      const s = stateAt('what-is-lift', 'what-is-lift-both-views');
      expect(at(s, { alphaDeg: 8 }).lift).toBeGreaterThan(at(s).lift);
    });
  });

  describe('Angle of attack and stall', () => {
    it('lift grows in a straight line at small angles, and there is lift at 0 deg', () => {
      const s = stateAt('angle-and-stall', 'angle-and-stall-tilt');
      const cl = [0, 2, 4, 6, 8, 10].map((a) => at(s, { alphaDeg: a }).CL);
      expect(cl[0]!).toBeGreaterThan(0.05);
      const steps = cl.slice(1).map((c, i) => c - cl[i]!);
      for (const d of steps) expect(d / steps[0]!).toBeGreaterThan(0.9);
    });

    it('the stagnation point slides back under the nose as the angle grows', () => {
      const s = stateAt('angle-and-stall', 'angle-and-stall-stagnation');
      const stag = (a: number) => computeSection(s.wing, { ...s.flow, alphaDeg: a }, 0.35, cache);
      const s0 = stag(0).stagnation;
      const s12 = stag(12).stagnation;
      expect(s12[0]).toBeGreaterThan(s0[0] + 0.01);
      expect(s12[1]).toBeLessThan(0);
    });

    it('stall begins at about 18 deg, and 20 deg is stalled', () => {
      const s = stateAt('angle-and-stall', 'angle-and-stall-stall');
      const first = firstStall(s.wing, s.flow, 10)!;
      expect(first.alphaDeg).toBeGreaterThanOrEqual(16);
      expect(first.alphaDeg).toBeLessThanOrEqual(20);
      expect(at(s).stall.any).toBe(true);
      const polar = computePolarSweep(s.wing, s.flow, 1, cache);
      expect(polar.alphaStallDeg).toBeGreaterThanOrEqual(16);
      expect(polar.alphaStallDeg).toBeLessThan(20); // the peak lies inside the 5..20 deg sweep
    });

    it('stall is about angle: stalled at every speed at 20 deg, attached at 10 deg', () => {
      const s = stateAt('angle-and-stall', 'angle-and-stall-not-speed');
      expect(s.flow.airspeed).toBe(120);
      for (const v of [40, 80, 120, 160]) expect(at(s, { airspeed: v }).stall.any).toBe(true);
      expect(at(s, { alphaDeg: 10 }).stall.any).toBe(false);
    });
  });

  describe('Speed and air density', () => {
    it('twice the speed gives about four times the lift', () => {
      const s = stateAt('speed-and-density', 'speed-and-density-squared');
      const ratio = at(s, { airspeed: 60 }).lift / at(s).lift;
      expect(ratio).toBeGreaterThan(3.8);
      expect(ratio).toBeLessThan(4.3);
    });

    it('at 10 km the lift drops to roughly a third', () => {
      const s = stateAt('speed-and-density', 'speed-and-density-thin-air');
      const ratio = at(s, { altitude: 10000 }).lift / at(s).lift;
      expect(ratio).toBeGreaterThan(0.29);
      expect(ratio).toBeLessThan(0.38);
    });

    it('737 cruise: 232 m/s at 11 km feels like 126 m/s at sea level and holds up 67 t', () => {
      const s = stateAt('speed-and-density', 'speed-and-density-cruise');
      const r = at(s);
      const eas = Math.sqrt((2 * r.dynamicPressure) / 1.225);
      expect(eas).toBeGreaterThan(123);
      expect(eas).toBeLessThan(129);
      expect(eas / KNOT).toBeCloseTo(245, -1);
      expect(Math.abs(r.lift / weightOf('b737-800') - 1)).toBeLessThan(0.03);
      // At sea level at the same speed: several times the weight.
      expect(at(s, { altitude: 0 }).lift / weightOf('b737-800')).toBeGreaterThan(2.5);
    });

    it('737 approach: a third of the cruise push; the clean wing falls well short', () => {
      const s = stateAt('speed-and-density', 'speed-and-density-approach');
      const cruise = getPreset('b737-800')!.cruise;
      const qRatio = at(s).dynamicPressure / aero(s.wing, cruise).dynamicPressure;
      expect(qRatio).toBeGreaterThan(0.28);
      expect(qRatio).toBeLessThan(0.38);
      expect(at(s).lift / weightOf('b737-800')).toBeLessThan(0.6);
    });
  });

  describe('Wingtip vortices and induced drag', () => {
    it('2 -> 6 deg: lift roughly doubles and induced drag roughly quadruples', () => {
      const s = stateAt('tip-vortices', 'tip-vortices-induced-drag');
      const a2 = at(s);
      const a6 = at(s, { alphaDeg: 6 });
      expect(a6.lift / a2.lift).toBeGreaterThan(1.7);
      expect(a6.lift / a2.lift).toBeLessThan(2.3);
      expect(a6.CDi / a2.CDi).toBeGreaterThan(3);
      expect(a6.CDi / a2.CDi).toBeLessThan(5);
    });

    it('glider: shortening 18 m to 8 m cuts lift and L/D by about a quarter', () => {
      const s = stateAt('tip-vortices', 'tip-vortices-long-wings');
      expect(s.wing.span).toBe(18);
      const long = at(s);
      const short = at(s, {}, { span: 8 });
      expect(short.lift).toBeLessThan(long.lift);
      expect(short.liftToDrag / long.liftToDrag).toBeGreaterThan(0.6);
      expect(short.liftToDrag / long.liftToDrag).toBeLessThan(0.85);
      expect(short.CDi).toBeGreaterThan(long.CDi);
    });

    it('the glider out-glides the stubby F-16 by far', () => {
      const glider = getPreset('glider-18m')!;
      const f16 = getPreset('f16')!;
      const g = aero(glider.wing, glider.cruise);
      const f = aero(f16.wing, f16.cruise);
      expect(g.liftToDrag).toBeGreaterThan(1.8 * f.liftToDrag);
      expect(f.CDi / (f.CL * f.CL)).toBeGreaterThan(5 * (g.CDi / (g.CL * g.CL)));
    });
  });

  describe('Winglets and wingtip devices', () => {
    it('737-800: without its winglets the wing has more drag and a worse L/D', () => {
      const s = stateAt('winglets', 'winglets-why');
      const r = at(s);
      const bare = at(s, {}, { tipDevice: { ...s.wing.tipDevice, size: 0 } });
      expect(bare.drag).toBeGreaterThan(r.drag);
      expect(bare.liftToDrag).toBeLessThan(r.liftToDrag);
      expect(bare.spanEfficiency).toBeLessThan(r.spanEfficiency);
    });

    it('747-400 winglets are about 1.8 m tall', () => {
      const w = getPreset('b747-400')!.wing;
      expect((w.tipDevice.size * w.span) / 2).toBeCloseTo(1.8, 1);
    });

    it('747-8: more raked-tip span, less induced drag', () => {
      const s = stateAt('winglets', 'winglets-747-8');
      const e = [0, 0.065, 0.12].map(
        (size) => at(s, {}, { tipDevice: { ...s.wing.tipDevice, size } }).spanEfficiency,
      );
      expect(e[1]!).toBeGreaterThan(e[0]!);
      expect(e[2]!).toBeGreaterThan(e[1]!);
    });

    it('737 MAX vs 737-800: higher span efficiency, about level L/D', () => {
      const ng = getPreset('b737-800')!;
      const max = getPreset('b737-max8')!;
      const a = aero(ng.wing, ng.cruise);
      const b = aero(max.wing, max.cruise);
      expect(b.spanEfficiency).toBeGreaterThan(a.spanEfficiency);
      expect(Math.abs(b.liftToDrag / a.liftToDrag - 1)).toBeLessThan(0.03);
      expect(max.typicalCruiseMassKg).toBeGreaterThan(ng.typicalCruiseMassKg);
    });

    it('A380 fence: a small effect on the whole wing', () => {
      const s = stateAt('winglets', 'winglets-a380');
      const r = at(s);
      const bare = at(s, {}, { tipDevice: { ...s.wing.tipDevice, size: 0 } });
      expect(r.liftToDrag).toBeGreaterThan(bare.liftToDrag);
      expect(r.liftToDrag / bare.liftToDrag).toBeLessThan(1.05);
    });
  });

  describe('Why jets sweep their wings', () => {
    it('737 at Mach 0.785, 295 m/s speed of sound; drag and wave drag climb with speed', () => {
      const s = stateAt('sweep', 'sweep-speed-of-sound');
      const r = at(s);
      expect(r.mach).toBeCloseTo(0.785, 2);
      expect(r.atmosphere.speedOfSound).toBeCloseTo(295, 0);
      const faster = at(s, { airspeed: 245 });
      expect(faster.drag).toBeGreaterThan(r.drag);
      expect(faster.CDw).toBeGreaterThan(r.CDw);
    });

    it('747-400: Mach 0.85 x cos 37.5 deg ~ 0.67; at cruise the shocks stay weak', () => {
      const s = stateAt('sweep', 'sweep-sliding-back');
      const r = at(s);
      expect(r.mach * Math.cos((37.5 * Math.PI) / 180)).toBeCloseTo(0.67, 2);
      expect(r.mach).toBeLessThanOrEqual(r.machDragDivergence);
      expect(r.warnings).toEqual([]);
    });

    it('747-400 unswept at Mach 0.85: drag more than doubles and the flow separates', () => {
      const s = stateAt('sweep', 'sweep-sliding-back');
      const swept = at(s);
      const straight = at(s, {}, { sweepDeg: 0 });
      expect(straight.drag).toBeGreaterThan(2 * swept.drag);
      expect(straight.stall.any).toBe(true);
      expect(straight.warnings.some((w) => w.includes('drag divergence'))).toBe(true);
    });

    it('swept wing stalls at the tips first; washout moves the stall inboard', () => {
      const s = stateAt('sweep', 'sweep-tip-stall');
      expect(s.wing.washoutDeg).toBe(0);
      expect(at(s).stall.any).toBe(false); // the person raises the angle themselves
      const plain = firstStall(s.wing, s.flow, s.flow.alphaDeg)!;
      const four = firstStall({ ...s.wing, washoutDeg: 4 }, s.flow, s.flow.alphaDeg)!;
      const six = firstStall({ ...s.wing, washoutDeg: 6 }, s.flow, s.flow.alphaDeg)!;
      expect(plain.meanEta).toBeGreaterThan(0.7);
      expect(four.meanEta).toBeLessThan(plain.meanEta - 0.1);
      expect(six.meanEta).toBeLessThan(plain.meanEta - 0.1);
      expect(six.alphaDeg).toBeGreaterThan(plain.alphaDeg);
    });

    it('Cessna: Mach 0.19 at 62 m/s; sweeping its wing 30 deg loses lift', () => {
      const s = stateAt('sweep', 'sweep-straight');
      const r = at(s);
      expect(r.mach).toBeCloseTo(0.19, 2);
      expect(at(s, {}, { sweepDeg: 30 }).lift).toBeLessThan(0.97 * r.lift);
    });
  });

  describe('747 vs 737', () => {
    it('wing loadings, weights and areas quoted in the text', () => {
      const b747 = getPreset('b747-400')!;
      const b737 = getPreset('b737-800')!;
      expect(b747.maxTakeoffMassKg / b737.maxTakeoffMassKg).toBeCloseTo(5, 0);
      expect(b747.typicalCruiseMassKg / 525).toBeCloseTo(640, -1);
      expect(b737.typicalCruiseMassKg / 124.6).toBeCloseTo(540, -1);
    });

    it('the slimmer 737 wing has the better L/D; both cruise below drag divergence', () => {
      const b747 = getPreset('b747-400')!;
      const b737 = getPreset('b737-800')!;
      const a = aero(b747.wing, b747.cruise);
      const b = aero(b737.wing, b737.cruise);
      expect(b.liftToDrag).toBeGreaterThan(a.liftToDrag);
      expect(a.mach).toBeLessThanOrEqual(a.machDragDivergence);
      expect(b.mach).toBeLessThanOrEqual(b.machDragDivergence);
      // "about 900 km/h" and "around 830 km/h"
      expect(Math.abs(a.velocity * 3.6 - 900)).toBeLessThan(20);
      expect(Math.abs(b.velocity * 3.6 - 830)).toBeLessThan(20);
    });
  });

  describe('Flaps and slats', () => {
    it('clean 737 at approach speed: well short of the weight, and it stalls first', () => {
      const s = stateAt('flaps-and-slats', 'flaps-and-slats-problem');
      const w = weightOf('b737-800');
      expect(at(s).lift / w).toBeLessThan(0.6);
      // Tilting further does not help: even the highest lift before stall is below the weight.
      const polar = computePolarSweep(s.wing, s.flow, 1, cache);
      const qS = at(s).lift / at(s).CL;
      expect((Math.max(...polar.CL) * qS) / w).toBeLessThan(1);
    });

    it('flaps 0 -> 30 deg: lift and drag both rise; 25 deg at 7 deg holds the 737 up', () => {
      const s = stateAt('flaps-and-slats', 'flaps-and-slats-flaps');
      const runs = [0, 10, 20, 30].map((d) =>
        at(s, {}, { flaps: { ...s.wing.flaps, deflectionDeg: d } }),
      );
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i]!.lift).toBeGreaterThan(runs[i - 1]!.lift);
        expect(runs[i]!.drag).toBeGreaterThan(runs[i - 1]!.drag);
      }
      expect(s.wing.flaps.deflectionDeg).toBe(25);
      const ratio = at(s).lift / weightOf('b737-800');
      expect(ratio).toBeGreaterThan(0.95);
      expect(ratio).toBeLessThan(1.2);
    });

    it('slats delay the stall to a bigger angle and more lift', () => {
      const s = stateAt('flaps-and-slats', 'flaps-and-slats-slats');
      const withSlats = computePolarSweep(s.wing, s.flow, 1, cache);
      const without = computePolarSweep({ ...s.wing, slats: false }, s.flow, 1, cache);
      expect(withSlats.alphaStallDeg).toBeGreaterThan(without.alphaStallDeg + 1);
      expect(withSlats.CLmax).toBeGreaterThan(without.CLmax);
    });

    it('15 deg of flap has a much better L/D than 40 deg', () => {
      const s = stateAt('flaps-and-slats', 'flaps-and-slats-tradeoff');
      const f15 = at(s, {}, { flaps: { ...s.wing.flaps, deflectionDeg: 15 } });
      const f40 = at(s, {}, { flaps: { ...s.wing.flaps, deflectionDeg: 40 } });
      expect(f15.liftToDrag).toBeGreaterThan(1.5 * f40.liftToDrag);
      expect(f40.lift).toBeGreaterThan(f15.lift);
    });

    it('Cessna: flies at 33 m/s, several times its weight at 72 m/s, stalls near 47 kt', () => {
      const s = stateAt('flaps-and-slats', 'flaps-and-slats-cessna');
      const c172 = getPreset('cessna-172')!;
      const w = c172.typicalCruiseMassKg * G;
      expect(at(s).lift / w).toBeGreaterThan(1);
      expect(at(s, { airspeed: 72 }).lift / w).toBeGreaterThan(4);
      const full = { ...s.wing, flaps: { ...s.wing.flaps, deflectionDeg: 40 } };
      const { CLmax } = computePolarSweep(full, { ...s.flow, airspeed: 25 }, 1, cache);
      const vs = Math.sqrt((2 * c172.maxTakeoffMassKg * G) / (1.225 * 16.2 * CLmax)) / KNOT;
      expect(vs).toBeGreaterThan(42);
      expect(vs).toBeLessThan(52);
    });
  });
});
