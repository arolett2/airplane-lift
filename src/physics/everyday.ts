/**
 * Everyday-scale numbers behind lift, for the "make pressure intuitive" readouts:
 *  - the static pressure at a point from its local speed (compressible-aware),
 *  - the average pressure push across the wing (wing loading) as a share of the atmosphere,
 *  - the Newton view: how much air the wing throws down each second, and how fast.
 *
 * Pure functions, SI units. No DOM, no three.js.
 */

/** Ratio of specific heats for air. */
export const GAMMA_AIR = 1.4;

/** Highest freestream Mach number the Prandtl–Glauert factor is evaluated at. */
const MAX_PG_MACH = 0.95;

/**
 * Static pressure (Pa) where the air moves at `speedRatio` times the freestream speed, for a
 * freestream at Mach `mach` and static pressure `pInf` (Pa). Uses the isentropic energy relation
 *   p / p∞ = [1 + (γ−1)/2 · M∞² · (1 − (V/V∞)²)]^(γ/(γ−1)),
 * which reduces to Bernoulli (p − p∞ = q∞ (1 − (V/V∞)²)) at low Mach. Never negative.
 */
export function staticPressureFromSpeed(speedRatio: number, mach: number, pInf: number): number {
  if (!Number.isFinite(speedRatio) || !Number.isFinite(pInf)) return NaN;
  const m = Number.isFinite(mach) ? Math.max(0, mach) : 0;
  const base = 1 + 0.5 * (GAMMA_AIR - 1) * m * m * (1 - speedRatio * speedRatio);
  if (m < 1e-6) return pInf; // no dynamic pressure scale: nothing changes
  if (base <= 0) return 0;
  return pInf * Math.pow(base, GAMMA_AIR / (GAMMA_AIR - 1));
}

/**
 * Same as staticPressureFromSpeed but for an incompressible freestream given only by its dynamic
 * pressure q (Pa): p = p∞ + q (1 − r²). Used when the Mach number is not known.
 */
export function bernoulliPressure(speedRatio: number, q: number, pInf: number): number {
  return pInf + q * (1 - speedRatio * speedRatio);
}

/** Prandtl–Glauert factor 1/β = 1/√(1 − M²), capped for Mach numbers near 1. */
export function prandtlGlauertFactor(mach: number): number {
  const m = Math.min(MAX_PG_MACH, Math.max(0, Number.isFinite(mach) ? mach : 0));
  return 1 / Math.sqrt(1 - m * m);
}

export interface PointPressure {
  /** Static pressure (Pa). */
  pressure: number;
  /** Change from the surrounding (freestream) static pressure (Pa); negative = below. */
  delta: number;
  /** delta / p∞: e.g. −0.018 = "1.8% below the air around it". */
  fraction: number;
}

/** Pressure at a point from its local speed ratio (see staticPressureFromSpeed). */
export function pressureAtSpeed(speedRatio: number, mach: number, pInf: number): PointPressure {
  const pressure = staticPressureFromSpeed(speedRatio, mach, pInf);
  const delta = pressure - pInf;
  return { pressure, delta, fraction: pInf > 0 ? delta / pInf : NaN };
}

/** Pressure at a point from a pressure coefficient Cp and the dynamic pressure q (Pa). */
export function pressureFromCp(cp: number, q: number, pInf: number): PointPressure {
  const delta = cp * q;
  return { pressure: pInf + delta, delta, fraction: pInf > 0 ? delta / pInf : NaN };
}

/* ------------------------------------------------------------------------------------------ */
/* Pressure view: the average push across the wing                                              */
/* ------------------------------------------------------------------------------------------ */

export interface PressurePush {
  /** Mean pressure difference between the lower and upper surface (Pa) = L / S. */
  meanDelta: number;
  /** The same push as a resting mass per square metre (kg/m²) = L / (S g). */
  massPerArea: number;
  /** meanDelta / p∞: the share of the surrounding air pressure the push amounts to. */
  fractionOfAtmosphere: number;
}

/** Standard gravity (m/s²). */
const G0 = 9.80665;

/**
 * The average pressure difference that carries the lift: lift divided by the reference area
 * (the wing loading). Signed: negative when the wing pushes down.
 */
export function pressurePush(lift: number, area: number, pInf: number): PressurePush {
  const meanDelta = area > 0 ? lift / area : NaN;
  return {
    meanDelta,
    massPerArea: meanDelta / G0,
    fractionOfAtmosphere: pInf > 0 ? meanDelta / pInf : NaN,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Newton view: air thrown down                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface MomentumEstimate {
  /** Air mass the wing affects each second (kg/s): ρ V π b² / 4. */
  massFlow: number;
  /**
   * Vertical speed that air ends up with far behind the wing (m/s), = L / ṁ. Positive = downward
   * (positive lift); negative when the wing pushes down and so throws air up.
   */
  downwash: number;
}

/**
 * Lifting-line momentum estimate (an ESTIMATE, exact only for an elliptically loaded wing): the
 * wing acts on the air flowing through a circle whose diameter is the span, ṁ = ρ V π b² / 4,
 * and gives it a far-wake vertical speed w = L / ṁ, so that ṁ w = L (Newton's second law).
 * Zero lift gives zero downwash; non-physical inputs give NaN.
 */
export function momentumEstimate(
  lift: number,
  density: number,
  velocity: number,
  span: number,
): MomentumEstimate {
  const massFlow = density * velocity * Math.PI * span * span * 0.25;
  if (!(massFlow > 0) || !Number.isFinite(lift)) return { massFlow: NaN, downwash: NaN };
  return { massFlow, downwash: lift / massFlow };
}
