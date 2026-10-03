/**
 * Benchmark tolerances: how close a TEACHING-GRADE model should come to each external
 * reference. They were fixed before any model value was computed against the references and
 * must not be widened to make a check pass. A model that misses one either gets a (small,
 * clearly correct) fix or an entry in KNOWN_DEVIATIONS (knownDeviations.ts), which keeps the
 * miss visible in the test output, in `npm run benchmark` and in docs/VALIDATION.md.
 *
 * `kind: 'rel'` is |model / reference - 1| <= value; `kind: 'abs'` is |model - reference| <= value.
 */
export interface Tolerance {
  kind: 'rel' | 'abs';
  value: number;
  /** Why this tolerance is what a teaching model should achieve. */
  why: string;
}

export const TOLERANCES = {
  /* ---------------------------------- 2D sections ---------------------------------------- */
  liftSlope2d: {
    kind: 'rel',
    value: 0.07,
    why:
      'Measured a0 of smooth NACA 4-digit sections scatters by about +-3 % between tunnels and ' +
      'Reynolds numbers; a panel method with a fixed boundary-layer factor should land within ' +
      'twice that.',
  },
  alphaZeroLift2d: {
    kind: 'abs',
    value: 0.5,
    why:
      'Thin-airfoil theory alone predicts alpha_L0 of NACA 4-digit sections to about 0.3 deg; ' +
      'the tables quote it to 0.1 deg. 0.5 deg covers both.',
  },
  clMax2d: {
    kind: 'rel',
    value: 0.15,
    why:
      'cl_max is set by boundary-layer separation, which no inviscid model predicts; an ' +
      'empirical table should still be within 15 % (the measured smooth-to-rough spread is ' +
      'larger, 20-30 %).',
  },
  alphaStall2d: {
    kind: 'abs',
    value: 2.5,
    why:
      'The stall angle combines the cl_max error with the shape of the rounded lift-curve top. ' +
      'Tunnel data define it only to about 1 deg; 2.5 deg is what a fitted shape should reach.',
  },
  cdMin2d: {
    kind: 'rel',
    value: 0.25,
    why:
      'Flat-plate friction times a form factor, with a fixed transition Reynolds number, cannot ' +
      'follow the laminar run of a smooth model; 25 % is the classic accuracy of form-factor ' +
      'methods for 4-digit sections.',
  },
  cmQuarter2d: {
    kind: 'abs',
    value: 0.02,
    why:
      'Inviscid cm_c/4 is typically 0.01-0.02 more negative than measured (the boundary layer ' +
      'decambers the aft section); 0.02 allows that without correction.',
  },
  clMaxReynoldsRatio: {
    kind: 'abs',
    value: 0.05,
    why:
      'The ratio cl_max(Re_high) / cl_max(Re_low) for 12 % sections rises by 3-10 % from Re 3e6 ' +
      'to 9e6; a Reynolds power law should match the ratio to 0.05.',
  },
  flapDeltaCl2d: {
    kind: 'rel',
    value: 0.2,
    why:
      'Plain-flap lift increment: thin-airfoil effectiveness plus an empirical viscous loss. ' +
      'Handbook methods (DATCOM) quote +-20 % for plain flaps.',
  },
  flapClMax2d: {
    kind: 'rel',
    value: 0.2,
    why: 'Flapped cl_max is less certain than clean cl_max; DATCOM accuracy is about 20 %.',
  },
  /* --------------------------------- 3D, inviscid lattice -------------------------------- */
  liftSlope3dVlm: {
    kind: 'rel',
    value: 0.05,
    why:
      'Two vortex-lattice codes on the same thin-surface geometry should agree on CL_alpha to a ' +
      'few percent; differences come only from paneling and from where the bound vortices sit.',
  },
  cl3dVlm: {
    kind: 'abs',
    value: 0.02,
    why: 'CL at a fixed alpha: the CL_alpha tolerance (5 %) at CL ~ 0.3-0.4, plus camber/twist.',
  },
  spanEfficiencyVlm: {
    kind: 'abs',
    value: 0.05,
    why:
      'Trefftz-plane e is an integral and converges fast; 0.05 lets spanwise paneling and the ' +
      'wake model differ.',
  },
  inducedDragVlm: {
    kind: 'rel',
    value: 0.1,
    why: 'CDi = CL^2 / (pi AR e): 5 % in e plus a few % in CL at the same alpha.',
  },
  /* --------------------------------- 3D, experiment -------------------------------------- */
  liftSlope3dExperiment: {
    kind: 'rel',
    value: 0.1,
    why:
      'Measured swept-wing CL_alpha carries wall-correction and aeroelastic uncertainties of ' +
      'several percent; a lattice with viscous section slopes should be within 10 %.',
  },
  clMax3dExperiment: {
    kind: 'rel',
    value: 0.2,
    why:
      'Swept-wing CLmax depends on spanwise boundary-layer flow and tip stall, which a strip ' +
      'model with an empirical sweep factor approximates; 20 % is DATCOM-level accuracy.',
  },
  alphaStall3dExperiment: {
    kind: 'abs',
    value: 3,
    why:
      "The angle of a swept wing's CLmax sits on a flat, rounded peak; 3 deg is the 2D " +
      "stall-angle tolerance plus the tunnel's 1 deg angle correction uncertainty.",
  },
  qualitative: {
    kind: 'abs',
    value: 0,
    why: 'Yes/no behaviour (for example where stall starts): the model must reproduce it.',
  },
  /* --------------------------------- Aircraft level -------------------------------------- */
  cruiseCl: {
    kind: 'rel',
    value: 0.15,
    why:
      'The preset cruise CL is weight / (q S) with an estimated cruise mass; it should fall ' +
      'within 15 % of a published cruise CL once both use the same reference area.',
  },
  buffetCl: {
    kind: 'rel',
    value: 0.2,
    why:
      'The buffet boundary is a Korn-equation estimate plus a fixed margin; published buffet ' +
      'onset is a flight-test boundary. 20 % is the honest reach of a wing-only estimate.',
  },
  landingClMax: {
    kind: 'rel',
    value: 0.15,
    why:
      'Wing-alone CLmax with a generic plain flap + slat model vs the trimmed airplane CLmax ' +
      '(tail download and fuselage reduce it by roughly 5-10 %); 15 % covers model and ' +
      'comparability gap.',
  },
  dragDivergenceMach: {
    kind: 'abs',
    value: 0.03,
    why:
      'The Korn equation with a technology factor is accurate to about +-0.02 for transport ' +
      'wings; 0.03 adds the uncertainty of the stand-in thickness and camber.',
  },
} as const satisfies Record<string, Tolerance>;

export type ToleranceId = keyof typeof TOLERANCES;
