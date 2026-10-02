/**
 * Viscous section polar: panel-method lift slope + empirical stall/post-stall and drag models.
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 *
 * Shape of the lift curve (x = alpha - alphaZeroLift):
 *
 *   linear      cl = a x                                   until the rounding starts
 *   rounding    cl = clMax - a/(2 dr) (xs - x)^2            parabola that peaks at xs with slope 0
 *   post-stall  cl = (1 - w) * remnant(x) + w * 2 sin(alpha) cos(alpha)
 *                 remnant drops by `drop` with a Gaussian-shaped onset (zero slope at xs);
 *                 w is a smootherstep from xs to xs + blendWidth, so the curve joins the
 *                 flat-plate curve with matching slope.
 *
 * The negative side mirrors this with clMin. Every join is C1, which keeps the nonlinear wing
 * coupling well behaved. All numbers are empirical fits to NACA 4-digit data (Abbott & von
 * Doenhoff) and simple flap/slat rules of thumb; they are teaching-grade, not design-grade.
 */
import type { FlapState, Naca4Params, SectionPolar } from '../types';
import type { PanelSolver } from './panel';
import { camberLine } from './naca';

export interface SectionPolarOptions {
  flap: FlapState | null;
  /** Leading-edge slat deployed: delays stall (roughly +6..10 deg, +0.6..1.0 clMax). */
  slat: boolean;
  /** Supercritical section (affects only compressibility estimates elsewhere; kept for keying). */
  supercritical: boolean;
}

/** The polar plus the internals other airfoil-module code (Cp, section flow) needs. */
export interface ViscousSectionPolar extends SectionPolar {
  /** Inviscid (panel) lift slope at zero lift (per rad). */
  readonly inviscidLiftSlope: number;
  /** Inviscid (panel) zero-lift angle, flap geometry included (rad). */
  readonly inviscidAlphaZeroLift: number;
  /** Lift coefficient of minimum drag (thin-airfoil ideal cl of the clean camber line). */
  readonly designCl: number;
  /** Lift increment of the flap at fixed alpha after viscous losses (0 without a flap). */
  readonly flapDeltaCl: number;
  /** Most negative cl before negative stall. */
  clMin(reynolds: number): number;
  /** Angle of the negative-stall minimum (rad). */
  alphaStallNegative(reynolds: number): number;
  /** Attached-flow lift without stall: liftSlope * (alpha - alphaZeroLift). */
  clLinear(alpha: number): number;
  /** True beyond the positive or negative stall angle. */
  isStalled(alpha: number, reynolds: number): boolean;
}

const DEG = Math.PI / 180;
/** Boundary-layer decambering: viscous lift slope / inviscid lift slope. */
export const VISCOUS_SLOPE_FACTOR = 0.92;

/** Symmetric-section clMax at Re = 6e6 vs thickness (NACA 00xx, Abbott & von Doenhoff). */
const CLMAX_TABLE: readonly [number, number][] = [
  [0.03, 0.7],
  [0.06, 0.85],
  [0.08, 1.05],
  [0.1, 1.35],
  [0.12, 1.55],
  [0.15, 1.56],
  [0.18, 1.45],
  [0.21, 1.35],
  [0.25, 1.22],
];

