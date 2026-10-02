/**
 * Shared physics data contracts.
 *
 * COORDINATE FRAMES (used everywhere — physics, worker, rendering):
 *   Tunnel frame (a.k.a. world frame): right-handed, Z-UP.
 *     +x  downstream (the freestream flows toward +x)
 *     +y  toward the RIGHT (starboard) wingtip
 *     +z  up
 *   Body frame: same axes as the tunnel frame when angle of attack is zero.
 *     The wing is pitched nose-up by alpha about the +y axis through `WingGeometry.pivot`
 *     (root quarter-chord). Nose-up is a positive rotation about +y: R_y(alpha), i.e.
 *       x' =  x cos(a) + z sin(a)
 *       z' = -x sin(a) + z cos(a)
 *     (applied relative to the pivot). A leading edge ahead of the pivot (x < 0) goes UP.
 *   Airfoil (2D section) frame: x along chord from LE (0) to TE (1), y up (toward upper surface).
 *
 * UNITS: SI throughout physics (m, m/s, kg/m^3, Pa, N). Angles in RADIANS inside physics;
 *        degrees only at the UI/config boundary (fields suffixed `Deg`).
 *
 * Physics code must be pure (no DOM, no three.js) so it can run in a Web Worker and in node tests.
 */

export type Vec3 = [number, number, number];

/* ------------------------------------------------------------------------------------------ */
/* Airfoil (2D)                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** NACA 4-digit section parameters as fractions of chord. NACA 2412 => {0.02, 0.4, 0.12}. */
export interface Naca4Params {
  /** Maximum camber m (0 .. 0.095). */
  camber: number;
  /** Position of max camber p (0.1 .. 0.9). Ignored when camber == 0. */
  camberPos: number;
  /** Max thickness t (0.03 .. 0.25). */
  thickness: number;
}

/** Simple plain-flap model applied to a section's geometry/camber. */
export interface FlapState {
  /** Flap chord as a fraction of local chord (0.1 .. 0.4). */
  chordFrac: number;
  /** Deflection in radians, positive trailing-edge DOWN. */
  deflection: number;
}

/**
 * Closed airfoil contour in unit-chord airfoil frame.
 * Ordering: start at the trailing edge, run along the LOWER surface to the leading edge,
 * then along the UPPER surface back to the trailing edge (i.e. clockwise for x-right/y-up).
 * First and last points coincide at the TE for a sharp TE (or are the two TE corners).
 */
export interface AirfoilGeometry {
  /** Interleaved x,y pairs: [x0,y0,x1,y1,...]; length = 2 * nPoints. */
  coords: Float64Array;
  nPoints: number;
  /** Index of the leading-edge point in the point list. */
  leIndex: number;
  params: Naca4Params;
  flap: FlapState | null;
}

/** Inviscid panel-method solution at one angle of attack. */
export interface PanelSolution {
  alpha: number; // rad
  /** Pressure coefficient at each panel control point (length nPanels = nPoints-1). */
  cp: Float64Array;
  /** Control point coordinates, interleaved x,y (length 2*nPanels). */
  controlPoints: Float64Array;
  /** Vortex strength at each node (linear-vortex panels) normalised by V_inf (length nPoints). */
  gamma: Float64Array;
  /** Lift coefficient from the circulation (Kutta–Joukowski), per unit chord. */
  cl: number;
  /** Pitching moment about quarter chord. */
  cmQuarter: number;
  /** Stagnation point location along the contour, as airfoil-frame x,y. */
  stagnation: [number, number];
}

/**
 * Section (2D) aerodynamic polar including a viscous stall model.
 * Produced by the airfoil module, consumed by the wing solver's nonlinear coupling.
 */
export interface SectionPolar {
  /** Zero-lift angle of attack (rad). */
  alphaZeroLift: number;
  /** Linear lift-curve slope (per rad), from the panel method. */
  liftSlope: number;
  /** Maximum lift coefficient at the given Reynolds number. */
  clMax(reynolds: number): number;
  /** Angle at which cl peaks (rad). */
  alphaStall(reynolds: number): number;
  /** Viscous lift coefficient incl. stall and post-stall (flat-plate blending) for any alpha in [-pi, pi]. */
  cl(alpha: number, reynolds: number): number;
  /** Profile drag coefficient (friction + pressure, rising sharply after stall). */
  cd(alpha: number, reynolds: number): number;
  /** Pitching moment about quarter chord. */
  cm(alpha: number, reynolds: number): number;
  /**
   * Fraction of the upper surface with attached flow (1 = fully attached, 0 = fully separated).
   * Used to flatten Cp after separation and to drive stall visuals.
   */
  attachedFraction(alpha: number, reynolds: number): number;
}

/** Chordwise surface pressure samples at fixed x/c stations for one strip/section. */
export interface ChordwiseCp {
  /** x/c stations shared by upper and lower arrays (cosine-spaced, 0..1). */
  xc: Float32Array;
  upper: Float32Array;
  lower: Float32Array;
}

