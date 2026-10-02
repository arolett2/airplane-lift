import { describe, expect, it } from 'vitest';
import {
  dragNote,
  dragPolarData,
  ellipticalLoad,
  liftCurveData,
  liftCurveNote,
  pressureData,
  pressureNote,
  spanChartData,
  spanEfficiencyNote,
  spanLoadNote,
} from './chartData';
import { DEG, makeAero, makeGeometry, makePolar, makeSection, makeStrip } from './testFixtures';

describe('liftCurveData', () => {
  const polar = makePolar();

  it('places the stall line inside the sweep only', () => {
    expect(liftCurveData(polar, 5, null).stallAlphaDeg).toBe(14);
    expect(liftCurveData({ ...polar, alphaStallDeg: 40 }, 5, null).stallAlphaDeg).toBeNull();
    expect(liftCurveData({ ...polar, alphaStallDeg: NaN }, 5, null).stallAlphaDeg).toBeNull();
  });

  it('follows the slider using the curve, then the solver value once it catches up', () => {
    const fromCurve = liftCurveData(polar, 6, makeAero({ alpha: 2 * DEG, CL: 0.3 }));
    expect(fromCurve.current!.alphaDeg).toBe(6);
    expect(fromCurve.current!.CL).toBeCloseTo(0.085 * 8, 4);
    const fromSolver = liftCurveData(polar, 5, makeAero({ alpha: 5 * DEG, CL: 0.61 }));
    expect(fromSolver.current!.CL).toBe(0.61);
  });

  it('has no marker when alpha is outside the swept range', () => {
    expect(liftCurveData(polar, 40, null).current).toBeNull();
    expect(liftCurveData(polar, null, null).current).toBeNull();
  });

  it('writes a plain-language note comparing with the endless wing', () => {
    const note = liftCurveNote(liftCurveData(polar, 6, null))!;
    expect(note).toContain('6.0°');
    expect(note).toContain('endless wing');
    expect(note).toMatch(/\d+% less/);
    expect(liftCurveNote(liftCurveData(polar, 99, null))).toBeNull();
  });

  it('mentions the stall angle, and what happens beyond it', () => {
    expect(liftCurveNote(liftCurveData(polar, 6, null))).toContain('stalls at about 14°');
    const beyond = liftCurveNote(liftCurveData(polar, 18, null))!;
    expect(beyond).toContain('Past the stall angle of about 14°');
    expect(beyond).toContain('lift falls');
    expect(liftCurveNote(liftCurveData({ ...polar, alphaStallDeg: 90 }, 6, null))).not.toContain(
      'stall',
    );
  });
});

