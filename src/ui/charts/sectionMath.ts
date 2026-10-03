/**
 * Pure geometry and sampling helpers for the 2D cross-section view (SectionView).
 *
 * FRAMES. A SectionFlow is expressed in the AIRFOIL frame (chord along +x, y up) with the
 * freestream arriving at angle alphaEffective: V_inf direction = (cos a, sin a). For display we
 * rotate everything by -a so the air flows horizontally left -> right and the airfoil appears
 * pitched nose-up:   X =  x cos a + y sin a,   Y = -x sin a + y cos a.
 * "Display frame" below means (X, Y) after that rotation, in chord lengths, Y up.
 */
import { cpFromSpeed, speedColor, type RGB } from '../../shared/colormaps';
import type { ChordwiseCp, SectionFlow } from '../../physics/types';
import { interpolateAt } from './chartMath';

/* ------------------------------------------------------------------------------------------ */
/* Rotation and view transform                                                                  */
/* ------------------------------------------------------------------------------------------ */

export const displayX = (c: number, s: number, x: number, y: number): number => x * c + y * s;
export const displayY = (c: number, s: number, x: number, y: number): number => -x * s + y * c;
export const airfoilX = (c: number, s: number, X: number, Y: number): number => X * c - Y * s;
export const airfoilY = (c: number, s: number, X: number, Y: number): number => X * s + Y * c;

/** Maps display-frame world coordinates (chord lengths) to canvas CSS pixels. */
export class ViewTransform {
  constructor(
    readonly width: number,
    readonly height: number,
    /** Pixels per chord length. */
    readonly scale: number,
    readonly ox: number,
    readonly oy: number,
  ) {}

  x(X: number): number {
    return this.ox + X * this.scale;
  }

  y(Y: number): number {
    return this.oy - Y * this.scale;
  }

  worldX(px: number): number {
    return (px - this.ox) / this.scale;
  }

  worldY(py: number): number {
    return (this.oy - py) / this.scale;
  }
}

export interface FitOptions {
  /** Horizontal extent of the view in chords. */
  widthChords?: number;
  /** The view is never less tall than this (chords). */
  minHeightChords?: number;
  /** Display X (chords from the leading edge) placed at the centre of the canvas. */
  centerX?: number;
}

/** The compact card: the airfoil fills most of the width. */
export const CARD_VIEW: Required<FitOptions> = {
  widthChords: 1.5,
  minHeightChords: 0.95,
  centerX: 0.56,
};

/** The enlarged view: a little more air around the wing. */
export const LARGE_VIEW: Required<FitOptions> = {
  widthChords: 2.05,
  minHeightChords: 1.05,
  centerX: 0.6,
};

