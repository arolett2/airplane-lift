/**
 * Tip devices through the REAL solvers while a slider moves: dragging the device size or the
 * wing taper one step must change lift, drag and span efficiency smoothly. Small devices on a
 * long tip chord, and fences on a wide one, used to give the vortex lattice near-singular strips
 * (lift off by 10-16 %, a false stall, span efficiency from 0.1 to 8) or drop the device from the
 * lift calculation while it was still drawn.
 */
import { describe, expect, it } from 'vitest';
import type { FlowConditions, TipDeviceKind, WingConfig } from '../state/params';
import { DEFAULT_FLOW, DEFAULT_WING, TIP_DEVICE_DEFAULTS } from '../state/params';
import { getPreset } from '../state/presets';
import { computeAero, createAeroCache } from './aero';

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
