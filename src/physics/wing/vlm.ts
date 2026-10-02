/**
 * Vortex-lattice method on the mean-camber surface of every lifting surface (non-planar, so
 * winglets work), with horseshoe vortices, Prandtl-Glauert compressibility, Trefftz-plane
 * induced drag, and a strip-wise viscous coupling ("virtual twist") for stall.
 * OWNER: physics-vlm agent. CONTRACT — keep the exported signatures.
 *
 * All VLM quantities are solved for V_inf = 1 in the BODY frame (trailing legs along body +x);
 * callers scale circulation by the true airspeed.
 */
import type {
  FlapState,
  Naca4Params,
  SectionPolar,
  Vec3,
  VortexLattice,
  WingGeometry,
} from '../types';
import { notImplemented } from '../../shared/notImplemented';

export interface VlmOptions {
  /** Chordwise panels per strip (default 6). */
  chordwisePanels: number;
  /** Spanwise strips per base-wing semispan (default 24, cosine-clustered toward the tip). */
  spanwisePanelsWing: number;
  /** Spanwise strips per tip-device surface (default 6). */
  spanwisePanelsDevice: number;
  /** Freestream Mach for Prandtl-Glauert (clamped to <= 0.85 internally). */
  mach: number;
}

export const DEFAULT_VLM_OPTIONS: VlmOptions = {
  chordwisePanels: 6,
  spanwisePanelsWing: 24,
  spanwisePanelsDevice: 6,
  mach: 0,
};

export interface VlmStrip {
  index: number;
  surfaceId: string;
  side: 'right' | 'left';
  /** Base wing: 0 root .. 1 tip by spanwise arc length; tip devices continue past 1. */
  eta: number;
  width: number;
  chord: number;
  /** Quarter-chord point at strip centre, BODY frame. */
  center: Vec3;
  /** Unit normal (BODY frame) of the strip's chord plane. */
  normal: Vec3;
  /** Unit span tangent (BODY frame), pointing outboard. */
  spanTangent: Vec3;
  /** Section properties interpolated at the strip centre. */
  airfoil: Naca4Params;
  flap: FlapState | null;
  slat: boolean;
  /** Local geometric incidence incl. washout (rad), excluding the flap. */
  twist: number;
  /** Index of the first chordwise panel of this strip; panels are contiguous. */
  panelStart: number;
  panelCount: number;
}

export interface VlmModel {
  geometry: WingGeometry;
  options: VlmOptions;
  panelCount: number;
  strips: VlmStrip[];
  /** Body-frame panel data, interleaved xyz (length 3 * panelCount). */
  boundA: Float64Array;
  boundB: Float64Array;
  /** Trailing-edge points where each panel's trailing legs leave the surface. */
  trailingA: Float64Array;
  trailingB: Float64Array;
  controlPoints: Float64Array;
  normals: Float64Array;
  panelAreas: Float64Array;
}

export interface VlmSolveInput {
  /** Freestream angle of attack in the body frame (rad). */
  alpha: number;
  /** Extra incidence per strip (rad), length strips.length — the viscous coupling's virtual twist. */
  stripIncidence?: Float64Array;
}

export interface VlmSolution {
  alpha: number;
  /** Panel circulation for V_inf = 1 (m). */
  gamma: Float64Array;
  /** Net strip circulation for V_inf = 1 (m). */
  stripCirculation: Float64Array;
  /** Local (linear, inviscid) section lift coefficient per strip. */
  stripCl: Float64Array;
  /** Induced angle per strip (rad), positive = downwash. */
  stripAlphaInduced: Float64Array;
  /** Coefficients referenced to geometry.referenceArea / meanAeroChord. */
  CL: number;
  CDi: number;
  /** Pitching moment about geometry.pivot (nose-up positive). */
  Cm: number;
}

export const buildVlmModel: (geometry: WingGeometry, options?: Partial<VlmOptions>) => VlmModel =
  notImplemented('buildVlmModel');

export const solveVlm: (model: VlmModel, input: VlmSolveInput) => VlmSolution =
  notImplemented('solveVlm');

/**
 * Express the solved lattice in the TUNNEL frame for flow-field evaluation: pitch the panels by
 * alpha about the pivot, scale circulation by vInf, and send trailing legs to +x (freestream).
 * `sources` is left empty and `coreRadius` set to a sensible default; the flow module fills sources.
 */
export const vlmLatticeToTunnel: (
  model: VlmModel,
  solution: VlmSolution,
  alpha: number,
  vInf: number,
) => VortexLattice = notImplemented('vlmLatticeToTunnel');

/* ------------------------------------------------------------------------------------------ */
/* Viscous coupling                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface StripPolarProvider {
  polar(strip: VlmStrip): SectionPolar;
  reynolds(strip: VlmStrip): number;
}

export interface CoupledSolution extends VlmSolution {
  /** Viscous section cl per strip (what the strip actually carries). */
  stripClViscous: Float64Array;
  stripAlphaEffective: Float64Array;
  stripCd: Float64Array;
  stripClMax: Float64Array;
  stripStalled: Uint8Array;
  stripAttachedFraction: Float64Array;
  iterations: number;
  converged: boolean;
}

export interface CouplingOptions {
  maxIterations: number;
  relaxation: number;
  tolerance: number;
}

/**
 * Nonlinear VLM: iterate per-strip virtual twist so each strip's inviscid cl matches its viscous
 * polar cl at the strip's effective alpha. Converges to the linear solution when nothing stalls.
 */
export const solveCoupled: (
  model: VlmModel,
  alpha: number,
  provider: StripPolarProvider,
  options?: Partial<CouplingOptions>,
) => CoupledSolution = notImplemented('solveCoupled');
