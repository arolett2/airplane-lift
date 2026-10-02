/**
 * Transonic drag-rise estimates for a swept wing: the Korn equation for the drag-divergence Mach
 * number and Lock's empirical fourth-power law for wave drag (Mason, "Configuration
 * Aerodynamics", ch. 7; Malone & Mason 1995).
 *
 *   M_dd   = kappa / cos(L) - (t/c) / cos^2(L) - CL / (10 cos^3(L))
 *   M_crit = M_dd - (0.1 / 80)^(1/3)
 *   CD_w   = 20 (M - M_crit)^4      for M > M_crit, else 0
 *
 * kappa is the "technology factor": about 0.87 for conventional (NACA 6-series era) sections and
 * 0.95 for modern supercritical sections. L is the sweep of the quarter-chord line and t/c the
 * streamwise thickness ratio. M_crit is defined so that dCD_w/dM = 0.1 exactly at M_dd, which is
 * the classic Boeing definition of drag divergence.
 */

/** Korn technology factor for a modern supercritical section. */
export const KORN_KAPPA_SUPERCRITICAL = 0.95;
/** Korn technology factor for a conventional (peaky / 6-series) section. */
export const KORN_KAPPA_CONVENTIONAL = 0.87;

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