/** Fit the airfoil in a canvas of the given CSS size, keeping the same scale on both axes. */
export function fitView(
  width: number,
  height: number,
  alphaEff: number,
  options: FitOptions = {},
): ViewTransform {
  const widthChords = options.widthChords ?? CARD_VIEW.widthChords;
  const minHeight = options.minHeightChords ?? CARD_VIEW.minHeightChords;
  const centerX = options.centerX ?? CARD_VIEW.centerX;
  const scale = Math.max(1, Math.min(width / widthChords, height / minHeight));
  // Centre on the middle of the (pitched) chord line, nudged down a little so the lift arrow
  // and the suction above the wing get the extra room.
  const cy = -0.5 * Math.sin(alphaEff) + 0.06;
  return new ViewTransform(
    width,
    height,
    scale,
    width / 2 - centerX * scale,
    height / 2 + cy * scale,
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Pressure / speed background                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** |V| / V_inf at every grid node. */
export function speedGrid(section: SectionFlow): Float32Array {
  const { nx, ny, uv } = section.grid;
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < out.length; k++) out[k] = Math.hypot(uv[2 * k]!, uv[2 * k + 1]!);
  return out;
}

/** Opacity of the background tint: the calm freestream stays transparent over the dark panel. */
export function tintAlpha(deviation: number): number {
  return Math.min(0.92, 1 - Math.exp(-2.4 * Math.abs(deviation)));
}

/* Night-lab pressure tint. On the dark tunnel window a tint that fades to white near Cp = 0
 * reads as grey haze, so each sign gets one clear hue whose opacity (and brightness) grows with
 * the size of the pressure change: blue for suction (low pressure), red for high pressure. The
 * colour language matches the shared pressure map: blue low, red high. */
const SUCTION_DEEP: readonly [number, number, number] = [36, 92, 214];
const SUCTION_BRIGHT: readonly [number, number, number] = [104, 186, 255];
const PRESSURE_DEEP: readonly [number, number, number] = [176, 42, 52];
const PRESSURE_BRIGHT: readonly [number, number, number] = [255, 122, 92];
/** |Cp| at which the colour reaches its brightest. */
const SUCTION_FULL = 1.6;
const PRESSURE_FULL = 1;

/**
 * Colour and opacity (0..1) of the section's pressure tint for a pressure coefficient.
 * Writes 0..255 RGB into `out` and returns the opacity.
 */
export function sectionPressureTint(cp: number, out: RGB): number {
  if (!Number.isFinite(cp)) {
    out[0] = out[1] = out[2] = 0;
    return 0;
  }
  const suction = cp < 0;
  const mag = Math.abs(cp);
  const t = Math.min(1, mag / (suction ? SUCTION_FULL : PRESSURE_FULL));
  const lo = suction ? SUCTION_DEEP : PRESSURE_DEEP;
  const hi = suction ? SUCTION_BRIGHT : PRESSURE_BRIGHT;
  const f = Math.sqrt(t);
  out[0] = lo[0] + (hi[0] - lo[0]) * f;
  out[1] = lo[1] + (hi[1] - lo[1]) * f;
  out[2] = lo[2] + (hi[2] - lo[2]) * f;
  return suction ? 0.9 * (1 - Math.exp(-1.9 * mag)) : 0.88 * (1 - Math.exp(-2.6 * mag));
}

/**
 * Pressure inside the separated dead-air bubble: roughly the low "base" pressure that the upper
 * surface feels at the trailing edge, not 1 - |V|^2 (the air there is slow but NOT at high
 * pressure). Clamped to a plausible range.
 */
export function separatedBaseCp(section: SectionFlow): number {
  const upper = section.cp.upper;
  const te = upper.length ? upper[upper.length - 1]! : NaN;
  const value = Number.isFinite(te) ? te : -0.4;
  return Math.min(-0.25, Math.max(-1.2, value));
}

export interface WorldWindow {
  Xmin: number;
  Xmax: number;
  Ymin: number;
  Ymax: number;
}

export type FieldMode = 'pressure' | 'speed';

/** Width (chords) over which the tint fades out towards the edge of the solver grid. */
const GRID_FEATHER = 0.15;

/**
 * 1 well inside the grid, easing to 0 at its border, so the tint does not end in a visible
 * rectangle (the far field still carries a little pressure disturbance at the border).
 */
function gridFade(g: SectionFlow['grid'], x: number, y: number): number {
  const edge = Math.min(x - g.xMin, g.xMax - x, y - g.yMin, g.yMax - y);
  const t = Math.min(1, Math.max(0, edge / GRID_FEATHER));
  return t * t * (3 - 2 * t);
}

/**
 * Resample the section's velocity grid into a w x h RGBA image covering `win` in the display
 * frame. Inside-airfoil nodes are masked out of the interpolation; pixels with only masked
 * neighbours, and pixels outside the grid (which is freestream there), are handled so the
 * result has no gaps: the former are transparent, the latter are neutral (transparent).
 * Returns the number of pixels that carry a tint (for tests).
 */
export function fillFieldImage(
  section: SectionFlow,
  speed: Float32Array,
  win: WorldWindow,
  w: number,
  h: number,
  mode: FieldMode,
  out: Uint8ClampedArray,
): number {
  const g = section.grid;
  const a = section.alphaEffective;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const gx = (g.nx - 1) / (g.xMax - g.xMin);
  const gy = (g.ny - 1) / (g.yMax - g.yMin);
  const sep =
    mode === 'pressure' && section.separated?.length === g.nx * g.ny ? section.separated : null;
  const baseCp = sep ? separatedBaseCp(section) : 0;
  // Value carried by one grid node: Cp in pressure mode (dead air at its base pressure), speed
  // ratio in speed mode.
  const nodeValue = (k: number): number => {
    if (mode !== 'pressure') return speed[k]!;
    if (sep && sep[k]) return baseCp;
    return cpFromSpeed(speed[k]!);
  };
  const rgb: RGB = [0, 0, 0];
  let tinted = 0;
  for (let j = 0; j < h; j++) {
    const Y = win.Ymax - ((j + 0.5) / h) * (win.Ymax - win.Ymin);
    for (let i = 0; i < w; i++) {
      const X = win.Xmin + ((i + 0.5) / w) * (win.Xmax - win.Xmin);
      const x = airfoilX(c, s, X, Y);
      const y = airfoilY(c, s, X, Y);
      const fx = (x - g.xMin) * gx;
      const fy = (y - g.yMin) * gy;
      const o = 4 * (j * w + i);
      let v: number;
      if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) {
        // Beyond the grid the flow is the undisturbed freestream.
        v = mode === 'pressure' ? 0 : 1;
      } else {
        const i0 = Math.min(g.nx - 2, Math.floor(fx));
        const j0 = Math.min(g.ny - 2, Math.floor(fy));
        const tx = fx - i0;
        const ty = fy - j0;
        const k00 = i0 + g.nx * j0;
        const k10 = k00 + 1;
        const k01 = k00 + g.nx;
        const k11 = k01 + 1;
        const w00 = g.inside[k00] ? 0 : (1 - tx) * (1 - ty);
        const w10 = g.inside[k10] ? 0 : tx * (1 - ty);
        const w01 = g.inside[k01] ? 0 : (1 - tx) * ty;
        const w11 = g.inside[k11] ? 0 : tx * ty;
        const wSum = w00 + w10 + w01 + w11;
        if (wSum < 1e-6) {
          out[o + 3] = 0;
          continue;
        }
        v =
          (w00 * (w00 ? nodeValue(k00) : 0) +
            w10 * (w10 ? nodeValue(k10) : 0) +
            w01 * (w01 ? nodeValue(k01) : 0) +
            w11 * (w11 ? nodeValue(k11) : 0)) /
          wSum;
      }
      let alpha: number;
      if (mode === 'pressure') {
        alpha = sectionPressureTint(v, rgb);
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
      } else {
        speedColor(v, rgb);
        alpha = tintAlpha(v - 1);
        out[o] = rgb[0] * 255;
        out[o + 1] = rgb[1] * 255;
        out[o + 2] = rgb[2] * 255;
      }
      alpha *= gridFade(g, x, y);
      out[o + 3] = alpha * 255;
      if (alpha > 0.05) tinted++;
    }
  }
  return tinted;
}

