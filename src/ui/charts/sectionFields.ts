/**
 * Pure field helpers for the "make pressure intuitive" layers of the 2D cross-section view:
 *  - point sampling of the section's velocity grid (the probe),
 *  - the pressure TERRAIN (pressure as height: hillshaded relief plus contour lines),
 *  - the DISTURBANCE field (flow minus the freestream: what the wing does to still air).
 *
 * All positions are in the DISPLAY frame of sectionMath.ts (chords; the air flows along +X,
 * Y up, origin at the leading edge). The solver grid lives in the airfoil frame; we rotate.
 */
import { cpFromSpeed } from '../../shared/colormaps';
import type { SectionFlow } from '../../physics/types';
import {
  pressureAtSpeed,
  pressureFromCp,
  prandtlGlauertFactor,
  type PointPressure,
} from '../../physics/everyday';
import {
  airfoilX,
  airfoilY,
  displayX,
  displayY,
  separatedBaseCp,
  softMask,
  type WorldWindow,
} from './sectionMath';

/* ------------------------------------------------------------------------------------------ */
/* Point sampling                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface SectionSample {
  /** True inside the airfoil (no air there). */
  inside: boolean;
  /** True outside the solver grid: the flow there is taken as the undisturbed freestream. */
  outside: boolean;
  /** Velocity / V∞ in the DISPLAY frame (the freestream is (1, 0)). */
  U: number;
  V: number;
  /** Incompressible pressure coefficient (dead-air base pressure inside a stall bubble). */
  cp: number;
  /** 0..1: how much the point is inside the separated (stalled) region. */
  separated: number;
}

