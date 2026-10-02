/**
 * Pure helpers for the aircraft comparison view: planform outlines, an SVG drawing of two
 * planforms at the same scale, the side-by-side metric table and the "why they differ" text.
 */
import type { AeroResult, WingGeometry } from '../../physics/types';
import type { TipDeviceKind, UnitSystem } from '../../state/params';
import type { AircraftPreset } from '../../state/presets';
import { niceNumber } from './ticks';

const G = 9.80665;
const M_TO_FT = 3.280839895;
const KG_M2_TO_LB_FT2 = 0.204816;
const RAD2DEG = 180 / Math.PI;

/* ------------------------------------------------------------------------------------------ */
/* Planform outlines                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** One lifting surface seen from above: x runs aft (towards the tail), y to starboard, metres. */
export interface PlanformShape {
  surfaceId: string;
  role: 'wing' | 'tip-device';
  side: 'right' | 'left';
  /** Closed outline: leading edge root -> tip, then trailing edge tip -> root. */
  points: [number, number][];
}

/**
 * Outline of every surface from its sections' leading and trailing edges, projected onto the x-y
 * plane (a top view). Tip devices are included; a vertical winglet shows up as a thin sliver.
 */
export function planformShapes(geometry: WingGeometry): PlanformShape[] {
  return geometry.surfaces.map((surface) => {
    const le: [number, number][] = [];
    const te: [number, number][] = [];
    for (const s of surface.sections) {
      le.push([s.le[0], s.le[1]]);
      // Chord direction after twist about the span tangent (0, cos roll, sin roll), seen from above.
      const dx = Math.cos(s.twist);
      const dy = Math.sin(s.roll) * Math.sin(s.twist);
      te.push([s.le[0] + s.chord * dx, s.le[1] + s.chord * dy]);
    }
    return {
      surfaceId: surface.id,
      role: surface.role,
      side: surface.side,
      points: [...le, ...te.reverse()],
    };
  });
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function shapeBounds(shapes: readonly PlanformShape[], shiftX = 0): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const [x, y] of shape.points) {
      minX = Math.min(minX, x - shiftX);
      maxX = Math.max(maxX, x - shiftX);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY };
}

/** A 1 / 2 / 5 x 10^n length close to `target`. */
export function niceScaleBarLength(target: number): number {
  return niceNumber(Math.max(target, 1e-6), true);
}

/* ------------------------------------------------------------------------------------------ */
/* Number formatting                                                                            */
/* ------------------------------------------------------------------------------------------ */

const withCommas = (n: number): string =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function formatLength(meters: number, units: UnitSystem): string {
  if (!Number.isFinite(meters)) return '–';
  if (units === 'imperial')
    return `${(meters * M_TO_FT).toFixed(meters * M_TO_FT >= 100 ? 0 : 1)} ft`;
  return `${meters.toFixed(meters >= 100 ? 0 : 1)} m`;
}

export function formatArea(squareMeters: number, units: UnitSystem): string {
  if (!Number.isFinite(squareMeters)) return '–';
  if (units === 'imperial') return `${withCommas(squareMeters * M_TO_FT * M_TO_FT)} ft²`;
  return `${squareMeters.toFixed(squareMeters >= 100 ? 0 : 1)} m²`;
}

export function formatAltitude(meters: number, units: UnitSystem): string {
  if (!Number.isFinite(meters)) return '–';
  if (units === 'metric') return `${withCommas(meters)} m`;
  return `${withCommas(meters * M_TO_FT)} ft`;
}

export function formatWingLoading(kgPerM2: number, units: UnitSystem): string {
  if (!Number.isFinite(kgPerM2)) return '–';
  const base = `${withCommas(kgPerM2)} kg/m²`;
  return units === 'imperial' ? `${withCommas(kgPerM2 * KG_M2_TO_LB_FT2)} lb/ft²` : base;
}

const fixed = (v: number, digits: number): string => (Number.isFinite(v) ? v.toFixed(digits) : '–');

