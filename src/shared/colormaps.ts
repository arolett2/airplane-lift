/**
 * Colour maps shared by the 3D renderer and 2D canvases, so the same colour always means
 * the same thing everywhere.
 *
 * PRESSURE (diverging): low pressure / suction (Cp < 0) = BLUE, freestream (Cp = 0) = near white,
 * high pressure (Cp > 0, up to the stagnation value 1) = RED. Fast air is low pressure, so blue
 * streamlines over the wing and a blue upper surface tell the same story.
 * SPEED (sequential): slow = deep violet, freestream = teal, fast = yellow.
 */

export type RGB = [number, number, number]; // 0..1 linear-ish sRGB

const PRESSURE_STOPS: readonly [number, RGB][] = [
  [0.0, [0.03, 0.19, 0.42]], // strong suction
  [0.25, [0.13, 0.4, 0.67]],
  [0.42, [0.57, 0.77, 0.87]],
  [0.5, [0.95, 0.95, 0.95]], // freestream
  [0.58, [0.99, 0.82, 0.71]],
  [0.75, [0.84, 0.38, 0.3]],
  [1.0, [0.6, 0.0, 0.05]], // stagnation
];

const SPEED_STOPS: readonly [number, RGB][] = [
  [0.0, [0.27, 0.0, 0.33]],
  [0.25, [0.23, 0.32, 0.55]],
  [0.5, [0.13, 0.57, 0.55]],
  [0.75, [0.37, 0.79, 0.38]],
  [1.0, [0.99, 0.91, 0.14]],
];

function sample(stops: readonly [number, RGB][], t: number, out: RGB): RGB {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]!;
    if (x <= t1) {
      const [t0, c0] = stops[i - 1]!;
      const f = (x - t0) / (t1 - t0);
      out[0] = c0[0] + (c1[0] - c0[0]) * f;
      out[1] = c0[1] + (c1[1] - c0[1]) * f;
      out[2] = c0[2] + (c1[2] - c0[2]) * f;
      return out;
    }
  }
  const last = stops[stops.length - 1]![1];
  out[0] = last[0];
  out[1] = last[1];
  out[2] = last[2];
  return out;
}

/** Display range for Cp: [CP_MIN, 1]. Cp is clamped below CP_MIN. */
export const CP_MIN = -2.5;

/** Map a pressure coefficient to colour. Cp=1 -> red, Cp=0 -> white, Cp<=CP_MIN -> deep blue. */
export function pressureColor(cp: number, out: RGB = [0, 0, 0]): RGB {
  // Piecewise-linear so that Cp = 0 lands exactly on the neutral stop (t = 0.5).
  const t = cp >= 0 ? 0.5 + 0.5 * Math.min(cp, 1) : 0.5 - 0.5 * Math.min(cp / CP_MIN, 1);
  return sample(PRESSURE_STOPS, t, out);
}

/** Map speed ratio |V|/V_inf (0 .. 2) to colour; 1 (freestream) is mid-scale. */
export function speedColor(speedRatio: number, out: RGB = [0, 0, 0]): RGB {
  return sample(SPEED_STOPS, speedRatio / 2, out);
}

/** Pressure coefficient from local speed ratio via Bernoulli (incompressible). */
export function cpFromSpeed(speedRatio: number): number {
  return 1 - speedRatio * speedRatio;
}

export function rgbToCss([r, g, b]: RGB): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