/** Point-in-polygon (even-odd) for an interleaved x,y contour. */
export function insideContour(contour: Float32Array, x: number, y: number): boolean {
  const n = Math.floor(contour.length / 2);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = contour[2 * i]!;
    const yi = contour[2 * i + 1]!;
    const xj = contour[2 * j]!;
    const yj = contour[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const sepCache = new WeakMap<SectionFlow, Float32Array | null>();

/** Softened separated-flow mask of a section (memoised), or null when there is none. */
export function separatedWeights(section: SectionFlow): Float32Array | null {
  if (sepCache.has(section)) return sepCache.get(section)!;
  const g = section.grid;
  const m =
    section.separated?.length === g.nx * g.ny ? softMask(section.separated, g.nx, g.ny) : null;
  sepCache.set(section, m);
  return m;
}

/**
 * The flow at a display-frame point, bilinearly interpolated from the solver grid with the
 * nodes inside the airfoil left out (as the colour field does).
 */
export function sampleSection(section: SectionFlow, X: number, Y: number): SectionSample {
  const a = section.alphaEffective;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = airfoilX(c, s, X, Y);
  const y = airfoilY(c, s, X, Y);
  const g = section.grid;
  const result: SectionSample = {
    inside: false,
    outside: false,
    U: 1,
    V: 0,
    cp: 0,
    separated: 0,
  };
  if (insideContour(section.contour, x, y)) {
    result.inside = true;
    result.U = result.V = result.cp = NaN;
    return result;
  }
  const fx = ((x - g.xMin) * (g.nx - 1)) / (g.xMax - g.xMin);
  const fy = ((y - g.yMin) * (g.ny - 1)) / (g.yMax - g.yMin);
  if (!(fx >= 0 && fy >= 0 && fx <= g.nx - 1 && fy <= g.ny - 1)) {
    result.outside = true;
    return result;
  }
  const i0 = Math.min(g.nx - 2, Math.floor(fx));
  const j0 = Math.min(g.ny - 2, Math.floor(fy));
  const tx = fx - i0;
  const ty = fy - j0;
  const ks = [i0 + g.nx * j0, i0 + 1 + g.nx * j0, i0 + g.nx * (j0 + 1), i0 + 1 + g.nx * (j0 + 1)];
  const ws = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  const sep = separatedWeights(section);
  let wSum = 0;
  let u = 0;
  let v = 0;
  let m = 0;
  for (let q = 0; q < 4; q++) {
    const k = ks[q]!;
    if (g.inside[k]) continue;
    const w = ws[q]!;
    wSum += w;
    u += w * g.uv[2 * k]!;
    v += w * g.uv[2 * k + 1]!;
    if (sep) m += w * sep[k]!;
  }
  if (wSum < 1e-9) {
    // Only masked nodes around a point that is outside the contour: hugging the skin.
    result.U = result.V = 0;
    result.cp = 1;
    return result;
  }
  u /= wSum;
  v /= wSum;
  m /= wSum;
  result.U = u * c + v * s;
  result.V = -u * s + v * c;
  const cp = cpFromSpeed(Math.hypot(u, v));
  result.separated = m;
  result.cp = m > 0 ? cp + (separatedBaseCp(section) - cp) * m : cp;
  return result;
}

/* ------------------------------------------------------------------------------------------ */
/* The probe                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Freestream data the probe needs to turn ratios into real numbers. */
export interface ProbeFreestream {
  /** m/s */
  vInf: number;
  mach: number;
  /** Static pressure of the surrounding air (Pa). */
  pInf: number;
  /** Dynamic pressure (Pa). */
  q: number;
}

export interface ProbeReading {
  inside: boolean;
  /** |V| / V∞ (compressibility-corrected). */
  speedRatio: number;
  /** Flow direction relative to the wind (rad), positive = upward. NaN when nearly still. */
  angle: number;
  pressure: PointPressure;
  /** In the dead air of a stall: the pressure is the separated base pressure. */
  separated: boolean;
}

/**
 * What a probe at a display-frame point reads. The drawn 2D field is the incompressible
 * equivalent flow; at speed the velocity disturbance is scaled by Prandtl–Glauert's 1/β (as the
 * solver does for pressures) and the pressure follows from the isentropic relation. In separated
 * air the pressure is the dead-air base pressure instead.
 */
export function probeSection(
  section: SectionFlow,
  X: number,
  Y: number,
  free: ProbeFreestream,
): ProbeReading {
  const sample = sampleSection(section, X, Y);
  if (sample.inside) {
    return {
      inside: true,
      speedRatio: NaN,
      angle: NaN,
      pressure: { pressure: NaN, delta: NaN, fraction: NaN },
      separated: false,
    };
  }
  const pg = prandtlGlauertFactor(free.mach);
  const U = 1 + (sample.U - 1) * pg;
  const V = sample.V * pg;
  const speedRatio = Math.hypot(U, V);
  const separated = sample.separated > 0.5;
  const pressure = separated
    ? pressureFromCp(sample.cp * pg, free.q, free.pInf)
    : pressureAtSpeed(speedRatio, free.mach, free.pInf);
  return {
    inside: false,
    speedRatio,
    angle: speedRatio > 0.03 ? Math.atan2(V, U) : NaN,
    pressure,
    separated,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Pressure terrain                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * Cp sampled on a w x h raster covering `win` (row 0 at the top, Ymax). NaN inside the airfoil.
 * Outside the solver grid the freestream (0) is used. `fade` (if given) receives how far each
 * cell is from the grid border: 1 well inside, easing to 0 at the border, so the caller can blend
 * the picture into the flat plain without a step. Without it, Cp itself is eased to 0.
 */
export function sampleCpRaster(
  section: SectionFlow,
  win: WorldWindow,
  w: number,
  h: number,
  out: Float32Array = new Float32Array(w * h),
  fade?: Float32Array,
): Float32Array {
  const g = section.grid;
  const a = section.alphaEffective;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const feather = 0.15;
  for (let j = 0; j < h; j++) {
    const Y = win.Ymax - ((j + 0.5) / h) * (win.Ymax - win.Ymin);
    for (let i = 0; i < w; i++) {
      const X = win.Xmin + ((i + 0.5) / w) * (win.Xmax - win.Xmin);
      const sample = sampleSection(section, X, Y);
      let v = sample.cp;
      let f = sample.outside ? 0 : 1;
      if (!sample.inside && !sample.outside) {
        const x = airfoilX(c, s, X, Y);
        const y = airfoilY(c, s, X, Y);
        const edge = Math.min(x - g.xMin, g.xMax - x, y - g.yMin, g.yMax - y);
        const t = Math.min(1, Math.max(0, edge / feather));
        f = t * t * (3 - 2 * t);
        if (!fade) v *= f;
      }
      out[j * w + i] = v;
      if (fade) fade[j * w + i] = f;
    }
  }
  return out;
}

/**
 * Terrain height for a pressure coefficient: high pressure is a hill, low pressure a valley.
 * Compressed for large suction so the deep, narrow suction peak at the nose does not dwarf the
 * gentle valley over the rest of the wing.
 */
export function terrainHeight(cp: number): number {
  if (!Number.isFinite(cp)) return NaN;
  return cp >= 0 ? cp : -Math.log1p(-1.4 * cp) / 1.4;
}

/**
 * Contour levels drawn on the terrain, in terrain HEIGHT units (see terrainHeight): evenly spaced,
 * so lines crowd together where the pressure changes fast, like the contours of a steep slope.
 * Level 0 is normal (freestream) pressure: "sea level".
 */
export const TERRAIN_STEP = 0.1;
export const TERRAIN_LEVELS: readonly number[] = (() => {
  const out: number[] = [];
  for (let k = -14; k <= 10; k++) out.push(Math.round(k * TERRAIN_STEP * 100) / 100);
  return out;
})();

/**
 * Terrain height of each raster cell (NaN stays NaN), for contouring. With a `fade` raster (see
 * sampleCpRaster), cells at the very rim of the solver grid become NaN, so contour lines stop
 * there instead of tracing the grid border.
 */
export function terrainHeights(
  cp: Float32Array,
  fade?: Float32Array,
  out = new Float32Array(cp.length),
): Float32Array {
  for (let k = 0; k < cp.length; k++) {
    const f = fade ? fade[k]! : 1;
    out[k] = f < 0.05 ? NaN : terrainHeight(cp[k]!) * f;
  }
  return out;
}

/* Terrain palette: a dark slate "plain" at normal pressure, blue valleys, warm hills. Same colour
 * language as the rest of the app (blue low, red high), but opaque so the shading reads. */
const PLAIN: readonly [number, number, number] = [46, 58, 78];
const VALLEY_DEEP: readonly [number, number, number] = [30, 86, 196];
const VALLEY_FLOOR: readonly [number, number, number] = [116, 192, 255];
const HILL_LOW: readonly [number, number, number] = [150, 72, 64];
const HILL_TOP: readonly [number, number, number] = [255, 146, 100];

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
  out: [number, number, number],
): void {
  const k = Math.min(1, Math.max(0, t));
  for (let i = 0; i < 3; i++) out[i] = a[i]! + (b[i]! - a[i]!) * k;
}

/** Base colour of the terrain at a pressure coefficient (0..255 RGB into out). */
export function terrainColor(cp: number, out: [number, number, number]): void {
  if (!Number.isFinite(cp)) {
    out[0] = PLAIN[0];
    out[1] = PLAIN[1];
    out[2] = PLAIN[2];
  } else if (cp < 0) {
    const t = Math.min(1, -cp / 1.4);
    if (t < 0.45) mix3(PLAIN, VALLEY_DEEP, t / 0.45, out);
    else mix3(VALLEY_DEEP, VALLEY_FLOOR, (t - 0.45) / 0.55, out);
  } else {
    const t = Math.min(1, cp);
    if (t < 0.4) mix3(PLAIN, HILL_LOW, t / 0.4, out);
    else mix3(HILL_LOW, HILL_TOP, (t - 0.4) / 0.6, out);
  }
}

/**
 * Hillshaded relief image of a Cp raster into RGBA `out` (w x h). Light comes from the upper
 * left; `relief` scales the slopes (pixels of height per unit terrain height). Pixels inside the
 * airfoil are transparent. Returns the shade factor range seen (for tests).
 */
export function fillTerrainImage(
  cp: Float32Array,
  w: number,
  h: number,
  relief: number,
  out: Uint8ClampedArray,
  fade?: Float32Array,
): { min: number; max: number } {
  // Light direction (towards the light), normalised: from the upper left, fairly low.
  const lx = -0.6;
  const ly = -0.6;
  const lz = 0.53;
  const ln = Math.hypot(lx, ly, lz);
  const rgb: [number, number, number] = [0, 0, 0];
  let min = Infinity;
  let max = -Infinity;
  const height = (i: number, j: number, fallback: number): number => {
    const ii = Math.min(w - 1, Math.max(0, i));
    const jj = Math.min(h - 1, Math.max(0, j));
    const v = terrainHeight(cp[jj * w + ii]!);
    return Number.isFinite(v) ? v : fallback;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = 4 * (j * w + i);
      const v = cp[j * w + i]!;
      if (!Number.isFinite(v)) {
        out[o + 3] = 0;
        continue;
      }
      const f = fade ? fade[j * w + i]! : 1;
      const hc = terrainHeight(v);
      // Screen rows run downward, so +j is "south".
      const dzdx = ((height(i + 1, j, hc) - height(i - 1, j, hc)) / 2) * relief;
      const dzdy = ((height(i, j + 1, hc) - height(i, j - 1, hc)) / 2) * relief;
      // Surface normal (-dz/dx, -dz/dy, 1).
      const nn = Math.hypot(dzdx, dzdy, 1);
      const lambert = (-dzdx * lx - dzdy * ly + lz) / (nn * ln);
      // Flat ground keeps its base colour (shade 1); slopes facing the light brighten.
      const lit = Math.max(0.2, Math.min(1.9, 0.25 + 0.75 * (lambert / (lz / ln))));
      // Slopes come from the true heights; towards the grid rim the relief fades into the plain.
      const shade = 1 + (lit - 1) * f;
      min = Math.min(min, shade);
      max = Math.max(max, shade);
      terrainColor(v * f, rgb);
      out[o] = rgb[0] * shade;
      out[o + 1] = rgb[1] * shade;
      out[o + 2] = rgb[2] * shade;
      out[o + 3] = 255;
    }
  }
  return { min, max };
}

/**
 * Contour line segments (marching squares) of a raster at the given level, in raster cell
 * coordinates (pixel centres at i + 0.5, j + 0.5). Cells touching NaN are skipped. Returns
 * interleaved x0, y0, x1, y1 per segment.
 */
export function contourSegments(
  field: Float32Array,
  w: number,
  h: number,
  level: number,
): Float32Array {
  const segs: number[] = [];
  const lerp = (a: number, b: number): number => (level - a) / (b - a);
  for (let j = 0; j + 1 < h; j++) {
    for (let i = 0; i + 1 < w; i++) {
      const a = field[j * w + i]!; // top-left
      const b = field[j * w + i + 1]!; // top-right
      const c = field[(j + 1) * w + i + 1]!; // bottom-right
      const d = field[(j + 1) * w + i]!; // bottom-left
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)))
        continue;
      const code =
        (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const x = i + 0.5;
      const y = j + 0.5;
      // Edge crossing points.
      const top = (): [number, number] => [x + lerp(a, b), y];
      const right = (): [number, number] => [x + 1, y + lerp(b, c)];
      const bottom = (): [number, number] => [x + lerp(d, c), y + 1];
      const left = (): [number, number] => [x, y + lerp(a, d)];
      const push = (p: [number, number], q: [number, number]): void => {
        segs.push(p[0], p[1], q[0], q[1]);
      };
      switch (code) {
        case 1:
        case 14:
          push(left(), bottom());
          break;
        case 2:
        case 13:
          push(bottom(), right());
          break;
        case 3:
        case 12:
          push(left(), right());
          break;
        case 4:
        case 11:
          push(top(), right());
          break;
        case 6:
        case 9:
          push(top(), bottom());
          break;
        case 7:
        case 8:
          push(left(), top());
          break;
        case 5:
          push(left(), top());
          push(bottom(), right());
          break;
        case 10:
          push(top(), right());
          push(left(), bottom());
          break;
      }
    }
  }
  return Float32Array.from(segs);
}

