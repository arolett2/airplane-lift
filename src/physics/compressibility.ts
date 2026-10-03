/**
 * Transonic drag-rise estimates for a swept wing: the Korn equation for the drag-divergence Mach
 * number and Lock's empirical fourth-power law for wave drag (Mason, "Configuration
 * Aerodynamics", ch. 7; Malone & Mason 1995).
 *
 *   M_dd   = kappa / cos(L) - (t/c) / cos^2(L) - CL / (10 cos^3(L))
 *   M_crit = M_dd - (0.1 / 80)^(1/3)
 *   CD_w   = 20 (M - M_crit)^4      for M > M_crit, else 0
 *
 * kappa is the "technology factor": 0.87 for NACA 6-series sections, about 0.90 for the better
 * pre-supercritical transport sections of the 1960s (e.g. the 747's), and 0.95 for modern
 * supercritical sections. This app's "conventional" (non-supercritical) setting uses 0.90: its
 * main user is the 747-400, which cruises at Mach 0.85 right at its drag divergence, as real
 * 747s do (with 0.87 its M_dd would sit near 0.83). L is the sweep of the quarter-chord line and t/c the
 * streamwise thickness ratio. M_crit is defined so that dCD_w/dM = 0.1 exactly at M_dd, which is
 * the classic Boeing definition of drag divergence.
 */

/** Korn technology factor for a modern supercritical section. */
export const KORN_KAPPA_SUPERCRITICAL = 0.95;
/**
 * Korn technology factor for a conventional (pre-supercritical) transport section: about 0.90
 * for 1960s "peaky"/rooftop sections such as the 747's (plain NACA 6-series: 0.87).
 */
export const KORN_KAPPA_CONVENTIONAL = 0.9;

/** M_dd - M_crit from Lock's law with the dCD/dM = 0.1 drag-divergence definition (~0.108). */
export const LOCK_MDD_OFFSET = Math.cbrt(0.1 / 80);

/** Cosine floor so extreme sweep (or bad input) cannot divide by ~0. cos(80 deg) ~ 0.17. */
const MIN_COS_SWEEP = 0.17;

export interface CompressibilityInput {
  /** Freestream Mach number. */
  mach: number;
  /** Quarter-chord sweep (rad); sign is irrelevant (forward sweep behaves alike here). */
  sweep: number;
  /** Streamwise thickness-to-chord ratio (e.g. 0.12). */
  thicknessRatio: number;
  /** Wing lift coefficient. Its magnitude is used: shocks form on whichever surface is sucked. */
  cl: number;
  /** Use the supercritical technology factor. */
  supercritical: boolean;
}

export interface CompressibilityEstimate {
  machDragDivergence: number;
  machCritical: number;
  /** Wave-drag coefficient (Lock), referenced to the same area as `cl`. */
  waveDrag: number;
}

/** Drag-divergence Mach number from the Korn equation (simple sweep theory form). */
export function kornDragDivergenceMach(
  sweep: number,
  thicknessRatio: number,
  cl: number,
  supercritical: boolean,
): number {
  const kappa = supercritical ? KORN_KAPPA_SUPERCRITICAL : KORN_KAPPA_CONVENTIONAL;
  const c = Math.max(Math.cos(sweep), MIN_COS_SWEEP);
  return kappa / c - thicknessRatio / (c * c) - Math.abs(cl) / (10 * c * c * c);
}

/** Critical Mach number consistent with Lock's wave-drag law. */
export function criticalMachFromDragDivergence(machDragDivergence: number): number {
  return machDragDivergence - LOCK_MDD_OFFSET;
}

/** Lock's wave-drag law: 20 (M - M_crit)^4 above the critical Mach number, else 0. */
export function lockWaveDrag(mach: number, machCritical: number): number {
  const dm = mach - machCritical;
  if (!(dm > 0)) return 0;
  const dm2 = dm * dm;
  return 20 * dm2 * dm2;
}