/* ------------------------------------------------------------------------------------------ */
/* Case summaries and the metric table                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Everything the table and the explanations need about one aircraft, in SI. */
export interface CaseSummary {
  preset: AircraftPreset;
  geometry: WingGeometry;
  aero: AeroResult;
  spanM: number;
  areaM2: number;
  aspectRatio: number;
  sweepDeg: number;
  macM: number;
  /** kg per m^2 of wing at maximum take-off mass. */
  wingLoading: number;
  cruiseMach: number;
  cruiseAltitudeM: number;
  /** Lift coefficient needed to hold the typical cruise mass up at cruise conditions. */
  clNeeded: number;
  liftToDrag: number;
  spanEfficiency: number;
  machCritical: number;
}

export function summarizeCase(
  preset: AircraftPreset,
  geometry: WingGeometry,
  aero: AeroResult,
): CaseSummary {
  const area = geometry.referenceArea;
  const weight = preset.typicalCruiseMassKg * G;
  return {
    preset,
    geometry,
    aero,
    spanM: geometry.overallSpan,
    areaM2: area,
    aspectRatio: geometry.aspectRatio,
    sweepDeg: geometry.sweepQuarterChord * RAD2DEG,
    macM: geometry.meanAeroChord,
    wingLoading: preset.maxTakeoffMassKg / area,
    cruiseMach: aero.mach,
    cruiseAltitudeM: preset.cruise.altitude,
    clNeeded: aero.dynamicPressure > 0 ? weight / (aero.dynamicPressure * area) : NaN,
    liftToDrag: aero.liftToDrag,
    spanEfficiency: aero.spanEfficiency,
    machCritical: aero.machCritical,
  };
}

export interface CompareRow {
  id: string;
  label: string;
  /** One plain-language line about what the number means. */
  hint: string;
  a: string;
  b: string;
  /** Relative bar lengths 0..1 (value divided by the larger of the two); 0 when unknown. */
  fracA: number;
  fracB: number;
}

function bars(a: number, b: number): [number, number] {
  const max = Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
  if (!(max > 0)) return [0, 0];
  const f = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.min(1, v / max) : 0);
  return [f(a), f(b)];
}

export function compareRows(a: CaseSummary, b: CaseSummary, units: UnitSystem): CompareRow[] {
  const row = (
    id: string,
    label: string,
    hint: string,
    va: number,
    vb: number,
    format: (v: number) => string,
    barValues: [number, number] = [va, vb],
  ): CompareRow => {
    const [fracA, fracB] = bars(barValues[0], barValues[1]);
    return { id, label, hint, a: format(va), b: format(vb), fracA, fracB };
  };
  const cruise = (s: CaseSummary): string =>
    `Mach ${fixed(s.cruiseMach, 2)} at ${formatAltitude(s.cruiseAltitudeM, units)}`;
  return [
    row(
      'span',
      'Wingspan',
      'Tip to tip, not counting winglets that point up.',
      a.spanM,
      b.spanM,
      (v) => formatLength(v, units),
    ),
    row(
      'area',
      'Wing area',
      'Flat area of the wings seen from above. Lift comes from this area.',
      a.areaM2,
      b.areaM2,
      (v) => formatArea(v, units),
    ),
    row(
      'aspect',
      'Aspect ratio',
      'Span squared over area: how long and slim the wing is.',
      a.aspectRatio,
      b.aspectRatio,
      (v) => fixed(v, 1),
    ),
    row(
      'sweep',
      'Sweep',
      'How far the wing leans back along its quarter-chord line.',
      a.sweepDeg,
      b.sweepDeg,
      (v) => `${fixed(v, 0)}°`,
      [Math.abs(a.sweepDeg), Math.abs(b.sweepDeg)],
    ),
    row(
      'mac',
      'Average chord',
      'The average front-to-back width of the wing.',
      a.macM,
      b.macM,
      (v) => formatLength(v, units),
    ),
    row(
      'loading',
      'Wing loading at full weight',
      'Maximum take-off weight per area of wing. Higher means a faster landing.',
      a.wingLoading,
      b.wingLoading,
      (v) => formatWingLoading(v, units),
    ),
    {
      id: 'cruise',
      label: 'Cruise speed and height',
      hint: 'Typical cruise Mach number and altitude.',
      a: cruise(a),
      b: cruise(b),
      ...(() => {
        const [fracA, fracB] = bars(a.cruiseMach, b.cruiseMach);
        return { fracA, fracB };
      })(),
    },
    row(
      'cl',
      'Lift coefficient needed',
      'How hard the wing must work to carry the cruise weight.',
      a.clNeeded,
      b.clNeeded,
      (v) => fixed(v, 2),
    ),
    row(
      'ld',
      'Lift-to-drag at cruise',
      'Lift gained for each unit of drag paid. Higher is more efficient.',
      a.liftToDrag,
      b.liftToDrag,
      (v) => fixed(v, 1),
    ),
    row(
      'efficiency',
      'Span efficiency',
      'How close the lift sharing is to the ideal ellipse (1.00 is perfect).',
      a.spanEfficiency,
      b.spanEfficiency,
      (v) => fixed(v, 2),
    ),
    row(
      'mcrit',
      'Critical Mach',
      'Speed, as a fraction of the speed of sound, where shock waves start to form.',
      a.machCritical,
      b.machCritical,
      (v) => fixed(v, 2),
    ),
  ];
}

