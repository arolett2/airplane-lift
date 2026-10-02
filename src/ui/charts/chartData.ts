/**
 * Pure data preparation for ChartsPanel: turns solver results into plottable series and
 * plain-language "right now" sentences. No DOM, so it is tested in node.
 */
import type {
  AeroResult,
  PolarSweep,
  SectionFlow,
  StripResult,
  WingGeometry,
} from '../../physics/types';
import { interpolateAt } from './chartMath';

const RAD2DEG = 180 / Math.PI;

/* ------------------------------------------------------------------------------------------ */
/* Lift curve                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface LiftCurveData {
  /** Angle of attack samples (deg). */
  alphaDeg: Float32Array;
  /** Whole finite wing. */
  wingCL: Float32Array;
  /** 2D section of the root airfoil (an "endless" wing). */
  sectionCL: Float32Array;
  /** Angle of stall (deg) when it lies inside the sweep, else null. */
  stallAlphaDeg: number | null;
  CLmax: number;
  /** The wing's current operating point, or null if unknown. */
  current: { alphaDeg: number; CL: number; sectionCL: number | null } | null;
}

/**
 * Current operating point on the lift curve. `alphaDeg` comes from the controls so the marker
 * follows the slider instantly; the lift value is the solver's own when it has caught up, else
 * read off the curve.
 */
export function liftCurveData(
  polar: PolarSweep,
  alphaDeg: number | null,
  aero: AeroResult | null,
): LiftCurveData {
  const a = polar.alphaDeg;
  const lo = a.length ? a[0]! : 0;
  const hi = a.length ? a[a.length - 1]! : 0;
  const stall = Number.isFinite(polar.alphaStallDeg) ? polar.alphaStallDeg : NaN;
  const stallInside = stall >= Math.min(lo, hi) && stall <= Math.max(lo, hi);

  let current: LiftCurveData['current'] = null;
  if (alphaDeg !== null && Number.isFinite(alphaDeg)) {
    const solverAlpha = aero ? aero.alpha * RAD2DEG : NaN;
    const fromCurve = interpolateAt(a, polar.CL, alphaDeg);
    const useSolver = aero && Math.abs(solverAlpha - alphaDeg) < 0.05;
    const CL = useSolver ? aero.CL : fromCurve;
    if (CL !== null && Number.isFinite(CL)) {
      current = { alphaDeg, CL, sectionCL: interpolateAt(a, polar.sectionCl, alphaDeg) };
    }
  }
  return {
    alphaDeg: a,
    wingCL: polar.CL,
    sectionCL: polar.sectionCl,
    stallAlphaDeg: stallInside ? stall : null,
    CLmax: polar.CLmax,
    current,
  };
}

export function liftCurveNote(data: LiftCurveData): string | null {
  const c = data.current;
  if (!c) return null;
  const a = c.alphaDeg.toFixed(1);
  if (c.sectionCL === null || !Number.isFinite(c.sectionCL)) {
    return `At ${a}° your wing makes a lift coefficient of ${c.CL.toFixed(2)}.`;
  }
  const lost = c.sectionCL > 0.05 ? 1 - c.CL / c.sectionCL : null;
  const tail =
    lost !== null && lost > 0.01 && lost < 0.95
      ? `, about ${Math.round(lost * 100)}% less than an endless wing (${c.sectionCL.toFixed(2)})`
      : `, versus ${c.sectionCL.toFixed(2)} for an endless wing`;
  return `At ${a}° your wing makes a lift coefficient of ${c.CL.toFixed(2)}${tail}.`;
}

/* ------------------------------------------------------------------------------------------ */
/* Along the span                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface SpanLine {
  eta: number[];
  /** Local lift per unit span divided by the base wing's average. */
  load: number[];
  /** Local cl / clMax: 1 means "right at the stall limit". */
  ratio: number[];
}

