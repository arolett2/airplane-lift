/**
 * Pure vertex colouring of a lofted wing from strip results: chordwise Cp mapped through the
 * shared pressure colour map, blended between the nearest strips of the same surface, with a
 * desaturated orange tint over the separated (stalled) part of the upper surface.
 *
 * Output colours are LINEAR RGB (three.js working space), so the on-screen result matches the
 * sRGB colours the 2D views draw with the same `pressureColor` map.
 */
import { CP_MIN, pressureColor } from '../../shared/colormaps';
import type { RGB } from '../../shared/colormaps';
import type { ChordwiseCp, StripResult } from '../../physics/types';
import { VERTEX_SLAT } from './loft';
import type { LoftedWing } from './loft';
import { clamp, smoothstep } from '../util/math';

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LUT_SIZE = 1024;
let pressureLut: Float32Array | null = null;

/** Lookup table Cp -> linear RGB over [CP_MIN, 1], built on first use. */
function getPressureLut(): Float32Array {
  if (pressureLut) return pressureLut;
  const lut = new Float32Array(3 * LUT_SIZE);
  const tmp: RGB = [0, 0, 0];
  for (let i = 0; i < LUT_SIZE; i++) {
    const cp = CP_MIN + ((1 - CP_MIN) * i) / (LUT_SIZE - 1);
    pressureColor(cp, tmp);
    lut[3 * i] = srgbToLinear(tmp[0]);
    lut[3 * i + 1] = srgbToLinear(tmp[1]);
    lut[3 * i + 2] = srgbToLinear(tmp[2]);
  }
  pressureLut = lut;
  return lut;
}

/** Linear-RGB colour of the stalled / separated region (desaturated orange). */
export const STALL_TINT_LINEAR: Readonly<RGB> = [
  srgbToLinear(0.84),
  srgbToLinear(0.5),
  srgbToLinear(0.22),
];
/** Neutral light-grey metal used for parts without a pressure (slats). */
export const NEUTRAL_LINEAR: Readonly<RGB> = [
  srgbToLinear(0.78),
  srgbToLinear(0.8),
  srgbToLinear(0.84),
];

/** Fraction of the stall tint blended into the pressure colour where flow is separated. */
const STALL_BLEND = 0.72;

/** Strips of one surface in root-to-tip order with their normalised span positions. */
export interface StripBinding {
  strips: StripResult[];
  /** Spanwise position (0..1, same parameterisation as `LoftedWing.u`) of each strip centre. */
  u: Float64Array;
}

/**
 * Group strips by surface and place them on the loft's spanwise parameter.
 * The position of a strip is the cumulative width of the strips inboard of it plus half its own
 * width, normalised by the surface total, so it does not depend on how `eta` is defined.
 * Returns one entry per loft surface (null where the surface has no strips).
 */
export function bindStrips(
  lofted: LoftedWing,
  strips: readonly StripResult[] | null,
): Array<StripBinding | null> {
  const out: Array<StripBinding | null> = lofted.surfaces.map(() => null);
  if (!strips || strips.length === 0) return out;
  const byId = new Map<string, StripResult[]>();
  for (const s of strips) {
    let list = byId.get(s.surfaceId);
    if (!list) byId.set(s.surfaceId, (list = []));
    list.push(s);
  }
  lofted.surfaces.forEach((surf, i) => {
    const list = byId.get(surf.id);
    if (!list || list.length === 0) return;
    // Root-to-tip order. |eta| keeps this right even if a side reports mirrored (negative) etas.
    const sorted = [...list].sort((a, b) => Math.abs(a.eta) - Math.abs(b.eta));
    let total = 0;
    for (const s of sorted) total += Math.max(0, s.width);
    const u = new Float64Array(sorted.length);
    if (total > 0) {
      let cum = 0;
      for (let k = 0; k < sorted.length; k++) {
        const w = Math.max(0, sorted[k]!.width);
        u[k] = (cum + 0.5 * w) / total;
        cum += w;
      }
    } else {
      for (let k = 0; k < sorted.length; k++) u[k] = (k + 0.5) / sorted.length;
    }
    out[i] = { strips: sorted, u };
  });
  return out;
}

/** Linear interpolation of a chordwise Cp array at chord station x. */
export function sampleChordwise(cp: ChordwiseCp, x: number, upper: boolean): number {
  const xs = cp.xc;
  const ys = upper ? cp.upper : cp.lower;
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return 0;
  if (n === 1 || x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]!) / (xs[hi]! - xs[lo]! || 1);
  return ys[lo]! + (ys[hi]! - ys[lo]!) * f;
}