/* ------------------------------------------------------------------------------------------ */
/* "Why they differ"                                                                            */
/* ------------------------------------------------------------------------------------------ */

const DEVICE_NAMES: Record<TipDeviceKind, string> = {
  none: 'no tip device',
  'canted-winglet': 'canted winglets',
  'blended-winglet': 'blended winglets',
  'raked-tip': 'raked wingtips',
  'split-winglet': 'split-tip winglets',
  'wingtip-fence': 'wingtip fences',
};

const ratioText = (r: number): string => (r >= 10 ? r.toFixed(0) : r.toFixed(1));

/**
 * Plain-language reasons the two wings differ, generated from the numbers. Returns at most
 * five short sentences; a fallback sentence when the aircraft are nearly identical.
 */
export function explainDifferences(a: CaseSummary, b: CaseSummary): string[] {
  const out: string[] = [];
  const nameA = a.preset.shortName;
  const nameB = b.preset.shortName;
  if (a.preset.id === b.preset.id) {
    return ['These are the same aircraft. Pick two different ones to see what changes.'];
  }

  // Size.
  const spanRatio = a.spanM / b.spanM;
  if (spanRatio >= 1.2 || spanRatio <= 1 / 1.2) {
    const [big, small] = spanRatio > 1 ? [a, b] : [b, a];
    const areaRatio = big.areaM2 / small.areaM2;
    out.push(
      `The ${big.preset.shortName} is the larger wing: ${formatLength(big.spanM, 'metric')} across against ${formatLength(small.spanM, 'metric')}, with ${ratioText(areaRatio)}× the wing area. More area means more total lift for a heavier aircraft.`,
    );
  }

  // Sweep and speed.
  if (Math.abs(a.sweepDeg - b.sweepDeg) >= 5) {
    const [more, less] = a.sweepDeg > b.sweepDeg ? [a, b] : [b, a];
    const faster = more.cruiseMach - less.cruiseMach >= 0.03;
    out.push(
      `The ${more.preset.shortName} sweeps its wing back ${more.sweepDeg.toFixed(0)}° against ${less.sweepDeg.toFixed(0)}°. Sweep delays the shock waves that form near the speed of sound` +
        (faster
          ? `, which is why it cruises at Mach ${more.cruiseMach.toFixed(2)} instead of ${less.cruiseMach.toFixed(2)}.`
          : '.'),
    );
  }

  // Aspect ratio and drag.
  const arRatio = a.aspectRatio / b.aspectRatio;
  if (arRatio >= 1.15 || arRatio <= 1 / 1.15) {
    const [slim, stubby] = arRatio > 1 ? [a, b] : [b, a];
    const better = slim.liftToDrag > stubby.liftToDrag * 1.03;
    out.push(
      `The ${slim.preset.shortName} has the longer, slimmer wing (aspect ratio ${slim.aspectRatio.toFixed(1)} against ${stubby.aspectRatio.toFixed(1)}). Long wings leak less lift around the tips, so they waste less energy as induced drag` +
        (better
          ? `: its lift-to-drag is ${slim.liftToDrag.toFixed(1)} against ${stubby.liftToDrag.toFixed(1)}.`
          : '.'),
    );
  }

  // Wing loading and landing speed.
  const wlRatio = a.wingLoading / b.wingLoading;
  if (wlRatio >= 1.2 || wlRatio <= 1 / 1.2) {
    const [heavy, light] = wlRatio > 1 ? [a, b] : [b, a];
    const faster = (Math.sqrt(heavy.wingLoading / light.wingLoading) - 1) * 100;
    out.push(
      `The ${heavy.preset.shortName} loads ${Math.round(heavy.wingLoading)} kg onto every square metre of wing, the ${light.preset.shortName} only ${Math.round(light.wingLoading)}. Speed needed to stay up grows with the square root of that load, so the ${heavy.preset.shortName} has to land about ${Math.round(faster)}% faster.`,
    );
  }

  // Tip devices.
  const kindA = a.preset.wing.tipDevice.kind;
  const kindB = b.preset.wing.tipDevice.kind;
  if (kindA !== kindB) {
    const [fitted, other, kind] = kindA !== 'none' ? [nameA, nameB, kindA] : [nameB, nameA, kindB];
    const otherKind = kindA !== 'none' ? kindB : kindA;
    out.push(
      otherKind === 'none'
        ? `The ${fitted} has ${DEVICE_NAMES[kind]} and the ${other} has none. A tip device softens the swirl at the wingtip, so the wing behaves as if it were a little longer.`
        : `The ${nameA} uses ${DEVICE_NAMES[kindA]} and the ${nameB} uses ${DEVICE_NAMES[kindB]}: different ways of calming the swirl at the wingtip.`,
    );
  }

  if (out.length === 0) {
    out.push(
      `The ${nameA} and the ${nameB} have very similar wings: the numbers above differ only in the details.`,
    );
  }
  return out.slice(0, 5);
}

