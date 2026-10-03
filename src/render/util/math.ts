/** Tiny numeric helpers shared by the render modules (pure, allocation free). */

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep: 0 below e0, 1 above e1, smooth in between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Cubic ease-in-out on t in [0, 1]. */
export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Frame-rate independent exponential smoothing factor: the fraction of the remaining distance
 * to cover this frame so the value reaches ~63 % of a step after `tau` seconds.
 */
export function smoothingFactor(dt: number, tau: number): number {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, dt) / tau);
}

/** Smallest power of two >= n (n >= 1). */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
