import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, PARAM_SPECS } from './params';
import { applyPreset, getPreset, PRESETS } from './presets';
import { getPath } from './store';

/** Published figures the presets were built from (see docs/AIRCRAFT_DATA.md). */
const PUBLISHED: Record<string, { overallSpan: number; area: number }> = {
  'b747-400': { overallSpan: 64.44, area: 525 },
  'b747-8': { overallSpan: 68.4, area: 554 },
  'b737-800': { overallSpan: 35.79, area: 124.6 },
  'b737-max8': { overallSpan: 35.92, area: 124.6 },
  'b787-9': { overallSpan: 60.12, area: 377 },
  a320neo: { overallSpan: 35.8, area: 122.6 },
  'a380-800': { overallSpan: 79.75, area: 845 },
  'cessna-172': { overallSpan: 11, area: 16.2 },
  'glider-18m': { overallSpan: 18, area: 10.5 },
  f16: { overallSpan: 9.45, area: 27.87 },
};

const deg = Math.PI / 180;

describe('PRESETS', () => {
  it('starts with the teaching wing and has unique ids', () => {
    expect(PRESETS[0]?.id).toBe('demo-rect');
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of Object.keys(PUBLISHED)) expect(getPreset(id), id).toBeDefined();
    expect(getPreset('b737-800')).toBeDefined(); // INITIAL_PRESET_ID
  });

  it('every preset has complete text and plausible masses', () => {
    for (const p of PRESETS) {
      expect(p.name.length, p.id).toBeGreaterThan(3);
      expect(p.shortName.length, p.id).toBeGreaterThan(1);
      expect(p.blurb.length, p.id).toBeGreaterThan(20);
      expect(p.facts.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.facts.length, p.id).toBeLessThanOrEqual(4);
      expect(p.typicalCruiseMassKg, p.id).toBeLessThanOrEqual(p.maxTakeoffMassKg);
      expect(p.typicalCruiseMassKg, p.id).toBeGreaterThan(0.5 * p.maxTakeoffMassKg);
    }
  });

  it('every wing and flight condition sits inside the slider ranges', () => {
    for (const p of PRESETS) {
      for (const cond of ['cruise', 'approach'] as const) {
        const state = applyPreset(DEFAULT_STATE, p.id, cond);
        for (const spec of PARAM_SPECS) {
          const v = getPath(state, spec.path);
          expect(typeof v, `${p.id}.${spec.path}`).toBe('number');
          const n = v as number;
          expect(n, `${p.id} ${cond} ${spec.path} >= min`).toBeGreaterThanOrEqual(spec.min);
          expect(n, `${p.id} ${cond} ${spec.path} <= max`).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  it('flaps and slats start retracted, and tip devices are internally consistent', () => {
    for (const p of PRESETS) {
      expect(p.wing.flaps.deflectionDeg, p.id).toBe(0);
      expect(p.wing.slats, p.id).toBe(false);
      if (p.wing.tipDevice.kind === 'none') expect(p.wing.tipDevice.size, p.id).toBe(0);
      else expect(p.wing.tipDevice.size, p.id).toBeGreaterThan(0);
    }
  });

  it('reproduces the published span and reference area of each aircraft', () => {
    for (const [id, pub] of Object.entries(PUBLISHED)) {
      const w = getPreset(id)!.wing;
      const dev = w.tipDevice;
      // Overall span: base span, plus the sideways reach of winglets or the in-plane rake.
      let overall = w.span;
      if (dev.kind === 'raked-tip') overall = w.span * (1 + dev.size);
      else if (dev.kind !== 'none' && dev.kind !== 'wingtip-fence') {
        overall = w.span + 2 * dev.size * (w.span / 2) * Math.sin(dev.cantDeg * deg);
      }
      expect(Math.abs(overall - pub.overallSpan) / pub.overallSpan, `${id} span`).toBeLessThan(
        0.01,
      );

      // Planform area: reference trapezoid + inboard trailing-edge extension (+ raked tip).
      let area =
        ((w.rootChord * w.span) / 2) * (1 + w.taperRatio + w.yehudi.spanFrac * w.yehudi.chordFrac);
      if (dev.kind === 'raked-tip') {
        const ext = dev.size * (w.span / 2);
        area += 2 * ext * w.rootChord * w.taperRatio * ((1 + dev.taper) / 2);
      }
      expect(Math.abs(area - pub.area) / pub.area, `${id} area`).toBeLessThan(0.03);
    }
  });

  it('cruise speeds correspond to sensible Mach numbers and approach is slower', () => {
    for (const p of PRESETS) {
      expect(p.approach.airspeed, p.id).toBeLessThan(p.cruise.airspeed + 1e-9);
      expect(p.approach.altitude, p.id).toBe(0);
      expect(p.approach.alphaDeg, p.id).toBeGreaterThan(p.cruise.alphaDeg - 1e-9);
      const T = 288.15 - 0.0065 * Math.min(p.cruise.altitude, 11000);
      const mach = p.cruise.airspeed / (340.29 * Math.sqrt(T / 288.15));
      if (p.category === 'airliner') {
        expect(mach, p.id).toBeGreaterThan(0.75);
        expect(mach, p.id).toBeLessThan(0.87);
      } else expect(mach, p.id).toBeLessThan(0.9);
    }
  });

  it('applyPreset loads wing and the chosen flight condition, and ignores unknown ids', () => {
    const s = applyPreset(DEFAULT_STATE, 'b747-400', 'approach');
    expect(s.presetId).toBe('b747-400');
    expect(s.wing).toBe(getPreset('b747-400')!.wing);
    expect(s.flow).toBe(getPreset('b747-400')!.approach);
    expect(applyPreset(DEFAULT_STATE, 'does-not-exist')).toBe(DEFAULT_STATE);
  });
});
