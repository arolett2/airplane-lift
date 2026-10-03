import { describe, expect, it } from 'vitest';
import { NO_TIP_DEVICE, TIP_DEVICE_DEFAULTS, DEFAULT_WING } from '../../state/params';
import {
  buildPlanformSvg,
  compareRows,
  escapeXml,
  explainDifferences,
  formatAltitude,
  formatArea,
  formatLength,
  formatWingLoading,
  niceScaleBarLength,
  planformShapes,
  shapeBounds,
  summarizeCase,
  type CaseSummary,
} from './compareData';
import { makeAero, makeGeometry, makePreset } from './testFixtures';

function summary(
  id: string,
  opts: {
    span?: number;
    rootChord?: number;
    tipChord?: number;
    sweepOffset?: number;
    mach?: number;
    ld?: number;
    mtow?: number;
    tip?: 'none' | 'blended-winglet' | 'raked-tip';
    winglet?: boolean;
  } = {},
): CaseSummary {
  const geometry = makeGeometry({
    span: opts.span,
    rootChord: opts.rootChord,
    tipChord: opts.tipChord,
    sweepOffset: opts.sweepOffset,
    winglet: opts.winglet,
  });
  const tip = opts.tip ?? 'none';
  const preset = makePreset({
    id,
    shortName: id,
    maxTakeoffMassKg: opts.mtow ?? 80000,
    wing: {
      ...DEFAULT_WING,
      tipDevice: tip === 'none' ? NO_TIP_DEVICE : TIP_DEVICE_DEFAULTS[tip],
    },
  });
  const aero = makeAero({
    mach: opts.mach ?? 0.78,
    liftToDrag: opts.ld ?? 17,
    dynamicPressure: 9000,
  });
  return summarizeCase(preset, geometry, aero);
}

describe('planformShapes', () => {
  const geometry = makeGeometry({
    span: 10,
    rootChord: 2,
    tipChord: 1,
    sweepOffset: 1,
    winglet: true,
  });
  const shapes = planformShapes(geometry);

  it('outlines every surface, devices included', () => {
    expect(shapes).toHaveLength(geometry.surfaces.length);
    expect(shapes.map((s) => s.role).filter((r) => r === 'tip-device')).toHaveLength(2);
    for (const s of shapes) expect(s.points).toHaveLength(2 * 2); // 2 sections -> LE + TE each
  });

  it('runs leading edge root to tip, then trailing edge tip to root', () => {
    const right = shapes.find((s) => s.surfaceId === 'right-wing')!;
    expect(right.points[0]).toEqual([0, 0]);
    expect(right.points[1]).toEqual([1, 5]);
    expect(right.points[2]![0]).toBeCloseTo(2, 9); // tip trailing edge: 1 + chord 1
    expect(right.points[2]![1]).toBeCloseTo(5, 9);
    expect(right.points[3]).toEqual([2, 0]);
  });

  it('mirrors the left side', () => {
    const left = shapes.find((s) => s.surfaceId === 'left-wing')!;
    expect(left.points[1]![1]).toBe(-5);
  });

  it('measures bounds relative to the pivot', () => {
    const b = shapeBounds(shapes, 0.5);
    expect(b.minX).toBeCloseTo(-0.5, 9);
    expect(b.minY).toBeLessThan(-5);
    expect(b.maxY).toBeGreaterThan(5);
  });
});