/** Write the linear colour for pressure coefficient `cp` into `colors[offset..offset+2]`. */
export function writePressureColor(cp: number, colors: Float32Array, offset: number): void {
  const lut = getPressureLut();
  const t = clamp(Number.isFinite(cp) ? cp : 0, CP_MIN, 1);
  const f = ((t - CP_MIN) / (1 - CP_MIN)) * (LUT_SIZE - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(LUT_SIZE - 1, i0 + 1);
  const w = f - i0;
  for (let k = 0; k < 3; k++) {
    colors[offset + k] = lut[3 * i0 + k]! * (1 - w) + lut[3 * i1 + k]! * w;
  }
}

/** Attached-fraction below which the surface is considered (partly) separated. */
const SEPARATION_ONSET = 0.985;

/**
 * Colour every vertex. `colors` and `stall` are caller-owned (length 3n and n); `stall` receives
 * the separated-region amount 0..1 (also used by the hatch shader). Allocation free.
 * With `bindings === null` (or a surface without strips) the neutral zero-pressure colour is used.
 */
export function colorizeWing(
  lofted: LoftedWing,
  bindings: ReadonlyArray<StripBinding | null> | null,
  colors: Float32Array,
  stall: Float32Array,
): void {
  const n = lofted.vertexCount;
  let lastSurface = -1;
  let lastU = -1;
  let k0 = 0;
  let k1 = 0;
  let w = 0;
  for (let v = 0; v < n; v++) {
    const o = 3 * v;
    if (lofted.kind[v] === VERTEX_SLAT) {
      colors[o] = NEUTRAL_LINEAR[0];
      colors[o + 1] = NEUTRAL_LINEAR[1];
      colors[o + 2] = NEUTRAL_LINEAR[2];
      stall[v] = 0;
      continue;
    }
    const surface = lofted.surfaceIndex[v]!;
    const binding = bindings ? bindings[surface] : null;
    if (!binding) {
      writePressureColor(0, colors, o);
      stall[v] = 0;
      continue;
    }
    const u = lofted.u[v]!;
    if (surface !== lastSurface || u !== lastU) {
      lastSurface = surface;
      lastU = u;
      const bu = binding.u;
      const m = bu.length;
      if (m === 1 || u <= bu[0]!) {
        k0 = k1 = 0;
        w = 0;
      } else if (u >= bu[m - 1]!) {
        k0 = k1 = m - 1;
        w = 0;
      } else {
        let lo = 0;
        let hi = m - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (bu[mid]! <= u) lo = mid;
          else hi = mid;
        }
        k0 = lo;
        k1 = hi;
        w = (u - bu[lo]!) / (bu[hi]! - bu[lo]! || 1);
      }
    }
    const x = lofted.xc[v]!;
    const up = lofted.upper[v] === 1;
    const s0 = binding.strips[k0]!;
    const s1 = binding.strips[k1]!;
    const cp0 = sampleChordwise(s0.cp, x, up);
    const cp = k0 === k1 ? cp0 : cp0 + (sampleChordwise(s1.cp, x, up) - cp0) * w;
    writePressureColor(cp, colors, o);

    // Separated region: upper surface aft of the separation point.
    let amount = 0;
    if (up) {
      const af0 = s0.stalled ? Math.min(s0.attachedFraction, 0.9) : s0.attachedFraction;
      const af1 = s1.stalled ? Math.min(s1.attachedFraction, 0.9) : s1.attachedFraction;
      const af = k0 === k1 ? af0 : af0 + (af1 - af0) * w;
      const sep = clamp((SEPARATION_ONSET - af) / 0.03, 0, 1);
      if (sep > 0) amount = sep * smoothstep(af - 0.02, af + 0.05, x);
    }
    stall[v] = amount;
    if (amount > 0) {
      const m = STALL_BLEND * amount;
      colors[o] = colors[o]! * (1 - m) + STALL_TINT_LINEAR[0] * m;
      colors[o + 1] = colors[o + 1]! * (1 - m) + STALL_TINT_LINEAR[1] * m;
      colors[o + 2] = colors[o + 2]! * (1 - m) + STALL_TINT_LINEAR[2] * m;
    }
  }
}