/**
 * Where to label the separated dead-air bubble: the display-frame point at the top of the
 * bubble's rear half (from the solver's `separated` mask), or null when there is none.
 */
export function separatedLabelAnchor(section: SectionFlow): { X: number; Y: number } | null {
  const g = section.grid;
  const mask = section.separated;
  if (!mask || mask.length !== g.nx * g.ny) return null;
  const a = section.alphaEffective;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = (g.xMax - g.xMin) / (g.nx - 1);
  const dy = (g.yMax - g.yMin) / (g.ny - 1);
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      if (!mask[i + g.nx * j]) continue;
      const X = displayX(c, s, g.xMin + i * dx, g.yMin + j * dy);
      minX = Math.min(minX, X);
      maxX = Math.max(maxX, X);
      count++;
    }
  }
  if (count < 4) return null;
  // Highest point of the bubble over its middle stretch, so the label sits above it.
  const from = minX + 0.3 * (maxX - minX);
  const to = minX + 0.75 * (maxX - minX);
  let best: { X: number; Y: number } | null = null;
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      if (!mask[i + g.nx * j]) continue;
      const x = g.xMin + i * dx;
      const y = g.yMin + j * dy;
      const X = displayX(c, s, x, y);
      if (X < from || X > to) continue;
      const Y = displayY(c, s, x, y);
      if (!best || Y > best.Y) best = { X, Y };
    }
  }
  return best;
}

/* ------------------------------------------------------------------------------------------ */
/* Contour, surface profile, arrows                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Contour in display-frame coordinates (interleaved X, Y). */
export function contourToDisplay(contour: Float32Array, alpha: number): Float32Array {
  const c = Math.cos(alpha);
  const s = Math.sin(alpha);
  const out = new Float32Array(contour.length);
  for (let i = 0; i + 1 < contour.length; i += 2) {
    out[i] = displayX(c, s, contour[i]!, contour[i + 1]!);
    out[i + 1] = displayY(c, s, contour[i]!, contour[i + 1]!);
  }
  return out;
}