/* ------------------------------------------------------------------------------------------ */
/* Disturbance ("the air's view")                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface DisturbanceArrow {
  /** Arrow tail position, display frame (chords). */
  X: number;
  Y: number;
  /** Disturbance velocity / V∞ (display frame): the flow minus the freestream. */
  dU: number;
  dV: number;
}

/**
 * The disturbance velocity (flow minus freestream, / V∞, display frame) on a regular lattice of
 * display-frame points `spacing` chords apart covering `win`. Beyond the solver grid the
 * far-field vortex is used (see farFieldDisturbance). Points inside the airfoil, in the separated
 * dead air, and where the disturbance is below `minMagnitude` are left out.
 */
export function disturbanceArrows(
  section: SectionFlow,
  win: WorldWindow,
  spacing: number,
  minMagnitude = 0.004,
): DisturbanceArrow[] {
  const out: DisturbanceArrow[] = [];
  if (!(spacing > 0)) return out;
  const x0 = Math.ceil(win.Xmin / spacing) * spacing;
  const y0 = Math.ceil(win.Ymin / spacing) * spacing;
  // Offset every other row by half a step: a staggered lattice reads less like a grid.
  for (let r = 0, Y = y0; Y <= win.Ymax; r++, Y = y0 + r * spacing) {
    const shift = r % 2 ? spacing / 2 : 0;
    for (let X = x0 + shift; X <= win.Xmax; X += spacing) {
      const s = sampleSection(section, X, Y);
      if (s.inside || s.separated > 0.5) continue;
      let dU = s.U - 1;
      let dV = s.V;
      if (s.outside) [dU, dV] = farFieldDisturbance(section, X, Y);
      if (Math.hypot(dU, dV) < minMagnitude) continue;
      out.push({ X, Y, dU, dV });
    }
  }
  return out;
}