describe('spanChartData', () => {
  it('normalises the right-wing load to an average of one', () => {
    const aero = makeAero();
    const data = spanChartData(aero, makeGeometry({}))!;
    expect(data).not.toBeNull();
    expect(data.wing.eta.length).toBe(16);
    const mean = data.wing.load.reduce((a, b) => a + b, 0) / data.wing.load.length;
    expect(mean).toBeCloseTo(1, 6);
    expect(data.devices).toHaveLength(0);
    expect(data.etaMax).toBeLessThan(1);
  });

  it('builds an elliptical reference with the same total (mean 1 over the semispan)', () => {
    const data = spanChartData(makeAero(), null)!;
    const { eta, load } = data.ellipse;
    let area = 0;
    for (let i = 1; i < eta.length; i++) {
      area += ((load[i]! + load[i - 1]!) / 2) * (eta[i]! - eta[i - 1]!);
    }
    expect(area).toBeCloseTo(1, 2);
    expect(ellipticalLoad(0)).toBeCloseTo(4 / Math.PI, 12);
    expect(ellipticalLoad(1)).toBe(0);
    expect(ellipticalLoad(1.5)).toBe(0);
  });

  it('appends tip devices past the tip and joins them to the wing', () => {
    const data = spanChartData(makeAero({}, true), makeGeometry({ winglet: true }))!;
    expect(data.devices).toHaveLength(1);
    const dev = data.devices[0]!;
    expect(dev.eta[0]).toBe(data.wing.eta[data.wing.eta.length - 1]);
    expect(dev.eta[dev.eta.length - 1]).toBeGreaterThan(1);
    expect(data.etaMax).toBeGreaterThan(1);
    // The wing line itself must not contain device strips.
    expect(Math.max(...data.wing.eta)).toBeLessThan(1);
  });

  it('classifies device strips without geometry by eta > 1', () => {
    const data = spanChartData(makeAero({}, true), null)!;
    expect(data.devices).toHaveLength(1);
  });

  it('uses only right-side strips', () => {
    const aero = makeAero();
    expect(spanChartData(aero, null)!.wing.eta).toHaveLength(
      aero.strips.filter((s) => s.side === 'right').length,
    );
  });

  it('reports the strip closest to stalling and stall state', () => {
    const aero = makeAero();
    aero.strips = aero.strips.map((s) =>
      s.side === 'right' && s.eta > 0.8 ? { ...s, cl: 1.5, stalled: true } : s,
    );
    const data = spanChartData(aero, null)!;
    expect(data.closest!.ratio).toBeGreaterThan(1);
    expect(data.closest!.eta).toBeGreaterThan(0.8);
    expect(data.anyStalled).toBe(true);
    expect(spanLoadNote(data)).toContain('past its stall limit');
  });

  it('returns null when there is no lift to normalise', () => {
    const aero = makeAero();
    aero.strips = aero.strips.map((s) => ({ ...s, liftPerSpan: 0 }));
    expect(spanChartData(aero, null)).toBeNull();
    expect(spanChartData(makeAero({ strips: [] }), null)).toBeNull();
  });

  it('declines to normalise when the net lift is tiny next to the local loads', () => {
    const aero = makeAero();
    // Root lifts, tip pushes down by the same amount: the average is about zero.
    aero.strips = aero.strips.map((s) => ({
      ...s,
      liftPerSpan: s.eta < 0.5 ? 3000 : -3000 + (s.side === 'right' ? 1 : 0),
    }));
    expect(spanChartData(aero, null)).toBeNull();
  });

  it('keeps negative lift negative', () => {
    const aero = makeAero();
    aero.strips = aero.strips.map((s) => ({ ...s, liftPerSpan: -s.liftPerSpan }));
    const data = spanChartData(aero, null)!;
    expect(data.wing.load.every((v) => v < 0)).toBe(true);
    expect(data.ellipse.load[0]!).toBeLessThan(0);
  });

  it('handles a strip with an unusable clMax', () => {
    const aero = makeAero();
    aero.strips = [makeStrip('right-wing', 0.2, { clMax: 0 }), makeStrip('right-wing', 0.6)];
    const data = spanChartData(aero, null)!;
    expect(Number.isNaN(data.wing.ratio[0])).toBe(true);
    expect(data.closest!.eta).toBe(0.6);
  });
});

describe('spanEfficiencyNote', () => {
  it('reports the solver span efficiency in plain words', () => {
    expect(spanEfficiencyNote(makeAero({ spanEfficiency: 0.913 }))).toContain('0.91');
    expect(spanEfficiencyNote(makeAero({ spanEfficiency: NaN }))).toBeNull();
    expect(spanEfficiencyNote(makeAero({ spanEfficiency: 0 }))).toBeNull();
  });
});

describe('pressureData', () => {
  it('passes through the chordwise Cp and finds peak suction', () => {
    const section = makeSection();
    const data = pressureData(section);
    expect(data.xc).toBe(section.cp.xc);
    expect(data.peakSuction).toBeLessThan(-1);
  });

  it('describes the slice in plain words', () => {
    expect(pressureNote(makeSection({ eta: 0.35 }))).toContain('35% of the way out');
    expect(pressureNote(makeSection({ eta: 0 }))).toContain('root');
    expect(pressureNote(makeSection({ stalled: true }))).toContain('separated');
  });
});

describe('dragPolarData', () => {
  it('finds the best glide before the stall peak', () => {
    const polar = makePolar();
    const data = dragPolarData(polar, makeAero({ CL: 0.6, CD: 0.03 }));
    expect(data.bestGlide).not.toBeNull();
    const best = data.bestGlide!;
    for (let i = 0; i < polar.CL.length; i++) {
      if (polar.CL[i]! > 0.05 && polar.alphaDeg[i]! <= 14) {
        expect(polar.CL[i]! / polar.CD[i]!).toBeLessThanOrEqual(best.liftToDrag + 1e-6);
      }
    }
    expect(data.current!.liftToDrag).toBeCloseTo(20, 6);
    expect(dragNote(data)).toContain('sweet spot');
  });

  it('copes with a polar with no positive lift', () => {
    const polar = makePolar();
    polar.CL.fill(-0.2);
    const data = dragPolarData(polar, null);
    expect(data.bestGlide).toBeNull();
    expect(dragNote(data)).toBeNull();
  });
});