function interpTable(table: readonly [number, number][], x: number): number {
  const first = table[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!;
    if (x <= x1) {
      const [x0, y0] = table[i - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1]![1];
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smootherstep on [0, 1] (zero first and second derivative at both ends). */
function smoother(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Thin-airfoil-theory integrals of a camber line (with optional flap):
 * zero-lift angle alpha0 = -(1/pi) int (dz/dx)(cos th - 1) dth and ideal cl = pi * A1.
 */
export function thinAirfoilTheory(
  params: Naca4Params,
  flap: FlapState | null,
  samples = 240,
): { alphaZeroLift: number; idealCl: number } {
  let a0 = 0;
  let a1 = 0;
  const dth = Math.PI / samples;
  for (let i = 0; i < samples; i++) {
    const th = (i + 0.5) * dth;
    const x = 0.5 * (1 - Math.cos(th));
    const slope = camberLine(params, flap, x).slope;
    a0 += slope * (Math.cos(th) - 1) * dth;
    a1 += slope * Math.cos(th) * dth;
  }
  return { alphaZeroLift: -a0 / Math.PI, idealCl: 2 * a1 };
}

/**
 * Viscous effectiveness of a plain flap: the inviscid lift increment is fully realised at small
 * deflections and progressively lost as the flow separates from the flap at large ones.
 */
function flapEffectiveness(deflection: number): number {
  const r = Math.abs(deflection) / (35 * DEG);
  return 1 / Math.sqrt(1 + r * r);
}

/** Reynolds-number scaling of clMax, normalised at Re = 6e6. */
function reynoldsFactor(re: number): number {
  return clamp(Math.pow(sanitizeRe(re) / 6e6, 0.1), 0.75, 1.1);
}

function sanitizeRe(re: number): number {
  return Number.isFinite(re) ? clamp(re, 1e4, 1e10) : 6e6;
}

export function createSectionPolar(
  params: Naca4Params,
  solver: PanelSolver,
  options: SectionPolarOptions,
): ViscousSectionPolar {
  const t = clamp(params.thickness, 0.01, 0.4);
  const camber = Math.max(0, params.camber);

  // ---- Inviscid basis from the panel method --------------------------------------------
  // The Kutta-condition cl is exactly cl0 cos(a) + cl90 sin(a) = C sin(a - a0).
  const cl0 = solver.solve(0).cl;
  const cl90 = solver.solve(Math.PI / 2).cl;
  const inviscidSlope = Math.hypot(cl0, cl90);
  const inviscidA0 = -Math.atan2(cl0, cl90);
  const a = VISCOUS_SLOPE_FACTOR * inviscidSlope;

  // ---- Flap: inviscid alpha0 shift (thin-airfoil estimate) and viscous losses ----------
  const clean = thinAirfoilTheory(params, null);
  let flapShift = 0; // inviscid alpha0 shift due to the flap (negative for TE down)
  let eta = 1;
  if (options.flap && options.flap.deflection !== 0 && options.flap.chordFrac > 0) {
    flapShift = thinAirfoilTheory(params, options.flap).alphaZeroLift - clean.alphaZeroLift;
    eta = flapEffectiveness(options.flap.deflection);
  }
  const cleanA0 = inviscidA0 - flapShift;
  const flapDeltaCl = -a * eta * flapShift;
  // Slat: same lift slope, curve shifted slightly right so stall comes ~8 deg later.
  const slatShift = options.slat ? Math.max(0, 8 * DEG - 0.7 / a) : 0;
  const alpha0 = cleanA0 + eta * flapShift + slatShift;

  // ---- Stall parameters -----------------------------------------------------------------
  const camberBonus = 0.25 * (1 - Math.exp(-camber / 0.02));
  const clMaxSym = interpTable(CLMAX_TABLE, t);
  /** 0 for thin leading-edge-stall sections, 1 for thick trailing-edge-stall sections. */
  const thick = clamp((t - 0.08) / 0.07, 0, 1);
  const roundWidth = lerp(2, 5, thick) * DEG; // width of the rounded top of the lift curve
  const blendWidth = lerp(8, 14, thick) * DEG; // stall -> flat plate blend
  const dropFrac = lerp(0.45, 0.25, thick); // how far the remnant falls right after stall
  const dropWidth = lerp(3, 4.5, thick) * DEG;
  const sepWidth = lerp(3, 5, thick) * DEG; // how fast separation creeps forward
  const flapDragDelta = options.flap
    ? 0.9 *
      Math.pow(clamp(options.flap.chordFrac, 0, 1), 1.38) *
      Math.sin(options.flap.deflection) ** 2
    : 0;
  const designCl = clean.idealCl;

  // Pitching moment: linear fit of the panel cm about the zero-lift angle.
  const cmA = solver.solve(inviscidA0).cmQuarter;
  const cmB = solver.solve(inviscidA0 + 6 * DEG).cmQuarter;
  const cmSlope = (cmB - cmA) / (6 * DEG);

  // ---- Reynolds-dependent stall shape (one-entry cache: strips call repeatedly) --------
  let cachedRe = NaN;
  let clMaxRe = 0;
  let clMinRe = 0;
  let xsPos = 0; // x = alpha - alpha0 of the positive stall peak
  let xsNeg = 0; // (negative) x of the negative stall minimum
  function shape(re: number) {
    if (re === cachedRe) return;
    cachedRe = re;
    const f = reynoldsFactor(re);
    clMaxRe = Math.max(
      0.3,
      (clMaxSym + camberBonus) * f + 0.6 * flapDeltaCl + (options.slat ? 0.7 : 0),
    );
    clMinRe = Math.min(-0.3, -(clMaxSym - camberBonus) * f + 0.3 * flapDeltaCl);
    xsPos = clMaxRe / a + 0.5 * roundWidth;
    xsNeg = clMinRe / a - 0.5 * roundWidth;
  }

  /** Lift with stall, as a function of x = alpha - alpha0 (alpha itself for the flat plate). */
  function liftCurve(alpha: number, x: number): number {
    const fp = Math.sin(2 * alpha); // flat plate: 2 sin a cos a
    if (x >= 0) {
      if (x <= xsPos - roundWidth) return a * x;
      if (x <= xsPos) {
        const d = xsPos - x;
        return clMaxRe - (a / (2 * roundWidth)) * d * d;
      }
      const d = x - xsPos;
      const w = smoother(d / blendWidth);
      if (w >= 1) return fp;
      const remnant = clMaxRe - dropFrac * clMaxRe * (1 - Math.exp(-((d / dropWidth) ** 2)));
      return (1 - w) * remnant + w * fp;
    }
    if (x >= xsNeg + roundWidth) return a * x;
    if (x >= xsNeg) {
      const d = x - xsNeg;
      return clMinRe + (a / (2 * roundWidth)) * d * d;
    }
    const d = xsNeg - x;
    const w = smoother(d / blendWidth);
    if (w >= 1) return fp;
    const remnant = clMinRe - dropFrac * clMinRe * (1 - Math.exp(-((d / dropWidth) ** 2)));
    return (1 - w) * remnant + w * fp;
  }

  /** Weight of the post-stall (flat-plate) drag model, 0 attached .. 1 deep stall. */
  function dragBlend(x: number): number {
    if (x >= 0) return smoother((x - (xsPos - 2 * DEG)) / (blendWidth + 2 * DEG));
    return smoother((xsNeg + 2 * DEG - x) / (blendWidth + 2 * DEG));
  }

  const polar: ViscousSectionPolar = {
    alphaZeroLift: alpha0,
    liftSlope: a,
    inviscidLiftSlope: inviscidSlope,
    inviscidAlphaZeroLift: inviscidA0,
    designCl,
    flapDeltaCl,
    clMax(re: number) {
      shape(re);
      return clMaxRe;
    },
    clMin(re: number) {
      shape(re);
      return clMinRe;
    },
    alphaStall(re: number) {
      shape(re);
      return alpha0 + xsPos;
    },
    alphaStallNegative(re: number) {
      shape(re);
      return alpha0 + xsNeg;
    },
    clLinear(alpha: number) {
      return a * (alpha - alpha0);
    },
    isStalled(alpha: number, re: number) {
      shape(re);
      const x = alpha - alpha0;
      return x > xsPos || x < xsNeg;
    },
    cl(alpha: number, re: number) {
      shape(re);
      return liftCurve(alpha, alpha - alpha0);
    },
    cd(alpha: number, re: number) {
      shape(re);
      const r = sanitizeRe(re);
      const cf = 0.074 * Math.pow(r, -0.2);
      const friction = 2 * cf * (1 + 2 * t + 60 * t ** 4);
      const x = alpha - alpha0;
      const dcl = a * x - designCl;
      const attached = friction + 0.0065 * dcl * dcl + flapDragDelta;
      const s = Math.sin(alpha);
      const flatPlate = 1.98 * s * s + friction;
      const w = dragBlend(x);
      return attached + w * (flatPlate - attached);
    },
    cm(alpha: number, re: number) {
      shape(re);
      const x = alpha - alpha0;
      const attached = cmA + cmSlope * (alpha - inviscidA0);
      // Deep stall: normal force 1.98 sin(a) acting progressively further aft (Viterna-style).
      const separated = -1.98 * Math.sin(alpha) * (0.075 + (0.35 * Math.abs(alpha)) / Math.PI);
      const w = dragBlend(x);
      return attached + w * (separated - attached);
    },
    attachedFraction(alpha: number, re: number) {
      shape(re);
      const x = alpha - alpha0;
      // Separation starts at the trailing edge ~2 deg before the cl peak and creeps forward.
      const d = x >= 0 ? x - (xsPos - 2 * DEG) : xsNeg + 2 * DEG - x;
      if (d <= 0) return 1;
      return 0.1 + 0.9 * Math.exp(-((d / sepWidth) ** 2));
    },
  };
  return polar;
}