/** Korn + Lock in one call: drag-divergence and critical Mach plus the wave drag at `mach`. */
export function compressibilityEstimate(input: CompressibilityInput): CompressibilityEstimate {
  const machDragDivergence = kornDragDivergenceMach(
    input.sweep,
    input.thicknessRatio,
    input.cl,
    input.supercritical,
  );
  const machCritical = criticalMachFromDragDivergence(machDragDivergence);
  return {
    machDragDivergence,
    machCritical,
    waveDrag: lockWaveDrag(input.mach, machCritical),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Maximum lift: sweep and shock-induced separation (buffet)                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Exponent n of the sweep factor cos^n(sweep) applied to the section maximum lift. A swept wing
 * stalls at a lower lift coefficient than its sections suggest: the boundary layer responds to
 * the pressure gradient normal to the sweep (simple sweep theory alone would give cos^2) while
 * spanwise flow partly offsets that. DATCOM's high-lift sweep correction uses cos^(3/4), which
 * also puts the clean low-speed CLmax of the airliner presets at 1.4-1.6, as published.
 */
export const SWEPT_MAX_LIFT_EXPONENT = 0.75;

/**
 * Lift margin from drag divergence to buffet onset. Past drag divergence the shock on the upper
 * surface strengthens with every bit of extra lift; once the local Mach number ahead of it nears
 * 1.3-1.4 (Pearcey's criterion) the boundary layer separates at its foot: buffet, the high-speed
 * stall. Airliners cruise near drag divergence with a 1.3 to 1.5 g margin to buffet onset, which
 * at cruise lift coefficients of 0.5 to 0.6 is roughly 0.25 in lift coefficient: this margin.
 */
export const BUFFET_LIFT_MARGIN = 0.2;

/** Lowest buffet-onset lift coefficient, approached smoothly far beyond drag divergence. */
export const BUFFET_LIFT_FLOOR = 0.3;

export interface MaxLiftInput {
  mach: number;
  /** Quarter-chord sweep (rad). */
  sweep: number;
  thicknessRatio: number;
  supercritical: boolean;
}

/** Korn equation solved for the lift coefficient: the lift at which M_dd equals `mach`. */
export function kornDragDivergenceLift(
  mach: number,
  sweep: number,
  thicknessRatio: number,
  supercritical: boolean,
): number {
  const kappa = supercritical ? KORN_KAPPA_SUPERCRITICAL : KORN_KAPPA_CONVENTIONAL;
  const c = Math.max(Math.cos(sweep), MIN_COS_SWEEP);
  return 10 * c * c * c * (kappa / c - thicknessRatio / (c * c) - Math.max(0, mach));
}

/**
 * Buffet-onset section lift coefficient at a Mach number (streamwise, freestream-referenced, as
 * the wing's strips are): drag-divergence lift plus BUFFET_LIFT_MARGIN, smoothly floored at
 * BUFFET_LIFT_FLOOR. Falls linearly with Mach (slope -10 cos^3 sweep, from Korn); it is huge at
 * low speed, where ordinary (low-speed) stall sets the limit instead.
 */
export function buffetLift(input: MaxLiftInput): number {
  const x =
    kornDragDivergenceLift(input.mach, input.sweep, input.thicknessRatio, input.supercritical) +
    BUFFET_LIFT_MARGIN;
  const f = BUFFET_LIFT_FLOOR;
  const w = 0.1; // width of the rounding at the floor
  return 0.5 * (x + f + Math.sqrt((x - f) * (x - f) + w * w));
}

/** Factor on the section maximum lift for a wing with this quarter-chord sweep (cos^0.75). */
export function sweptMaxLiftFactor(sweep: number): number {
  return Math.pow(Math.max(Math.cos(sweep), MIN_COS_SWEEP), SWEPT_MAX_LIFT_EXPONENT);
}

/**
 * Lift limit for a wing's strip polars at a Mach number. The solver evaluates the section polar
 * in incompressible units and divides its lift by beta (Prandtl-Glauert), so the limit is built
 * in those units: the strip's real maximum lift becomes
 *     clMax_real = softMin(sweepFactor * clMax_lowSpeed(Re), buffetLift(M))
 * i.e. the low-speed stall reduced for sweep (and NOT inflated by 1/beta: compressibility steepens
 * the lift curve but lowers, never raises, the maximum lift), capped by shock-induced separation.
 * `beta` is the Prandtl-Glauert factor the lattice uses (sqrt(1 - M^2), Mach clamped). The
 * deep-stall (flat-plate) lift is scaled by beta too, so it is not boosted either.
 */
export function wingLiftLimit(
  input: MaxLiftInput,
  beta: number,
): { scale: number; cap: number; flatPlateScale: number } {
  const b = Number.isFinite(beta) && beta > 0 ? Math.min(1, beta) : 1;
  return {
    scale: b * sweptMaxLiftFactor(input.sweep),
    cap: b * buffetLift(input),
    // Separated (post-stall) flow gets no Prandtl-Glauert boost.
    flatPlateScale: b,
  };
}

/** True when shock-induced separation, not low-speed stall, limits the lift at this Mach. */
export function buffetLimited(input: MaxLiftInput, lowSpeedClMax: number): boolean {
  return buffetLift(input) < sweptMaxLiftFactor(input.sweep) * lowSpeedClMax;
}
