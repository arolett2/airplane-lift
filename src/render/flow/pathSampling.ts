/**
 * Pure, allocation-free sampling of a streamline by time. No three.js, so it is unit-testable
 * and cheap to call thousands of times per frame.
 */
import type { Streamline3D } from '../../physics/types';

/** The part of a streamline needed to sample it. */
export type TimedPath = Pick<Streamline3D, 'points' | 'time'> &
  Partial<Pick<Streamline3D, 'speed'>>;

/** Number of usable vertices of a path (0 when malformed). */
export function pathLength(line: TimedPath): number {
  return Math.min(line.time.length, Math.floor(line.points.length / 3));
}

/** Elapsed time covered by the path: time[n-1] - time[0] (0 for degenerate paths). */
export function pathDuration(line: TimedPath): number {
  const n = pathLength(line);
  return n < 2 ? 0 : line.time[n - 1]! - line.time[0]!;
}

/**
 * Binary search: the index i in [0, n-2] with time[i] <= t < time[i+1] (clamped at both ends).
 * Requires n >= 2 and a non-decreasing time array.
 */
export function findSegment(time: ArrayLike<number>, n: number, t: number): number {
  let lo = 0;
  let hi = n - 1; // invariant: time[lo] <= t (when t >= time[0]), time[hi] > t
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (time[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

type Writable = { [index: number]: number };

/**
 * Evaluate the path at absolute time `t` (same clock as line.time). Writes x,y,z to
 * out[offset..offset+2] and returns |V|/Vinf there (1 if the line has no speed array), or
 * -1 when t lies outside [time[0], time[n-1]] (out is then untouched).
 */
export function sampleLineAtTime(
  line: TimedPath,
  t: number,
  out: Writable,
  offset: number,
): number {
  const n = pathLength(line);
  if (n < 2) return -1;
  const time = line.time;
  if (!(t >= time[0]! && t <= time[n - 1]!)) return -1;
  const i = findSegment(time, n, t);
  const t0 = time[i]!;
  const dt = time[i + 1]! - t0;
  const f = dt > 1e-12 ? (t - t0) / dt : 0;
  const p = line.points;
  const a = i * 3;
  const b = a + 3;
  out[offset] = p[a]! + (p[b]! - p[a]!) * f;
  out[offset + 1] = p[a + 1]! + (p[b + 1]! - p[a + 1]!) * f;
  out[offset + 2] = p[a + 2]! + (p[b + 2]! - p[a + 2]!) * f;
  const s = line.speed;
  if (!s || s.length < n) return 1;
  return s[i]! + (s[i + 1]! - s[i]!) * f;
}

/**
 * Position along a streamline at absolute time `t`: binary search on time + linear interpolation.
 * Writes into `out` (length >= 3) and returns true, or returns false (out untouched) when `t`
 * is outside the line's time span.
 */
export function positionAtTime(line: TimedPath, t: number, out: Writable): boolean {
  return sampleLineAtTime(line, t, out, 0) >= 0;
}
