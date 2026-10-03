/** Aircraft-level benchmarks: 737-800 and 747-400 wings vs published figures (wing only). */
import { describe, expect, it } from 'vitest';
import { getPreset } from '../../state/presets';
import { aircraftChecks } from './checks';
import { runChecks } from './benchmarkTest';
import vlm3d from './reference/vlm_3d.json';

describe('737-800 benchmark wing is the preset wing', () => {
  it('fixture planform equals the b737-800 preset (winglet removed)', () => {
    const p = getPreset('b737-800')!.wing;
    const c = vlm3d.cases.find((k) => k.id === 'b737-800-wing')!.config;
    expect(c).toEqual({
      span: p.span,
      rootChord: p.rootChord,
      taperRatio: p.taperRatio,
      sweepDeg: p.sweepDeg,
      dihedralDeg: p.dihedralDeg,
      rootIncidenceDeg: p.rootIncidenceDeg,
      washoutDeg: p.washoutDeg,
      yehudi: p.yehudi,
      airfoil: p.airfoil,
    });
  });
});

describe('aircraft wings vs published figures', () => runChecks(aircraftChecks()));
