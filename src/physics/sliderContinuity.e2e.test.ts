/**
 * Sliders through the REAL solvers: moving the tip-device size, the taper, the inboard
 * trailing-edge kink or the airspeed one step must change lift, drag and span efficiency smoothly.
 * Slivers in the vortex lattice used to make these jump: small devices on a long tip chord and
 * fences on a wide one (lift off by 10-16 %, a false stall, span efficiency from 0.1 to 8, or
 * a device dropped from the lift calculation while still drawn), and a Yehudi kink right next
 * to the root (lift 22 % too high). Airspeed used to step the lift every 0.02 Mach, where the
 * Prandtl-Glauert factor of the lattice jumped to the next bucket.
 */
import { describe, expect, it } from 'vitest';
import type { FlowConditions, TipDeviceKind, WingConfig } from '../state/params';
import { DEFAULT_FLOW, DEFAULT_WING, TIP_DEVICE_DEFAULTS } from '../state/params';
import { getPreset } from '../state/presets';
import { computeAero, computePolarSweep, createAeroCache } from './aero';

const solve = (wing: WingConfig, flow: FlowConditions) =>
  computeAero(wing, flow, 1, createAeroCache()).aero;

const withSize = (wing: WingConfig, size: number): WingConfig => ({
  ...wing,
  tipDevice: { ...wing.tipDevice, size },
});

/** Device sizes 0 .. 0.04 in slider steps (0.005). */
const SMALL_SIZES = Array.from({ length: 9 }, (_, i) => +(i * 0.005).toFixed(3));

describe('tip device size slider (real solvers)', { timeout: 120_000 }, () => {
  it.each(['b737-800', 'b737-max8', 'a320neo'])(
    '%s at cruise: lift and span efficiency change smoothly as the device shrinks to nothing',
    (id) => {
      const p = getPreset(id)!;
      const results = SMALL_SIZES.map((size) => solve(withSize(p.wing, size), p.cruise));
      for (const [i, aero] of results.entries()) {
        const at = `${id} size ${SMALL_SIZES[i]}`;
        expect(aero.stall.any, at).toBe(false);
        expect(aero.spanEfficiency, at).toBeGreaterThan(0.9);
        expect(aero.spanEfficiency, at).toBeLessThan(1.1);
        if (i === 0) continue;
        // One slider step changes lift by well under 1 % (it used to drop 10-16 %).
        const prev = results[i - 1]!;
        expect(Math.abs(aero.CL / prev.CL - 1), at).toBeLessThan(0.006);
        expect(Math.abs(aero.spanEfficiency - prev.spanEfficiency), at).toBeLessThan(0.02);
        // A bigger device never makes the wing worse.
        expect(aero.CL, at).toBeGreaterThan(prev.CL - 1e-4);
      }
    },
  );

  it.each(['raked-tip', 'canted-winglet', 'wingtip-fence'] as TipDeviceKind[])(
    'a small %s on the teaching wing stays in the lift calculation',
    (kind) => {
      for (const size of SMALL_SIZES.slice(1)) {
        const wing = { ...DEFAULT_WING, tipDevice: { ...TIP_DEVICE_DEFAULTS[kind], size } };
        const aero = solve(wing, DEFAULT_FLOW);
        expect(
          aero.strips.some((s) => s.eta > 1),
          `${kind} size ${size}`,
        ).toBe(true);
      }
    },
  );
});

