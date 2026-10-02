/**
 * Pure axis helpers for the charts: "nice" tick generation and tick label formatting.
 * No DOM here, so everything is unit-testable in node.
 */

/** Round `range` to a "nice" number (1, 2, 5 or 10 times a power of ten). */
export function niceNumber(range: number, round: boolean): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let nice: number;
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

export interface NiceScale {
  /** Axis minimum (a multiple of `step` when the axis was expanded to nice bounds). */
  min: number;
  max: number;
  /** Distance between ticks. */
  step: number;
  /** Tick values inside [min, max], ascending. */
  ticks: number[];
}

/** Remove floating point dust such as 0.30000000000000004. */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

/** Ticks at integer multiples of `step` that lie within [min, max] (with a tiny tolerance). */
export function ticksFromStep(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  if (!(step > 0) || !(max >= min)) return out;
  const eps = step * 1e-9;
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  // Guard against absurd tick counts if a caller passes a tiny step.
  const count = Math.min(last - first, 200);
  for (let i = 0; i <= count; i++) {
    const v = clean((first + i) * step);
    if (v >= min - eps && v <= max + eps) out.push(v);
  }
  return out;
}

/**
 * "Nice" ticks inside [min, max] without changing the range. About `targetCount` ticks
 * (the result can have one or two more or fewer so that the step is 1, 2 or 5 x 10^n).
 */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return Number.isFinite(min) ? [clean(min)] : [];
  }
  const step = niceNumber((max - min) / Math.max(1, targetCount - 1), true);
  return ticksFromStep(min, max, step);
}

/**
 * Expand [min, max] outward to nice bounds and return the ticks. A degenerate range
 * (min == max) is widened around the value so charts of constant data still have an axis.
 */
export function niceScale(min: number, max: number, targetCount = 5): NiceScale {
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-12 * Math.max(1, Math.abs(lo))) {
    const pad = Math.abs(lo) > 1e-9 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const range = niceNumber(hi - lo, false);
  const step = niceNumber(range / Math.max(1, targetCount - 1), true);
  const niceMin = clean(Math.floor(lo / step + 1e-9) * step);
  const niceMax = clean(Math.ceil(hi / step - 1e-9) * step);
  return { min: niceMin, max: niceMax, step, ticks: ticksFromStep(niceMin, niceMax, step) };
}

/** Number of decimals needed to print multiples of `step` exactly. */
export function tickDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

/** Format a tick label with just enough decimals for the tick spacing; never "-0". */
export function formatTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return '';
  const text = value.toFixed(tickDecimals(step));
  return Number(text) === 0 ? text.replace(/^-/, '') : text;
}

/**
 * Format an arbitrary data value for a tooltip: about three significant digits, never
 * scientific notation for everyday magnitudes, and no trailing zeros noise.
 */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(3);
  if (abs >= 0.01) return value.toFixed(3);
  return value.toPrecision(2);
}
