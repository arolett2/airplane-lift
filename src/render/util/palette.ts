/**
 * The 3D view's pressure palettes. Same MEANING as `shared/colormaps.ts` (blue = low pressure /
 * fast air, neutral = undisturbed air, red = high pressure / slowed air) but tuned for a dark,
 * lit 3D scene:
 *
 *  - WING: saturates sooner (an airliner's upper surface sits around Cp -0.5 .. -1, which the 2D
 *    map renders as a pale tint) and keeps mid-tones bright enough to survive shading.
 *  - FLOW (smoke, streamlines): undisturbed air is a dim, cool grey so the freestream recedes;
 *    any departure from it becomes a bright, saturated blue or red-orange that pops against the
 *    navy background. `flowEmphasis` (0 .. 1) says how far from the freestream a value is, so
 *    renderers can also fade the undisturbed smoke.
 *
 * All colours are sRGB 0..1. Pure (no three.js).
 */
import type { RGB } from '../../shared/colormaps';
import { speedColor } from '../../shared/colormaps';

type Stops = readonly (readonly [number, RGB])[];

/** Wing surface: Cp -> sRGB (stops in ascending Cp). */
const WING_STOPS: Stops = [
  [-2.0, [0.09, 0.2, 0.66]],
  [-1.4, [0.13, 0.33, 0.85]],
  [-0.9, [0.26, 0.5, 0.94]],
  [-0.5, [0.48, 0.68, 0.97]],
  [-0.2, [0.73, 0.84, 0.98]],
  [0.0, [0.94, 0.95, 0.96]],
  [0.15, [0.99, 0.75, 0.65]],
  [0.5, [0.95, 0.42, 0.3]],
  [1.0, [0.8, 0.1, 0.1]],
];

/** Smoke and streamlines on the dark background: Cp -> sRGB (stops in ascending Cp). */
const FLOW_STOPS: Stops = [
  [-2.5, [0.36, 0.5, 1.0]],
  [-1.0, [0.27, 0.56, 1.0]],
  [-0.45, [0.32, 0.64, 1.0]],
  [-0.15, [0.5, 0.69, 0.92]],
  [0.0, [0.55, 0.6, 0.68]],
  [0.12, [0.9, 0.64, 0.56]],
  [0.4, [1.0, 0.47, 0.32]],
  [1.0, [1.0, 0.3, 0.2]],
];

/** |Cp| at which the flow colour reaches full emphasis, on the suction / pressure side. */
const FLOW_SUCTION_FULL = 0.55;
const FLOW_PRESSURE_FULL = 0.35;
/** |V/Vinf - 1| at which the speed colouring reaches full emphasis. */
const SPEED_FULL = 0.3;

function sampleStops(stops: Stops, x: number, out: RGB): RGB {
  const v = Number.isFinite(x) ? x : 0;
  if (v <= stops[0]![0]) {
    const c = stops[0]![1];
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    return out;
  }
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i]!;
    if (v <= x1) {
      const [x0, c0] = stops[i - 1]!;
      const f = (v - x0) / (x1 - x0);
      out[0] = c0[0] + (c1[0] - c0[0]) * f;
      out[1] = c0[1] + (c1[1] - c0[1]) * f;
      out[2] = c0[2] + (c1[2] - c0[2]) * f;
      return out;
    }
  }
  const c = stops[stops.length - 1]![1];
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}

/** Wing surface colour for a pressure coefficient (sRGB). */
export function wingPressureColor(cp: number, out: RGB = [0, 0, 0]): RGB {
  return sampleStops(WING_STOPS, cp, out);
}

/** Smoke / streamline colour for a pressure coefficient (sRGB). */
export function flowPressureColor(cp: number, out: RGB = [0, 0, 0]): RGB {
  return sampleStops(FLOW_STOPS, cp, out);
}

/** 0 for undisturbed air, rising to 1 for strongly sped-up or slowed air. */
export function flowEmphasis(cp: number): number {
  if (!Number.isFinite(cp)) return 0;
  const t = cp < 0 ? -cp / FLOW_SUCTION_FULL : cp / FLOW_PRESSURE_FULL;
  return Math.pow(Math.min(1, t), 0.75);
}

/** Speed-mode colour (the shared sequential map) and its emphasis. */
export function flowSpeedColor(speedRatio: number, out: RGB = [0, 0, 0]): RGB {
  return speedColor(speedRatio, out);
}

export function speedEmphasis(speedRatio: number): number {
  if (!Number.isFinite(speedRatio)) return 0;
  return Math.pow(Math.min(1, Math.abs(speedRatio - 1) / SPEED_FULL), 0.75);
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** CSS colour string for an sRGB triple. */
export function cssRgb(c: Readonly<RGB>): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}