/** 2D flow around the airfoil at one span station, for the cross-section view. */
export interface SectionFlow {
  /** Station (fraction of semispan, 0 root .. 1 tip). */
  eta: number;
  /** Effective angle of attack used (rad) = geometric + twist - induced. */
  alphaEffective: number;
  alphaGeometric: number;
  alphaInduced: number;
  /** Airfoil contour in airfoil frame (unit chord), same ordering as AirfoilGeometry. */
  contour: Float32Array;
  cp: ChordwiseCp;
  cl: number;
  /** Separated (true) when the section is beyond stall. */
  stalled: boolean;
  /** Attached fraction of the upper surface (see SectionPolar.attachedFraction). */
  attachedFraction: number;
  stagnation: [number, number];
  /** Velocity grid in airfoil frame, normalised by V_inf. Row-major, x fastest: [u,v] per node. */
  grid: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    nx: number;
    ny: number;
    /** length 2*nx*ny */
    uv: Float32Array;
    /** 1 where the node lies inside the airfoil, else 0. length nx*ny */
    inside: Uint8Array;
  };
  /** Streamlines in airfoil frame. */
  streamlines: Streamline2D[];
}

export interface Streamline2D {
  /** Interleaved x,y. */
  points: Float32Array;
  /** |V|/V_inf at each point. */
  speed: Float32Array;
  /** Cumulative travel time at each point in units of chord / V_inf. Drives timeline pulses. */
  time: Float32Array;
}

/* ------------------------------------------------------------------------------------------ */
/* Wing geometry (3D)                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * A spanwise station of a lifting surface, in BODY frame (unpitched), meters.
 * Local section axes:
 *   - span tangent t = (0, cos(roll), sin(roll)) on the right side (mirror y for the left)
 *   - normal n = (0, -sin(roll), cos(roll)) on the right side
 *   - chord direction = +x rotated by `twist` about t (positive twist = nose up)
 * The airfoil's (x, y) maps to: le + x*chord*chordDir + y*chord*normalDir.
 */
export interface WingSection {
  le: Vec3;
  chord: number;
  /** Local incidence (rad), positive nose-up. Includes washout. */
  twist: number;
  /** Local surface roll (rad): 0 flat, +pi/2 vertical pointing up, -pi/2 vertical pointing down. */
  roll: number;
  airfoil: Naca4Params;
  /** Flap state at this station, or null. Flap applies to a spanwise segment if BOTH ends have it. */
  flap: FlapState | null;
  /** Leading-edge slat deployed at this station (raises clMax/stall angle). */
  slat: boolean;
}

export type SurfaceRole = 'wing' | 'tip-device';

export interface LiftingSurface {
  id: string;
  /** Human-readable, e.g. "Right wing", "Right winglet (upper)". */
  name: string;
  side: 'right' | 'left';
  role: SurfaceRole;
  /** Ordered from inboard/root to outboard/tip. At least 2 sections. */
  sections: WingSection[];
}

export interface WingGeometry {
  /** All surfaces, both sides (left side is the exact mirror y -> -y of the right side). */
  surfaces: LiftingSurface[];
  /** Pitch pivot (root quarter chord), body frame. */
  pivot: Vec3;
  /** Reference area (m^2): trapezoidal planform of the base wing, tip devices excluded. */
  referenceArea: number;
  /** Reference span (m): base wing tip-to-tip, tip devices excluded. */
  referenceSpan: number;
  /** Mean aerodynamic chord of the reference trapezoid (m). */
  meanAeroChord: number;
  /** Aspect ratio = referenceSpan^2 / referenceArea. */
  aspectRatio: number;
  /** Total projected span including in-plane tip extensions (raked tips) (m). */
  overallSpan: number;
  /** Wetted area of all surfaces (m^2), for friction drag. */
  wettedArea: number;
  /** Quarter-chord sweep of the base wing (rad). */
  sweepQuarterChord: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Aerodynamic results                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface AtmosphereState {
  altitude: number; // m
  temperature: number; // K
  pressure: number; // Pa
  density: number; // kg/m^3
  speedOfSound: number; // m/s
  dynamicViscosity: number; // Pa*s
}

/** Per spanwise strip result (one strip = one spanwise column of lattice panels). */
export interface StripResult {
  surfaceId: string;
  side: 'right' | 'left';
  /** Strip centre (quarter-chord point), TUNNEL frame. */
  center: Vec3;
  /** Spanwise coordinate along the surface's arc length from the root, normalised: 0..1 for the base wing, >1 on tip devices. */
  eta: number;
  /** Strip width along the span tangent (m). */
  width: number;
  chord: number;
  /** Local lift coefficient (viscous-corrected). */
  cl: number;
  /** Local section clMax at the local Reynolds number. */
  clMax: number;
  /** Geometric angle incl. twist & flap (rad). */
  alphaGeometric: number;
  /** Induced angle (rad), positive = downwash reduces alpha. */
  alphaInduced: number;
  /** alphaGeometric - alphaInduced (rad). */
  alphaEffective: number;
  /** Section profile drag coefficient. */
  cd: number;
  /** Net circulation of the strip (m^2/s). */
  circulation: number;
  /** Strip normal force per unit span (N/m) — useful for lift arrows. */
  liftPerSpan: number;
  /** Surface normal of the strip (TUNNEL frame, unit). */
  normal: Vec3;
  stalled: boolean;
  /** Attached fraction of upper-surface flow (1 attached .. 0 fully separated). */
  attachedFraction: number;
  /** Chordwise Cp for colouring the wing surface. */
  cp: ChordwiseCp;
}

/**
 * Vortex model of the solved wing for flow-field evaluation, in TUNNEL frame.
 * Horseshoe representation: for panel i, bound segment A_i -> B_i, plus trailing legs that run
 * from A_i and B_i to the trailing edge along the surface (`teA_i`, `teB_i`) and then to +infinity
 * along +x (the freestream direction in the tunnel frame).
 * Circulation sign: positive gamma produces positive lift on a right-side panel traversed A->B
 * with A inboard (toward -y) and B outboard.
 */
export interface VortexLattice {
  count: number;
  /** Each length 3*count, interleaved xyz. */
  a: Float32Array;
  b: Float32Array;
  teA: Float32Array;
  teB: Float32Array;
  /** Circulation per horseshoe (m^2/s). length count. */
  gamma: Float32Array;
  /**
   * Thickness model: spanwise line sources. For source k: segment p0_k -> p1_k (xyz, tunnel frame),
   * strength per unit length sigma_k (m^2/s per m, positive = outflow).
   */
  sources: { count: number; p0: Float32Array; p1: Float32Array; sigma: Float32Array };
  /** Vortex core radius (m) used to regularise Biot–Savart near segments. */
  coreRadius: number;
}

export interface AeroResult {
  /** Monotonic id echoing the request, used to drop stale responses. */
  requestId: number;
  atmosphere: AtmosphereState;
  velocity: number; // m/s, true airspeed
  mach: number;
  dynamicPressure: number; // Pa
  reynoldsMac: number;
  alpha: number; // rad