/**
 * Far from the wing (beyond the solver grid) its disturbance is that of a single vortex at the
 * quarter chord carrying the section's circulation, Γ / (V∞ c) = −cl / 2 (clockwise for positive
 * lift). Returns the display-frame (dU, dV) / V∞.
 */
export function farFieldDisturbance(section: SectionFlow, X: number, Y: number): [number, number] {
  const a = section.alphaEffective;
  const X0 = displayX(Math.cos(a), Math.sin(a), 0.25, 0);
  const Y0 = displayY(Math.cos(a), Math.sin(a), 0.25, 0);
  const gamma = -(section.fieldCl ?? section.cl) / 2;
  const dx = X - X0;
  const dy = Y - Y0;
  const r2 = Math.max(0.01, dx * dx + dy * dy);
  const k = gamma / (2 * Math.PI * r2);
  return [-k * dy, k * dx];
}

/**
 * Display gain for the disturbance arrows: chords of arrow per unit of (disturbance / V∞),
 * chosen so the 75th-percentile arrow is `targetLength` chords long, rounded down to a "nice"
 * value (1, 2, 2.5, 5 x 10^n) so the key can say it plainly.
 */
export function disturbanceGain(arrows: DisturbanceArrow[], targetLength: number): number {
  if (arrows.length === 0) return 1;
  const mags = arrows.map((a) => Math.hypot(a.dU, a.dV)).sort((p, q) => p - q);
  const p75 = mags[Math.min(mags.length - 1, Math.floor(0.75 * mags.length))]!;
  return niceFloor(targetLength / Math.max(1e-6, p75));
}