export interface SurfaceProfile {
  /** x ascending from the leading edge. */
  upperX: Float32Array;
  upperY: Float32Array;
  lowerX: Float32Array;
  lowerY: Float32Array;
}

/**
 * Split a contour (TE -> lower surface -> LE -> upper surface -> TE) into upper and lower
 * surfaces, each ordered from the leading edge to the trailing edge.
 */
export function surfaceProfile(contour: Float32Array): SurfaceProfile {
  const n = Math.floor(contour.length / 2);
  let le = 0;
  for (let i = 1; i < n; i++) if (contour[2 * i]! < contour[2 * le]!) le = i;
  const lowerCount = le + 1;
  const upperCount = n - le;
  const lowerX = new Float32Array(lowerCount);
  const lowerY = new Float32Array(lowerCount);
  for (let i = 0; i < lowerCount; i++) {
    // Contour runs TE -> LE along the lower surface, so reverse it.
    const src = le - i;
    lowerX[i] = contour[2 * src]!;
    lowerY[i] = contour[2 * src + 1]!;
  }
  const upperX = new Float32Array(upperCount);
  const upperY = new Float32Array(upperCount);
  for (let i = 0; i < upperCount; i++) {
    upperX[i] = contour[2 * (le + i)]!;
    upperY[i] = contour[2 * (le + i) + 1]!;
  }
  return { upperX, upperY, lowerX, lowerY };
}

/** Surface height at chord position x (clamped to the surface's extent). */
export function surfaceY(xs: Float32Array, ys: Float32Array, x: number): number {
  const v = interpolateAt(xs, ys, x);
  if (v !== null) return v;
  return x <= xs[0]! ? ys[0]! : ys[ys.length - 1]!;
}

export interface SurfaceArrow {
  side: 'upper' | 'lower';
  /** Point on the surface (airfoil frame). */
  x: number;
  y: number;
  /** Outward unit normal (airfoil frame). */
  nx: number;
  ny: number;
  cp: number;
  /** Arrow length in chords. */
  length: number;
}

/** Cp magnitude below which an arrow would be a speck and is skipped. */
const ARROW_MIN_CP = 0.08;
const ARROW_MAX_LENGTH = 0.34;

/** Arrow length in chords for a Cp value (linear, then capped). */
export function arrowLength(cp: number): number {
  return Math.min(ARROW_MAX_LENGTH, 0.2 * Math.abs(cp));
}

/**
 * Surface pressure arrows. Suction (Cp < 0) pulls outward, pressure (Cp > 0) pushes inward;
 * the caller draws the direction from the sign of `cp`.
 */
export function surfaceArrows(section: SectionFlow, perSide = 11): SurfaceArrow[] {
  const profile = surfaceProfile(section.contour);
  const { xc, upper, lower } = section.cp;
  const out: SurfaceArrow[] = [];
  for (const side of ['upper', 'lower'] as const) {
    const xs = side === 'upper' ? profile.upperX : profile.lowerX;
    const ys = side === 'upper' ? profile.upperY : profile.lowerY;
    const cps = side === 'upper' ? upper : lower;
    for (let k = 0; k < perSide; k++) {
      // Cosine spacing puts more arrows where Cp changes fastest, near the leading edge.
      const x = (1 - Math.cos((Math.PI * (k + 0.6)) / (perSide + 0.2))) / 2;
      if (x > 0.97) continue;
      const cp = interpolateAt(xc, cps, x);
      if (cp === null || Math.abs(cp) < ARROW_MIN_CP) continue;
      const y = surfaceY(xs, ys, x);
      const dx = 0.01;
      const slope =
        (surfaceY(xs, ys, Math.min(1, x + dx)) - surfaceY(xs, ys, Math.max(0, x - dx))) /
        (Math.min(1, x + dx) - Math.max(0, x - dx));
      const len = Math.hypot(1, slope);
      // Tangent runs LE -> TE; outward is "up" for the upper surface, "down" for the lower.
      const tx = 1 / len;
      const ty = slope / len;
      const sign = side === 'upper' ? 1 : -1;
      out.push({
        side,
        x,
        y,
        nx: -ty * sign,
        ny: tx * sign,
        cp,
        length: arrowLength(cp),
      });
    }
  }
  return out;
}