/* ------------------------------------------------------------------------------------------ */
/* Planform SVG                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface PlanformInput {
  slot: 'a' | 'b';
  /** Short name for the dimension label. */
  label: string;
  shapes: PlanformShape[];
  /** Body-frame x of the root quarter chord; both aircraft are aligned on it. */
  pivotX: number;
  /** Tip-to-tip span in metres (for the dimension line). */
  spanM: number;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * SVG markup of the planforms overlaid at one common scale (top view, nose up, roots aligned on
 * the pitch pivot), with a dimension line per aircraft and a scale bar.
 */
export function buildPlanformSvg(inputs: readonly PlanformInput[], units: UnitSystem): string {
  const W = 640;
  const margin = 24;
  const top = 14;
  if (inputs.length === 0) return '';

  // Shared extents (after aligning on each pivot) fix the one common scale.
  let maxHalf = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const input of inputs) {
    const b = shapeBounds(input.shapes, input.pivotX);
    maxHalf = Math.max(maxHalf, Math.abs(b.minY), Math.abs(b.maxY), input.spanM / 2);
    minX = Math.min(minX, b.minX);
    maxX = Math.max(maxX, b.maxX);
  }
  if (!Number.isFinite(minX) || !(maxHalf > 0)) return '';
  const depth = Math.max(1e-6, maxX - minX);
  const scale = Math.min((W - 2 * margin) / (2 * maxHalf), 230 / depth);
  const planformBottom = top + depth * scale;
  const dimStart = planformBottom + 22;
  const rowH = 24;
  const barY = dimStart + inputs.length * rowH + 12;
  const H = Math.ceil(barY + 24);
  const cx = W / 2;
  const sx = (y: number): number => cx + y * scale;
  const sy = (x: number, pivotX: number): number => top + (x - pivotX - minX) * scale;

  const parts: string[] = [];
  parts.push(
    `<svg class="viz-planform" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wing outlines of the two aircraft drawn to the same scale" xmlns="http://www.w3.org/2000/svg">`,
  );
  // Centre line.
  parts.push(
    `<line class="viz-plan-dim" stroke="#8a97a8" stroke-opacity="0.6" x1="${cx}" y1="${top - 6}" x2="${cx}" y2="${planformBottom + 6}" stroke-dasharray="2 4"/>`,
  );

  for (const input of inputs) {
    const cls = input.slot === 'a' ? 'viz-plan-a' : 'viz-plan-b';
    const stroke = input.slot === 'a' ? 'var(--viz-series-1)' : 'var(--viz-series-2)';
    parts.push(
      `<g class="${cls}" style="fill:${stroke};fill-opacity:0.22;stroke:${stroke};stroke-width:1.6;stroke-linejoin:round">`,
    );
    for (const shape of input.shapes) {
      const pts = shape.points
        .map(([x, y]) => `${sx(y).toFixed(1)},${sy(x, input.pivotX).toFixed(1)}`)
        .join(' ');
      parts.push(
        `<polygon data-surface="${escapeXml(shape.surfaceId)}" data-role="${shape.role}" points="${pts}"/>`,
      );
    }
    parts.push('</g>');
  }

  // Dimension lines: tip to tip, one row per aircraft.
  inputs.forEach((input, i) => {
    const y = dimStart + i * rowH;
    const half = (input.spanM / 2) * scale;
    const color = input.slot === 'a' ? 'var(--viz-series-1)' : 'var(--viz-series-2)';
    const label = `${escapeXml(input.label)}  ·  ${escapeXml(formatLength(input.spanM, units))}`;
    parts.push(
      `<g class="viz-plan-dimension" data-slot="${input.slot}" style="stroke:${color};stroke-width:1.2;fill:none">` +
        `<line x1="${(cx - half).toFixed(1)}" y1="${y}" x2="${(cx + half).toFixed(1)}" y2="${y}"/>` +
        `<line x1="${(cx - half).toFixed(1)}" y1="${y - 4}" x2="${(cx - half).toFixed(1)}" y2="${y + 4}"/>` +
        `<line x1="${(cx + half).toFixed(1)}" y1="${y - 4}" x2="${(cx + half).toFixed(1)}" y2="${y + 4}"/>` +
        `</g>` +
        `<text x="${cx}" y="${y - 5}" text-anchor="middle" style="fill:${color}">${label}</text>`,
    );
  });

  // Scale bar (a round length that is roughly a fifth of the widest span).
  const unitPerMeter = units === 'imperial' ? M_TO_FT : 1;
  const unitName = units === 'imperial' ? 'ft' : 'm';
  const barLength = niceScaleBarLength((2 * maxHalf * unitPerMeter) / 5);
  const barPx = (barLength / unitPerMeter) * scale;
  const bx = margin;
  parts.push(
    `<g class="viz-plan-scalebar"><line class="viz-plan-dim" stroke="#8a97a8" stroke-width="2" x1="${bx}" y1="${barY}" x2="${(bx + barPx).toFixed(1)}" y2="${barY}"/>` +
      `<line class="viz-plan-dim" stroke="#8a97a8" x1="${bx}" y1="${barY - 4}" x2="${bx}" y2="${barY + 4}"/>` +
      `<line class="viz-plan-dim" stroke="#8a97a8" x1="${(bx + barPx).toFixed(1)}" y1="${barY - 4}" x2="${(bx + barPx).toFixed(1)}" y2="${barY + 4}"/>` +
      `<text class="viz-plan-muted" x="${(bx + barPx + 8).toFixed(1)}" y="${barY + 4}">${barLength} ${unitName}</text></g>`,
  );
  parts.push('</svg>');
  return parts.join('');
}