/** Largest 1, 2, 2.5 or 5 x 10^n not above x (x > 0). */
export function niceFloor(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  const nice = m >= 5 ? 5 : m >= 2.5 ? 2.5 : m >= 2 ? 2 : 1;
  return nice * e;
}

/**
 * The net circulation of the disturbance around a display-frame rectangle (anticlockwise line
 * integral of the flow, / (V∞ c)). Positive lift goes with clockwise flow round the wing (air
 * forward underneath, back over the top), i.e. a NEGATIVE value here; |value| ≈ cl / 2 by
 * Kutta–Joukowski. Used by tests and lessons to confirm "the air circulates round the wing".
 */
export function circulationAround(section: SectionFlow, box: WorldWindow, steps = 200): number {
  let sum = 0;
  const leg = (xa: number, ya: number, xb: number, yb: number): void => {
    const dx = (xb - xa) / steps;
    const dy = (yb - ya) / steps;
    for (let k = 0; k < steps; k++) {
      const s = sampleSection(section, xa + (k + 0.5) * dx, ya + (k + 0.5) * dy);
      if (s.inside) continue;
      sum += s.U * dx + s.V * dy;
    }
  };
  const { Xmin, Xmax, Ymin, Ymax } = box;
  leg(Xmin, Ymin, Xmax, Ymin);
  leg(Xmax, Ymin, Xmax, Ymax);
  leg(Xmax, Ymax, Xmin, Ymax);
  leg(Xmin, Ymax, Xmin, Ymin);
  return sum;
}