  /** Coefficients referenced to WingGeometry.referenceArea. */
  CL: number;
  CDi: number; // induced
  CD0: number; // profile (friction + pressure)
  CDw: number; // wave drag (compressibility)
  CD: number; // total
  Cm: number; // about the pivot
  liftToDrag: number;
  /** Span efficiency e from CDi = CL^2 / (pi * AR * e). NaN when CL ~ 0. */
  spanEfficiency: number;

  lift: number; // N
  drag: number; // N
  inducedDrag: number; // N

  /** Linear (attached-flow) whole-wing lift slope dCL/dalpha (per rad). */
  liftSlope: number;
  /** Critical Mach number estimate (Korn + Lock). */
  machCritical: number;
  machDragDivergence: number;

  stall: {
    /** Any strip beyond its section clMax. */
    any: boolean;
    /** Fraction of reference span that is stalled (0..1). */
    fraction: number;
    /** eta of the first strip to stall (smallest margin), or null if none near stall. */
    firstEta: number | null;
    /** min over strips of (clMax - cl), negative when stalled. */
    margin: number;
  };

  strips: StripResult[];
  lattice: VortexLattice;
  /** Total resultant force on the wing (N), tunnel frame (z = lift, x = drag). */
  force: Vec3;
  /** Centre of pressure (tunnel frame). */
  centerOfPressure: Vec3;
  warnings: string[];
}

/** Whole-wing lift curve, swept over alpha. */
export interface PolarSweep {
  requestId: number;
  alphaDeg: Float32Array;
  CL: Float32Array;
  CD: Float32Array;
  /** 2D section cl of the root airfoil at the same alphas, for finite-vs-infinite wing comparison. */
  sectionCl: Float32Array;
  /** Alpha (deg) at CLmax. */
  alphaStallDeg: number;
  CLmax: number;
}

/* ------------------------------------------------------------------------------------------ */
/* 3D flow field                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Uniform velocity grid in the TUNNEL frame, for fast particle advection. */
export interface FlowFieldGrid {
  requestId: number;
  origin: Vec3; // m, position of node (0,0,0)
  spacing: Vec3; // m
  dims: [number, number, number]; // nx, ny, nz
  /** Velocity (m/s, tunnel frame, freestream included). Index (i + nx*(j + ny*k))*3. */
  velocity: Float32Array;
  /** 1 where the node is inside the wing body (particles must not live there). length nx*ny*nz */
  solid: Uint8Array;
  /** Freestream speed (m/s). */
  vInf: number;
}

/** A 3D streamline integrated through the exact (non-gridded) vortex model. */
export interface Streamline3D {
  /** Interleaved xyz, tunnel frame (m). */
  points: Float32Array;
  /** |V|/V_inf at each point. */
  speed: Float32Array;
  /** Cumulative travel time (s) at each point (physical seconds). */
  time: Float32Array;
  /** Which seed set produced it. */
  group: 'rake' | 'tip-vortex' | 'sheet';
}
