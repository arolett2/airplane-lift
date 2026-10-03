/**
 * Pure helpers for the span-load "lift curtain": bar colour by stall margin, an orthonormal
 * basis for each bar, the elliptical reference load and the common height scale.
 */
import type { RGB } from '../../shared/colormaps';
import type { Vec3 } from '../../physics/types';

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lin(c: RGB): RGB {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

const GREEN = lin([0.2, 0.8, 0.38]);
const AMBER = lin([1.0, 0.75, 0.16]);
const RED = lin([0.93, 0.2, 0.15]);

/** Stall-margin ratios at which the bar colour passes amber and then red. */
export const AMBER_START = 0.6;
export const AMBER_FULL = 0.85;
export const RED_FULL = 1.0;

/**
 * Colour (linear RGB) for a strip using `cl / clMax` of its section: green -> amber -> red.
 * A strip the solver flags as stalled is always full red.
 */
export function stallMarginColor(cl: number, clMax: number, out: RGB, stalled = false): RGB {
  const ratio = stalled ? RED_FULL : clMax > 1e-6 ? Math.abs(cl) / clMax : 0;
  const mix = (a: RGB, b: RGB, t: number) => {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
  };
  if (!(ratio > AMBER_START)) mix(GREEN, GREEN, 0);
  else if (ratio < AMBER_FULL)
    mix(GREEN, AMBER, (ratio - AMBER_START) / (AMBER_FULL - AMBER_START));
  else if (ratio < RED_FULL) mix(AMBER, RED, (ratio - AMBER_FULL) / (RED_FULL - AMBER_FULL));
  else mix(RED, RED, 0);
  return out;
}

/**
 * Right-handed orthonormal basis (c, t, n) for a bar standing on a strip: n is the strip
 * normal, c the chordwise direction (tunnel +x projected perpendicular to n), t the span
 * direction (n x c). Degenerate normals fall back to +z.
 */
export function curtainBasis(normal: Vec3, outC: Vec3, outT: Vec3, outN: Vec3): void {
  let nx = normal[0];
  let ny = normal[1];
  let nz = normal[2];
  let nl = Math.hypot(nx, ny, nz);
  if (!(nl > 1e-9)) {
    nx = 0;
    ny = 0;
    nz = 1;
    nl = 1;
  }
  nx /= nl;
  ny /= nl;
  nz /= nl;
  // x-hat minus its component along n.
  let cx = 1 - nx * nx;
  let cy = -nx * ny;
  let cz = -nx * nz;
  let cl = Math.hypot(cx, cy, cz);
  if (cl < 1e-6) {
    // Normal is (almost) along the flow: use y-hat instead.
    cx = -ny * nx;
    cy = 1 - ny * ny;
    cz = -ny * nz;
    cl = Math.hypot(cx, cy, cz) || 1;
  }
  cx /= cl;
  cy /= cl;
  cz /= cl;
  outN[0] = nx;
  outN[1] = ny;
  outN[2] = nz;
  outC[0] = cx;
  outC[1] = cy;
  outC[2] = cz;
  // t = n x c
  outT[0] = ny * cz - nz * cy;
  outT[1] = nz * cx - nx * cz;
  outT[2] = nx * cy - ny * cx;
}

/** Elliptical lift per unit span (N/m) at spanwise position y for total lift L over span b. */
export function ellipticalLoad(y: number, span: number, totalLift: number): number {
  const s = (2 * y) / span;
  if (Math.abs(s) >= 1 || span <= 0) return 0;
  return ((4 * totalLift) / (Math.PI * span)) * Math.sqrt(1 - s * s);
}

/**
 * Meters of bar height per N/m of lift per span, so the larger of the actual peak load and the
 * elliptical peak reaches `maxHeight`. Returns 0 when there is no load.
 */
export function curtainScale(maxLoad: number, ellipsePeak: number, maxHeight: number): number {
  const ref = Math.max(maxLoad, ellipsePeak, 0);
  return ref > 1e-9 ? maxHeight / ref : 0;
}