describe('wingtip fences while the taper slider moves (real solvers)', { timeout: 120_000 }, () => {
  it('A380: span efficiency stays plausible and induced drag positive for every taper', () => {
    const p = getPreset('a380-800')!;
    for (const flow of [p.approach, p.cruise]) {
      let prev: number | null = null;
      for (let k = 20; k <= 100; k++) {
        const taper = k / 100;
        const aero = solve({ ...p.wing, taperRatio: taper }, flow);
        const at = `taper ${taper} ${flow === p.cruise ? 'cruise' : 'approach'}`;
        expect(aero.CDi, at).toBeGreaterThan(0);
        expect(aero.spanEfficiency, at).toBeGreaterThan(0.85);
        expect(aero.spanEfficiency, at).toBeLessThan(1.2);
        // One 0.01 step of taper moves the lift coefficient by about 0.3 %, never 15 %.
        if (prev !== null) expect(Math.abs(aero.CL / prev - 1), at).toBeLessThan(0.01);
        prev = aero.CL;
      }
    }
  });

  it('teaching wing with a 3 m root chord and fences: no collapse at any taper', () => {
    for (const taper of [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1]) {
      const wing = {
        ...DEFAULT_WING,
        rootChord: 3,
        taperRatio: taper,
        tipDevice: { ...TIP_DEVICE_DEFAULTS['wingtip-fence'] },
      };
      const aero = solve(wing, DEFAULT_FLOW);
      expect(aero.spanEfficiency, `taper ${taper}`).toBeGreaterThan(0.85);
      expect(aero.spanEfficiency, `taper ${taper}`).toBeLessThan(1.2);
    }
  });
});

describe('inboard trailing-edge kink slider (real solvers)', { timeout: 120_000 }, () => {
  it('737-800 at cruise: lift is continuous as the kink moves to the root', () => {
    const p = getPreset('b737-800')!;
    const at = (spanFrac: number) =>
      solve({ ...p.wing, yehudi: { ...p.wing.yehudi, spanFrac } }, p.cruise).CL;
    const none = at(0);
    // A kink a few centimetres out cannot carry 22 % more lift (it did at 0.01).
    for (const f of [0.002, 0.005, 0.01, 0.015, 0.02, 0.03]) {
      expect(Math.abs(at(f) / none - 1), `spanFrac ${f}`).toBeLessThan(0.01);
    }
  });

  it('a wide Yehudi on the teaching wing and on a stubby wing stays continuous', () => {
    for (const wing of [DEFAULT_WING, { ...DEFAULT_WING, rootChord: 5, span: 10 }]) {
      const flow = { ...DEFAULT_FLOW, alphaDeg: 5 };
      const at = (spanFrac: number) =>
        solve({ ...wing, yehudi: { spanFrac, chordFrac: 0.6 } }, flow).CL;
      const none = at(0);
      for (const f of [0.01, 0.02, 0.03, 0.05]) {
        expect(Math.abs(at(f) / none - 1), `chord ${wing.rootChord} spanFrac ${f}`).toBeLessThan(
          0.01,
        );
      }
    }
  });
});

describe('airspeed slider near cruise Mach (real solvers)', { timeout: 120_000 }, () => {
  it('737-800: every 1 m/s adds about the same lift, with no step at Mach-bucket edges', () => {
    const p = getPreset('b737-800')!;
    const cache = createAeroCache();
    const lift = (v: number) => computeAero(p.wing, { ...p.cruise, airspeed: v }, 1, cache).aero;
    const gains: number[] = [];
    let prev = lift(220);
    for (let v = 221; v <= 240; v++) {
      const aero = lift(v);
      gains.push(aero.lift - prev.lift);
      prev = aero;
    }
    const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
    // Bucket edges used to add four times the usual gain in one step (2.3 t instead of 0.6 t).
    for (let i = 1; i < gains.length; i++) {
      expect(Math.abs(gains[i]! - gains[i - 1]!), `${221 + i} m/s`).toBeLessThan(0.25 * mean);
    }
  });

  it('the current lift sits on the lift curve the charts draw', () => {
    const p = getPreset('b737-800')!;
    for (const airspeed of [229, 231.6, 234]) {
      const flow = { ...p.cruise, airspeed, alphaDeg: 4 };
      const cache = createAeroCache();
      const aero = computeAero(p.wing, flow, 1, cache).aero;
      const polar = computePolarSweep(p.wing, flow, 1, cache);
      expect(aero.CL, `${airspeed} m/s`).toBeCloseTo(polar.CL[polar.alphaDeg.indexOf(4)]!, 4);
    }
  });
});
