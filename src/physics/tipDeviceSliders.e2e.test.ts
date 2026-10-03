/**
 * Tip devices through the REAL solvers while a slider moves: dragging the device size or the
 * wing taper one step must change lift, drag and span efficiency smoothly. Small devices on a
 * long tip chord, and fences on a wide one, used to give the vortex lattice near-singular strips
 * (lift off by 10-16 %, a false stall, span efficiency from 0.1 to 8) or drop the device from the
 * lift calculation while it was still drawn.
 */
import { describe, expect, it } from 'vitest';
import type { FlowConditions, WingConfig } from '../state/params';
import { DEFAULT_FLOW, DEFAULT_WING, TIP_DEVICE_DEFAULTS } from '../state/params';
import { getPreset } from '../state/presets';
import { computeAero, createAeroCache } from './aero';

const solve = (wing: WingConfig, flow: FlowConditions) =>
  computeAero(wing, flow, 1, createAeroCache()).aero;

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