/** Chordwise centre of pressure (chord fraction) from the Cp loading; quarter chord if no lift. */
export function centerOfPressureX(cp: ChordwiseCp): number {
  let n = 0;
  let m = 0;
  for (let i = 1; i < cp.xc.length; i++) {
    const x0 = cp.xc[i - 1]!;
    const x1 = cp.xc[i]!;
    const l0 = cp.lower[i - 1]! - cp.upper[i - 1]!;
    const l1 = cp.lower[i]! - cp.upper[i]!;
    const dx = x1 - x0;
    n += ((l0 + l1) / 2) * dx;
    m += ((x0 * l0 + x1 * l1) / 2) * dx;
  }
  if (!(Math.abs(n) > 1e-3)) return 0.25;
  return Math.min(1, Math.max(0, m / n));
}

/* ------------------------------------------------------------------------------------------ */
/* Separated flow                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Below this attached fraction (or when stalled) the dead-air region is drawn. */
const SEPARATION_THRESHOLD = 0.98;

/**
 * Outline (display frame, interleaved X, Y) of the region of separated flow behind the
 * separation point on the upper surface, or null when the flow is attached.
 */
export function separationPolygon(section: SectionFlow): Float32Array | null {
  const attached = Math.min(1, Math.max(0, section.attachedFraction));
  if (!section.stalled && attached >= SEPARATION_THRESHOLD) return null;
  const xs = Math.max(0.04, Math.min(0.98, section.stalled ? Math.min(attached, 0.7) : attached));
  const a = section.alphaEffective;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const profile = surfaceProfile(section.contour);
  const steps = 14;
  const wakeLength = 0.5;
  const thickness = 0.04 + 0.22 * (1 - xs);

  // Base line: along the upper surface from the separation point to the trailing edge, then
  // out into the wake along the freestream direction (horizontal in the display frame).
  const base: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const x = xs + ((1 - xs) * k) / steps;
    const y = surfaceY(profile.upperX, profile.upperY, x);
    base.push(displayX(c, s, x, y), displayY(c, s, x, y));
  }
  const teX = base[base.length - 2]!;
  const teY = base[base.length - 1]!;
  base.push(teX + wakeLength / 2, teY, teX + wakeLength, teY);

  // Outline: the base line forwards, then the same line raised by a bulge, backwards.
  const n = base.length / 2;
  const x0 = base[0]!;
  const span = Math.max(1e-6, base[2 * (n - 1)]! - x0);
  const pts = base.slice();
  for (let k = n - 1; k >= 0; k--) {
    const X = base[2 * k]!;
    const u = Math.min(1, Math.max(0, (X - x0) / span));
    pts.push(X, base[2 * k + 1]! + thickness * Math.sin(Math.PI * Math.pow(u, 0.65)));
  }
  return Float32Array.from(pts);
}

/* ------------------------------------------------------------------------------------------ */
/* Streamlines: smoke puffs and the timing pulse                                                */
/* ------------------------------------------------------------------------------------------ */

export interface PreparedStreamline {
  /** Display-frame coordinates, interleaved. */
  disp: Float32Array;
  /** Cumulative travel time (chord / V_inf) at each point. */
  time: Float32Array;
  speed: Float32Array;
  /** Time at which the line reaches the common pulse start line (0 if it starts beyond it). */
  pulseStart: number;
  /** Total time to the end of the line. */
  total: number;
  /** Does the line pass above or below the trailing edge? null if it never gets there. */
  side: 'top' | 'bottom' | null;
  /** Time at which the line crosses the trailing-edge position, or NaN. */
  teTime: number;
  /** Display-frame height above (+) or below (-) the trailing edge where it passes it, or NaN. */
  teOffset: number;
}

export interface PreparedStreamlines {
  lines: PreparedStreamline[];
  /** Display X where the timing markers start (a vertical line). */
  pulseX: number;
  /** Display X of the trailing edge. */
  teX: number;
  /** Mean arrival time at the trailing edge minus the pulse start, over the top / bottom lines. */
  topArrival: number;
  bottomArrival: number;
}

