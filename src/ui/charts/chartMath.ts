/**
 * Pure helpers behind LineChart: data extents, axis range resolution, linear scales and
 * nearest-point search. Kept separate from the canvas code so they can be tested in node.
 */
import { niceScale, ticksFromStep, type NiceScale } from './ticks';

export interface Extent {
  min: number;
  max: number;
}

/** Extent of the finite values across several arrays, or null when there are none. */
export function extentOf(arrays: readonly ArrayLike<number>[]): Extent | null {
  let min = Infinity;
  let max = -Infinity;
  for (const arr of arrays) {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]!;
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min <= max ? { min, max } : null;
}

export interface AxisRangeOptions {
  /** Fixed lower bound (otherwise taken from the data and rounded outward). */
  min?: number;
  max?: number;
  /** Make sure 0 is inside the range. */
  includeZero?: boolean;
  /** Desired number of ticks (default 5). */
  tickCount?: number;
}

/**
 * Resolve the displayed range and tick marks for one axis. Free ends are expanded to nice
 * numbers; fixed ends (options.min / options.max) are respected exactly.
 */
export function resolveAxisRange(extent: Extent | null, options: AxisRangeOptions = {}): NiceScale {
  const count = options.tickCount ?? 5;
  let lo = options.min ?? extent?.min ?? 0;
  let hi = options.max ?? extent?.max ?? 1;
  if (options.includeZero) {
    if (options.min === undefined) lo = Math.min(lo, 0);
    if (options.max === undefined) hi = Math.max(hi, 0);
  }
  if (hi < lo) [lo, hi] = [hi, lo];
  const nice = niceScale(lo, hi, count);
  const min = options.min ?? nice.min;
  const max = options.max ?? nice.max;
  if (!(max > min)) return { min, max: min + 1, step: 1, ticks: [min] };
  return { min, max, step: nice.step, ticks: ticksFromStep(min, max, nice.step) };
}

/** Linear mapping from a data domain to a pixel range (either direction). */
export class LinearScale {
  constructor(
    readonly d0: number,
    readonly d1: number,
    readonly p0: number,
    readonly p1: number,
  ) {}

  map(v: number): number {
    return this.p0 + ((v - this.d0) / (this.d1 - this.d0)) * (this.p1 - this.p0);
  }

  invert(p: number): number {
    return this.d0 + ((p - this.p0) / (this.p1 - this.p0)) * (this.d1 - this.d0);
  }
}

export interface NearestHit {
  seriesIndex: number;
  pointIndex: number;
  /** Pixel distance to the hit. */
  distance: number;
}

/**
 * Nearest data point (in pixel space) to (px, py) across several series. Points with a
 * non-finite coordinate are ignored. Returns null if nothing is within `maxDistance`.
 */
export function nearestPoint(
  series: readonly { x: ArrayLike<number>; y: ArrayLike<number> }[],
  xScale: LinearScale,
  yScale: LinearScale,
  px: number,
  py: number,
  maxDistance = Infinity,
): NearestHit | null {
  let best: NearestHit | null = null;
  let bestD2 = maxDistance * maxDistance;
  for (let s = 0; s < series.length; s++) {
    const { x, y } = series[s]!;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const xv = x[i]!;
      const yv = y[i]!;
      if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
      const dx = xScale.map(xv) - px;
      const dy = yScale.map(yv) - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = { seriesIndex: s, pointIndex: i, distance: Math.sqrt(d2) };
      }
    }
  }
  return best;
}

/**
 * Linear interpolation of y at `x` along an x-ascending polyline. Returns null when `x` is
 * outside the data range or the polyline has fewer than two finite points.
 */
export function interpolateAt(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  x: number,
): number | null {
  const n = Math.min(xs.length, ys.length);
  for (let i = 1; i < n; i++) {
    const x0 = xs[i - 1]!;
    const x1 = xs[i]!;
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    if ((x >= x0 && x <= x1) || (x <= x0 && x >= x1)) {
      const y0 = ys[i - 1]!;
      const y1 = ys[i]!;
      if (x1 === x0) return y0;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return null;
}