export interface SpanChartData {
  /** Base wing (right side), root to tip. */
  wing: SpanLine;
  /** One polyline per tip-device surface; each starts at the last wing point so it joins up. */
  devices: SpanLine[];
  /** Elliptical load of equal total lift over the base wing, normalised the same way. */
  ellipse: { eta: number[]; load: number[] };
  /** Largest x value (above 1 when tip devices are present). */
  etaMax: number;
  /** The strip closest to its stall limit. */
  closest: { eta: number; ratio: number } | null;
  /** True when any strip is beyond clMax. */
  anyStalled: boolean;
}

const ELLIPSE_POINTS = 41;

/** Elliptical lift distribution (4/pi) sqrt(1 - eta^2): equal total lift when the mean is 1. */
export function ellipticalLoad(eta: number): number {
  const e = Math.min(1, Math.max(-1, eta));
  return (4 / Math.PI) * Math.sqrt(Math.max(0, 1 - e * e));
}

export function spanChartData(
  aero: AeroResult,
  geometry: WingGeometry | null,
): SpanChartData | null {
  const right = aero.strips.filter((s) => s.side === 'right');
  if (right.length === 0) return null;

  // Group by surface in first-appearance order.
  const groups = new Map<string, StripResult[]>();
  for (const s of right) {
    let g = groups.get(s.surfaceId);
    if (!g) groups.set(s.surfaceId, (g = []));
    g.push(s);
  }
  const roleOf = new Map<string, string>();
  for (const surf of geometry?.surfaces ?? []) roleOf.set(surf.id, surf.role);

  const wingStrips: StripResult[] = [];
  const deviceGroups: StripResult[][] = [];
  for (const [id, strips] of groups) {
    const sorted = [...strips].sort((a, b) => a.eta - b.eta);
    const role = roleOf.get(id);
    const isWing = role ? role === 'wing' : sorted[0]!.eta <= 1;
    if (isWing) wingStrips.push(...sorted);
    else deviceGroups.push(sorted);
  }
  if (wingStrips.length === 0) return null;
  wingStrips.sort((a, b) => a.eta - b.eta);

  // Width-weighted mean load over the base wing = "average lift per metre".
  let sumLoad = 0;
  let sumWidth = 0;
  let peak = 0;
  for (const s of wingStrips) {
    const w = s.width > 0 ? s.width : 1;
    sumLoad += s.liftPerSpan * w;
    sumWidth += w;
    peak = Math.max(peak, Math.abs(s.liftPerSpan));
  }
  const mean = sumLoad / sumWidth;
  const norm = Math.abs(mean);
  if (!(norm > 1e-6) || !(peak > 0)) return null;
  const sign = mean < 0 ? -1 : 1;

  const toLine = (strips: StripResult[], shift: number): SpanLine => ({
    eta: strips.map((s) => s.eta + shift),
    load: strips.map((s) => s.liftPerSpan / norm),
    ratio: strips.map((s) => (s.clMax > 1e-6 ? s.cl / s.clMax : NaN)),
  });
  const wing = toLine(wingStrips, 0);
  const devices = deviceGroups.map((strips) => {
    const minEta = strips[0]!.eta;
    const line = toLine(strips, minEta < 1 - 1e-6 ? 1 - minEta : 0);
    // Join the device line to the wingtip so it reads as a continuation.
    line.eta.unshift(wing.eta[wing.eta.length - 1]!);
    line.load.unshift(wing.load[wing.load.length - 1]!);
    line.ratio.unshift(wing.ratio[wing.ratio.length - 1]!);
    return line;
  });

  const ellipseEta: number[] = [];
  const ellipseLoad: number[] = [];
  for (let i = 0; i < ELLIPSE_POINTS; i++) {
    const eta = i / (ELLIPSE_POINTS - 1);
    ellipseEta.push(eta);
    ellipseLoad.push(sign * ellipticalLoad(eta));
  }

  let etaMax = wing.eta[wing.eta.length - 1]!;
  for (const d of devices) etaMax = Math.max(etaMax, d.eta[d.eta.length - 1]!);

  let closest: SpanChartData['closest'] = null;
  for (const line of [wing, ...devices]) {
    for (let i = 0; i < line.ratio.length; i++) {
      const r = line.ratio[i]!;
      if (Number.isFinite(r) && (closest === null || r > closest.ratio)) {
        closest = { eta: line.eta[i]!, ratio: r };
      }
    }
  }

  return {
    wing,
    devices,
    ellipse: { eta: ellipseEta, load: ellipseLoad },
    etaMax,
    closest,
    anyStalled: right.some((s) => s.stalled),
  };
}