/** First crossing of the polyline with the vertical line X = x0: time and Y, or null. */
export function crossingAtX(
  disp: Float32Array,
  time: Float32Array,
  x0: number,
): { t: number; y: number } | null {
  const n = Math.min(time.length, Math.floor(disp.length / 2));
  for (let i = 1; i < n; i++) {
    const xa = disp[2 * (i - 1)]!;
    const xb = disp[2 * i]!;
    if ((xa - x0) * (xb - x0) <= 0 && xa !== xb) {
      const f = (x0 - xa) / (xb - xa);
      return {
        t: time[i - 1]! + f * (time[i]! - time[i - 1]!),
        y: disp[2 * (i - 1) + 1]! + f * (disp[2 * i + 1]! - disp[2 * (i - 1) + 1]!),
      };
    }
  }
  return null;
}

export function prepareStreamlines(section: SectionFlow): PreparedStreamlines {
  const a = section.alphaEffective;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Trailing edge from the contour itself (it moves when a flap is deflected).
  const cn = section.contour.length;
  const teAx = cn >= 4 ? (section.contour[0]! + section.contour[cn - 2]!) / 2 : 1;
  const teAy = cn >= 4 ? (section.contour[1]! + section.contour[cn - 1]!) / 2 : 0;
  const teX = displayX(c, s, teAx, teAy);
  const teY = displayY(c, s, teAx, teAy);

  const lines: PreparedStreamline[] = section.streamlines.map((sl) => {
    const n = Math.min(sl.time.length, Math.floor(sl.points.length / 2));
    const disp = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      const x = sl.points[2 * i]!;
      const y = sl.points[2 * i + 1]!;
      disp[2 * i] = displayX(c, s, x, y);
      disp[2 * i + 1] = displayY(c, s, x, y);
    }
    const time = sl.time.subarray(0, n);
    return {
      disp,
      time,
      speed: sl.speed.subarray(0, n),
      pulseStart: 0,
      total: n ? time[n - 1]! : 0,
      side: null,
      teTime: NaN,
      teOffset: NaN,
    };
  });

  // The markers must start on one vertical line: use the right-most starting X.
  let pulseX = -Infinity;
  for (const l of lines) if (l.disp.length) pulseX = Math.max(pulseX, l.disp[0]!);
  if (!Number.isFinite(pulseX)) pulseX = -0.5;
  pulseX += 0.005;

  let topSum = 0;
  let topN = 0;
  let botSum = 0;
  let botN = 0;
  for (const l of lines) {
    const start = crossingAtX(l.disp, l.time, pulseX);
    l.pulseStart = start ? start.t : 0;
    const te = crossingAtX(l.disp, l.time, teX);
    if (te) {
      l.teTime = te.t;
      l.teOffset = te.y - teY;
      l.side = te.y > teY ? 'top' : 'bottom';
      // Only streamlines that hug the airfoil say anything about "top vs bottom".
      if (Math.abs(te.y - teY) < 0.3) {
        const dt = te.t - l.pulseStart;
        if (l.side === 'top') {
          topSum += dt;
          topN++;
        } else {
          botSum += dt;
          botN++;
        }
      }
    }
  }
  return {
    lines,
    pulseX,
    teX,
    topArrival: topN ? topSum / topN : NaN,
    bottomArrival: botN ? botSum / botN : NaN,
  };
}

/**
 * Index i such that time[i] <= t < time[i + 1] by binary search, or -1 when t is outside the
 * line (before its start or at/after its end).
 */
export function findSegment(time: Float32Array, t: number): number {
  const n = time.length;
  if (n < 2 || t < time[0]! || t >= time[n - 1]!) return -1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Position along a prepared streamline at travel time t, written to `out[0..1]`.
 * Returns false if the line has no point at that time.
 */
export function positionAtTime(line: PreparedStreamline, t: number, out: Float32Array): boolean {
  const i = findSegment(line.time, t);
  if (i < 0) return false;
  const t0 = line.time[i]!;
  const t1 = line.time[i + 1]!;
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  out[0] = line.disp[2 * i]! + f * (line.disp[2 * i + 2]! - line.disp[2 * i]!);
  out[1] = line.disp[2 * i + 1]! + f * (line.disp[2 * i + 3]! - line.disp[2 * i + 1]!);
  return true;
}