describe('formatting', () => {
  it('formats lengths, areas, altitudes and loadings per unit system', () => {
    expect(formatLength(64.44, 'metric')).toBe('64.4 m');
    expect(formatLength(150, 'aviation')).toBe('150 m');
    expect(formatLength(10, 'imperial')).toBe('32.8 ft');
    expect(formatArea(511, 'metric')).toBe('511 m²');
    expect(formatArea(10, 'imperial')).toBe('108 ft²');
    expect(formatAltitude(10668, 'aviation')).toBe('35,000 ft');
    expect(formatAltitude(10668, 'metric')).toBe('10,668 m');
    expect(formatWingLoading(650.2, 'metric')).toBe('650 kg/m²');
    expect(formatWingLoading(650, 'imperial')).toBe('133 lb/ft²');
    expect(formatLength(NaN, 'metric')).toBe('–');
  });

  it('picks round scale bar lengths', () => {
    expect(niceScaleBarLength(13)).toBe(10);
    expect(niceScaleBarLength(17)).toBe(20);
    expect(niceScaleBarLength(0.4)).toBe(0.5);
  });

  it('escapes markup in labels', () => {
    expect(escapeXml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('summarizeCase', () => {
  it('derives wing loading and the cruise lift coefficient from the preset mass', () => {
    const s = summary('x', { span: 30, rootChord: 4, tipChord: 2, mtow: 90000 });
    expect(s.areaM2).toBeCloseTo(90, 9); // (4+2)/2 * 30
    expect(s.wingLoading).toBeCloseTo(1000, 6);
    // CL = W / (q S) with W = 65,000 kg
    expect(s.clNeeded).toBeCloseTo((65000 * 9.80665) / (9000 * 90), 6);
    expect(s.spanM).toBe(30);
    expect(s.sweepDeg).toBeGreaterThan(0);
  });
});

describe('compareRows', () => {
  const a = summary('big', {
    span: 60,
    rootChord: 8,
    tipChord: 2,
    mtow: 400000,
    mach: 0.85,
    ld: 19,
  });
  const b = summary('small', {
    span: 12,
    rootChord: 1.6,
    tipChord: 1.0,
    mtow: 1100,
    mach: 0.2,
    ld: 10,
  });
  const rows = compareRows(a, b, 'metric');

  it('covers every measure the brief asks for', () => {
    expect(rows.map((r) => r.id)).toEqual([
      'span',
      'area',
      'aspect',
      'sweep',
      'mac',
      'loading',
      'cruise',
      'cl',
      'ld',
      'efficiency',
      'mcrit',
    ]);
    for (const r of rows) {
      expect(r.label.length).toBeGreaterThan(3);
      expect(r.hint.length).toBeGreaterThan(10);
    }
  });

  it('formats values and scales bars against the larger one', () => {
    const span = rows.find((r) => r.id === 'span')!;
    expect(span.a).toBe('60.0 m');
    expect(span.b).toBe('12.0 m');
    expect(span.fracA).toBe(1);
    expect(span.fracB).toBeCloseTo(0.2, 9);
    const cruise = rows.find((r) => r.id === 'cruise')!;
    expect(cruise.a).toBe('Mach 0.85 at 10,668 m');
    const aviation = compareRows(a, b, 'aviation').find((r) => r.id === 'cruise')!;
    expect(aviation.a).toBe('Mach 0.85 at 35,000 ft');
    const loading = rows.find((r) => r.id === 'loading')!;
    expect(loading.a).toContain('kg/m²');
  });

  it('survives missing numbers', () => {
    const bad = summarizeCase(
      makePreset({ id: 'n' }),
      makeGeometry({}),
      makeAero({ spanEfficiency: NaN }),
    );
    const r = compareRows(bad, bad, 'metric').find((x) => x.id === 'efficiency')!;
    expect(r.a).toBe('–');
    expect(r.fracA).toBe(0);
  });
});

describe('explainDifferences', () => {
  it('notes a much larger wing', () => {
    const out = explainDifferences(
      summary('big', { span: 60, rootChord: 8, tipChord: 2 }),
      summary('small', { span: 12, rootChord: 1.6, tipChord: 1.0 }),
    );
    expect(out.some((s) => /larger wing/.test(s) && s.includes('big'))).toBe(true);
  });

  it('quotes spans in the requested unit system', () => {
    const big = summary('big', { span: 60, rootChord: 8, tipChord: 2 });
    const small = summary('small', { span: 12, rootChord: 1.6, tipChord: 1.0 });
    const imperial = explainDifferences(big, small, 'imperial').find((s) => /larger wing/.test(s))!;
    expect(imperial).toContain('197 ft');
    expect(imperial).not.toContain('60.0 m');
    expect(explainDifferences(big, small).find((s) => /larger wing/.test(s))).toContain('60.0 m');
  });

  it('ties sweep to cruise speed only when the numbers agree', () => {
    const swept = summary('swept', { sweepOffset: 6, mach: 0.85 });
    const straight = summary('straight', { sweepOffset: 0, mach: 0.3 });
    const out = explainDifferences(swept, straight);
    const line = out.find((s) => /sweeps its wing/.test(s))!;
    expect(line).toContain('swept');
    expect(line).toMatch(/Mach 0\.85 instead of 0\.30/);
    // Same Mach: still explains sweep, but without the speed claim.
    const same = explainDifferences(
      summary('s1', { sweepOffset: 6, mach: 0.8 }),
      summary('s2', { sweepOffset: 0, mach: 0.8 }),
    );
    expect(same.find((s) => /sweeps its wing/.test(s))).not.toMatch(/Mach/);
  });

  it('explains aspect ratio and links it to lift-to-drag when it helps', () => {
    const slim = summary('slim', { span: 40, rootChord: 2, tipChord: 1, ld: 25 });
    const stubby = summary('stubby', { span: 10, rootChord: 3, tipChord: 2, ld: 12 });
    const line = explainDifferences(slim, stubby).find((s) => /slimmer wing/.test(s))!;
    expect(line).toContain('slim');
    expect(line).toContain('induced drag');
    expect(line).toContain('25.0 against 12.0');
  });

  it('turns wing loading into a landing-speed claim from the square root', () => {
    const heavy = summary('heavy', { span: 10, rootChord: 1, tipChord: 1, mtow: 6000 }); // 600 kg/m2
    const light = summary('light', { span: 10, rootChord: 1, tipChord: 1, mtow: 1500 }); // 150 kg/m2
    const line = explainDifferences(heavy, light).find((s) => /square metre/.test(s))!;
    expect(line).toContain('about 100% faster'); // sqrt(4) - 1
    expect(line).toContain('heavy');
  });

  it('mentions tip devices only when they differ', () => {
    const withWinglets = summary('w', { tip: 'blended-winglet' });
    const plain = summary('p', { tip: 'none' });
    expect(explainDifferences(withWinglets, plain).some((s) => /blended winglets/.test(s))).toBe(
      true,
    );
    expect(explainDifferences(plain, withWinglets).some((s) => /blended winglets/.test(s))).toBe(
      true,
    );
    const out = explainDifferences(
      summary('a', { tip: 'raked-tip' }),
      summary('b', { tip: 'blended-winglet' }),
    );
    expect(out.some((s) => /raked wingtips.*blended winglets/.test(s))).toBe(true);
    expect(
      explainDifferences(summary('c'), summary('d')).some((s) =>
        /tip device|winglets|wingtip/.test(s),
      ),
    ).toBe(false);
  });

  it('has a fallback for near twins and for the same aircraft twice', () => {
    const out = explainDifferences(summary('a'), summary('b'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/very similar/);
    expect(explainDifferences(summary('a'), summary('a'))[0]).toMatch(/same aircraft/);
  });

  it('never returns more than five sentences', () => {
    const a = summary('a', {
      span: 60,
      rootChord: 8,
      tipChord: 2,
      sweepOffset: 12,
      mtow: 400000,
      mach: 0.85,
      ld: 20,
      tip: 'raked-tip',
    });
    const b = summary('b', {
      span: 10,
      rootChord: 1.5,
      tipChord: 1,
      sweepOffset: 0,
      mtow: 1000,
      mach: 0.2,
      ld: 8,
      tip: 'none',
    });
    expect(explainDifferences(a, b).length).toBeLessThanOrEqual(5);
  });
});

describe('buildPlanformSvg', () => {
  const big = summary('Big <jet>', { span: 60, rootChord: 8, tipChord: 2 });
  const small = summary('Small', { span: 12, rootChord: 1.6, tipChord: 1.0, winglet: true });
  const inputs = [big, small].map((c, i) => ({
    slot: (i === 0 ? 'a' : 'b') as 'a' | 'b',
    label: c.preset.shortName,
    shapes: planformShapes(c.geometry),
    pivotX: c.geometry.pivot[0],
    spanM: c.spanM,
  }));
  const svg = buildPlanformSvg(inputs, 'metric');

  const polygons = (markup: string): string[] => markup.match(/<polygon [^>]*>/g) ?? [];
  const xs = (poly: string): number[] =>
    /points="([^"]+)"/
      .exec(poly)![1]!
      .split(' ')
      .map((p) => Number(p.split(',')[0]));

  it('draws every surface of both aircraft, devices included', () => {
    expect(polygons(svg)).toHaveLength(2 + 4); // big: 2 wings; small: 2 wings + 2 winglets
    expect(svg).toContain('viz-plan-a');
    expect(svg).toContain('viz-plan-b');
    expect(svg).toContain('data-role="tip-device"');
  });

  it('labels spans and escapes names', () => {
    expect(svg).toContain('60.0 m');
    expect(svg).toContain('12.0 m');
    expect(svg).toContain('Big &lt;jet&gt;');
    expect(svg).not.toContain('Big <jet>');
  });

  it('uses one scale for both aircraft', () => {
    const rights = polygons(svg).filter((p) => /data-surface="right-wing"/.test(p));
    expect(rights).toHaveLength(2);
    const widthOf = (poly: string): number => Math.max(...xs(poly)) - 320; // centre line at x = 320
    expect(widthOf(rights[0]!) / widthOf(rights[1]!)).toBeCloseTo(60 / 12, 1);
  });

  it('includes a scale bar with a round length', () => {
    const m = /viz-plan-scalebar.*?>(\d+(?:\.\d+)?) m<\/text>/.exec(svg);
    expect(m).not.toBeNull();
    expect([1, 2, 5, 10, 20, 50]).toContain(Number(m![1]));
    expect(buildPlanformSvg(inputs, 'imperial')).toMatch(/ ft<\/text>/);
  });

  it('returns nothing for no input', () => {
    expect(buildPlanformSvg([], 'metric')).toBe('');
  });
});