export function spanLoadNote(data: SpanChartData): string | null {
  if (!data.closest) return null;
  const pct = Math.round(data.closest.eta * 100);
  const used = Math.round(Math.max(0, data.closest.ratio) * 100);
  if (data.closest.ratio >= 1) {
    return `Part of the wing near ${pct}% of the way out is past its stall limit.`;
  }
  return `Closest to stalling: about ${pct}% of the way out, using ${used}% of its lift limit.`;
}

/* ------------------------------------------------------------------------------------------ */
/* Pressure                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface PressureData {
  xc: Float32Array;
  upper: Float32Array;
  lower: Float32Array;
  /** Lowest (most suction) upper-surface Cp. */
  peakSuction: number;
}

export function pressureData(section: SectionFlow): PressureData {
  const { xc, upper, lower } = section.cp;
  let peak = Infinity;
  for (let i = 0; i < upper.length; i++) if (upper[i]! < peak) peak = upper[i]!;
  return { xc, upper, lower, peakSuction: Number.isFinite(peak) ? peak : 0 };
}

export function pressureNote(section: SectionFlow): string {
  const pct = Math.round(section.eta * 100);
  const where = pct === 0 ? 'at the wing root' : `${pct}% of the way out along the wing`;
  const deg = (section.alphaEffective * RAD2DEG).toFixed(1);
  const stalled = section.stalled
    ? ' The flow has separated from the top, which flattens the suction.'
    : '';
  return `This slice is ${where}, meeting the air at an effective ${deg}°.${stalled}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Drag polar                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface DragPolarData {
  CD: Float32Array;
  CL: Float32Array;
  /** Steepest line from the origin that still touches the curve: the best glide ratio. */
  bestGlide: { CL: number; CD: number; liftToDrag: number } | null;
  current: { CL: number; CD: number; liftToDrag: number } | null;
}

export function dragPolarData(polar: PolarSweep, aero: AeroResult | null): DragPolarData {
  // Only look before the stall peak: after it, CL falls and "best glide" is meaningless.
  let peakIndex = 0;
  for (let i = 0; i < polar.CL.length; i++) if (polar.CL[i]! > polar.CL[peakIndex]!) peakIndex = i;
  let best: DragPolarData['bestGlide'] = null;
  for (let i = 0; i <= peakIndex; i++) {
    const cl = polar.CL[i]!;
    const cd = polar.CD[i]!;
    if (!(cl > 0.05) || !(cd > 1e-6)) continue;
    const ld = cl / cd;
    if (!best || ld > best.liftToDrag) best = { CL: cl, CD: cd, liftToDrag: ld };
  }
  const current =
    aero && aero.CD > 1e-6 ? { CL: aero.CL, CD: aero.CD, liftToDrag: aero.CL / aero.CD } : null;
  return { CD: polar.CD, CL: polar.CL, bestGlide: best, current };
}

export function dragNote(data: DragPolarData): string | null {
  const { bestGlide: best, current } = data;
  if (!best) return null;
  if (!current)
    return `The best glide is about ${best.liftToDrag.toFixed(0)} metres forward per metre of drop.`;
  return (
    `You are at lift-to-drag ${current.liftToDrag.toFixed(1)}; ` +
    `the sweet spot is ${best.liftToDrag.toFixed(1)}, at a lift coefficient of ${best.CL.toFixed(2)}.`
  );
}
