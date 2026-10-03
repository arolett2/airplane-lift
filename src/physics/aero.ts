/**
 * Whole-wing aerodynamics: runs the physics modules in order (atmosphere -> geometry -> airfoil
 * polars -> nonlinear vortex lattice -> compressibility -> flow sources) and assembles the
 * `AeroResult` that the UI and renderers consume.
 * OWNER: integration. Pure TypeScript: no DOM, no three.js.
 *
 * Everything expensive is memoised in an `AeroCache`:
 *   - wing geometry, keyed by the wing config;
 *   - the VLM model (its factorised influence matrix), keyed by wing + Mach bucket (0.02), since
 *     Prandtl-Glauert makes the matrix Mach dependent;
 *   - the airfoil model of every strip (the airfoil module memoises too; this skips its lookup),
 *     plus its lift-limited view for the current Mach number (sweep + buffet, see
 *     compressibility.wingLiftLimit);
 *   - the last few coupled solutions + assembled results, keyed by wing + flow;
 *   - the polar sweep, keyed by wing + airspeed + altitude (it does not depend on alpha).
 */
import type {
  AeroResult,
  AtmosphereState,
  PolarSweep,
  SectionFlow,
  StripResult,
  SurfaceRole,
  Vec3,
  WingGeometry,
} from './types';
import type { FlowConditions, WingConfig } from '../state/params';
import type { AirfoilKey, AirfoilModelInternal } from './airfoil/index';
import type { CoupledSolution, StripPolarProvider, VlmModel, VlmStrip } from './wing/vlm';
import { isaAtmosphere, reynoldsNumber } from './atmosphere';
import { buildWingGeometry } from './wing/geometry';
import { buildVlmModel, solveCoupled, solveVlm, vlmLatticeToTunnel } from './wing/vlm';
import { getAirfoilModel } from './airfoil/index';
import { computeSectionFlow } from './airfoil/sectionFlow';
import { buildThicknessSources } from './flow/index';
import { bodyDirToTunnel, bodyToTunnel } from './math/frames';
import {
  buffetLimited,
  compressibilityEstimate,
  lockWaveDrag,
  wingLiftLimit,
  type MaxLiftInput,
} from './compressibility';

const DEG = Math.PI / 180;

/** Mach is bucketed to this step when keying VLM models, so small speed changes reuse a model. */
export const MACH_BUCKET = 0.02;
/** Chordwise Cp stations per strip for surface colouring. */
export const STRIP_CP_STATIONS = 41;
/** Polar sweep range (deg). */
export const POLAR_ALPHA_MIN_DEG = -6;
export const POLAR_ALPHA_MAX_DEG = 24;
export const POLAR_ALPHA_STEP_DEG = 1;
/** Prandtl-Glauert (and the VLM) clamp the Mach number here, like VLM_MAX_MACH. */
export const MACH_PG_LIMIT = 0.85;
/**
 * Above this Mach the results are flagged as rough. The clamp at MACH_PG_LIMIT barely matters
 * up to here (lift slope within ~3 %), so airliners at their normal cruise (up to ~0.86) are not
 * flagged.
 */
export const MACH_ROUGH_LIMIT = 0.88;
/** Below this Reynolds number (at the MAC) the viscous polars are rough. */
export const LOW_REYNOLDS = 1e5;
/** A strip closer than this to its clMax is reported as the place stall will start. */
export const STALL_WARNING_MARGIN = 0.15;
/** Airspeed floor (m/s) so a zero-speed input cannot produce Re = 0 or divide by zero. */
const MIN_AIRSPEED = 0.5;

/* ------------------------------------------------------------------------------------------ */
/* Cache                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Per (wing, Mach bucket): the factorised VLM model and everything derived from geometry alone. */
export interface ModelEntry {
  model: VlmModel;
  /** Airfoil model per VLM strip (index-aligned with model.strips), resolved on first use. */
  stripAirfoils: AirfoilModelInternal[] | null;
  /** The strip airfoils with the last lift limit applied (sweep + Mach), keyed by that limit. */
  limitedAirfoils: { key: string; airfoils: AirfoilModelInternal[] } | null;
  /** Indices of the right-side base-wing strips, sorted root -> tip by eta. */
  rightWingStrips: number[];
  /** True for strips that belong to the base wing (role 'wing'), false for tip devices. */
  isBaseWing: Uint8Array;
}

/** A solved flight condition: inputs, coupled VLM solution and the assembled result. */
export interface SolvedState {
  wing: WingConfig;
  flow: FlowConditions;
  geometry: WingGeometry;
  entry: ModelEntry;
  atmosphere: AtmosphereState;
  velocity: number;
  mach: number;
  dynamicPressure: number;
  /** Root-chord angle of attack (rad). */
  alpha: number;
  /** Strip airfoils with the lift limit of this Mach number (index-aligned with model.strips). */
  airfoils: AirfoilModelInternal[];
  /** Reynolds number per strip (local chord). */
  stripReynolds: Float64Array;
  /** Geometric angle of attack per strip (rad): alpha projected on the strip plane + twist. */
  stripAlphaGeometric: Float64Array;
  solution: CoupledSolution;
  /** Assembled result (requestId of the first request that produced it). */
  aero: AeroResult | null;
  /** Last section flow computed for this state, keyed by its (clamped) eta. */
  section: { eta: number; flow: SectionFlow } | null;
}

export interface AeroCacheStats {
  geometryBuilds: number;
  modelBuilds: number;
  coupledSolves: number;
  polarSweeps: number;
}

/** Memoised geometry + VLM models + airfoil models + recent solutions. See the module doc. */
export interface AeroCache {
  /** Max entries kept in each LRU map. */
  readonly capacity: number;
  readonly geometries: Map<string, WingGeometry>;
  readonly models: Map<string, ModelEntry>;
  readonly solves: Map<string, SolvedState>;
  readonly polars: Map<string, PolarSweep>;
  /** Counters, handy for tests and profiling. */
  readonly stats: AeroCacheStats;
}

export function createAeroCache(capacity = 4): AeroCache {
  return {
    capacity: Math.max(1, Math.floor(capacity)),
    geometries: new Map(),
    models: new Map(),
    solves: new Map(),
    polars: new Map(),
    stats: { geometryBuilds: 0, modelBuilds: 0, coupledSolves: 0, polarSweeps: 0 },
  };
}

/**
 * Deterministic JSON-like key with sorted object keys, so equal configs built in a different
 * property order (e.g. decoded from the URL) still hit the cache.
 */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'undefined' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] !== undefined) parts.push(`${JSON.stringify(k)}:${stableKey(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/** Prandtl-Glauert lift factor 1/sqrt(1 - M^2), with M clamped to MACH_PG_LIMIT like the VLM. */
export function prandtlGlauertFactor(mach: number): number {
  const m = Math.min(Math.max(mach, 0), MACH_PG_LIMIT);
  return 1 / Math.sqrt(1 - m * m);
}

/** Mach bucket index: the model is built at `machBucketIndex(m) * MACH_BUCKET`. */
export function machBucketIndex(mach: number): number {
  return Math.max(0, Math.round(mach / MACH_BUCKET));
}

function lruGet<V>(map: Map<string, V>, key: string): V | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

function lruSet<V>(map: Map<string, V>, key: string, value: V, capacity: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > capacity) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function getGeometry(wing: WingConfig, wingKey: string, cache: AeroCache): WingGeometry {
  let geometry = lruGet(cache.geometries, wingKey);
  if (!geometry) {
    geometry = buildWingGeometry(wing);
    cache.stats.geometryBuilds++;
    lruSet(cache.geometries, wingKey, geometry, cache.capacity);
  }
  return geometry;
}

function getModelEntry(
  geometry: WingGeometry,
  wingKey: string,
  machIndex: number,
  cache: AeroCache,
): ModelEntry {
  const key = `${wingKey}|M${machIndex}`;
  let entry = lruGet(cache.models, key);
  if (!entry) {
    const model = buildVlmModel(geometry, { mach: machIndex * MACH_BUCKET });
    cache.stats.modelBuilds++;
    const roles = new Map<string, SurfaceRole>();
    for (const s of geometry.surfaces) roles.set(s.id, s.role);
    const isBaseWing = new Uint8Array(model.strips.length);
    const rightWingStrips: number[] = [];
    model.strips.forEach((strip, i) => {
      // Unknown surface ids fall back to the eta convention (base wing is 0..1).
      const role = roles.get(strip.surfaceId) ?? (strip.eta <= 1 ? 'wing' : 'tip-device');
      if (role === 'wing') {
        isBaseWing[i] = 1;
        if (strip.side === 'right') rightWingStrips.push(i);
      }
    });
    rightWingStrips.sort((a, b) => model.strips[a]!.eta - model.strips[b]!.eta);
    entry = { model, stripAirfoils: null, limitedAirfoils: null, rightWingStrips, isBaseWing };
    lruSet(cache.models, key, entry, cache.capacity);
  }
  return entry;
}

/** Round to a grid so float noise from spanwise interpolation does not split airfoil keys. */
function quantize(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** The airfoil key of a strip (quantised so equal sections share one airfoil model). */
export function stripAirfoilKey(strip: VlmStrip, supercritical: boolean): AirfoilKey {
  const a = strip.airfoil;
  return {
    params: {
      camber: quantize(a.camber, 1e-5),
      camberPos: quantize(a.camberPos, 1e-4),
      thickness: quantize(a.thickness, 1e-5),
    },
    flap: strip.flap
      ? {
          chordFrac: quantize(strip.flap.chordFrac, 1e-4),
          deflection: quantize(strip.flap.deflection, 1e-5),
        }
      : null,
    slat: strip.slat,
    supercritical,
  };
}

function stripAirfoils(entry: ModelEntry, supercritical: boolean): AirfoilModelInternal[] {
  if (!entry.stripAirfoils) {
    const byKey = new Map<string, AirfoilModelInternal>();
    entry.stripAirfoils = entry.model.strips.map((strip) => {
      const key = stripAirfoilKey(strip, supercritical);
      const k = stableKey(key);
      let m = byKey.get(k);
      if (!m) {
        m = getAirfoilModel(key);
        byKey.set(k, m);
      }
      return m;
    });
  }
  return entry.stripAirfoils;
}

/** Inputs of the maximum-lift model (sweep, thickness, section technology) at a Mach number. */
export function maxLiftInput(wing: WingConfig, geometry: WingGeometry, mach: number): MaxLiftInput {
  return {
    mach,
    sweep: geometry.sweepQuarterChord,
    thicknessRatio: wing.airfoil.thickness,
    supercritical: wing.supercritical,
  };
}

/**
 * Strip airfoils with the wing's lift limit at this Mach number: section maximum lift reduced for
 * sweep and capped by shock-induced separation (see compressibility.wingLiftLimit). The limit is
 * built with the lattice's own Prandtl-Glauert factor, so the solver's cl / beta peaks at the
 * real maximum lift.
 */
function limitedStripAirfoils(
  entry: ModelEntry,
  wing: WingConfig,
  geometry: WingGeometry,
  mach: number,
): AirfoilModelInternal[] {
  const plain = stripAirfoils(entry, wing.supercritical);
  const limit = wingLiftLimit(maxLiftInput(wing, geometry, mach), entry.model.beta);
  const key = `${limit.scale}|${limit.cap}|${limit.flatPlateScale}`;
  if (entry.limitedAirfoils?.key !== key) {
    const views = new Map<AirfoilModelInternal, AirfoilModelInternal>();
    const airfoils = plain.map((m) => {
      let v = views.get(m);
      if (!v) {
        // Models without lift-limit support (test doubles) are used as they are.
        v = typeof m.withLiftLimit === 'function' ? m.withLiftLimit(limit) : m;
        views.set(m, v);
      }
      return v;
    });
    entry.limitedAirfoils = { key, airfoils };
  }
  return entry.limitedAirfoils.airfoils;
}

/** Position of a strip in model.strips (its `index`, verified, with a slow fallback). */
function stripPosition(model: VlmModel, strip: VlmStrip): number {
  return model.strips[strip.index] === strip ? strip.index : model.strips.indexOf(strip);
}

function makeProvider(
  model: VlmModel,
  airfoils: AirfoilModelInternal[],
  reynolds: Float64Array,
): StripPolarProvider {
  return {
    polar: (strip) => airfoils[stripPosition(model, strip)]!.polar,
    reynolds: (strip) => reynolds[stripPosition(model, strip)]!,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Strip geometry helpers                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * Geometric angle of attack of a strip (rad) for root angle `alpha`: the freestream (body frame:
 * (cos a, 0, sin a)) measured against the strip's twisted chord line. The untwisted normal is
 * built from the span tangent's y-z part, so a flat wing gets alpha*cos(dihedral) + twist and a
 * vertical winglet gets just its toe/twist. Independent of how the VLM defines `normal`.
 */
export function stripGeometricAlpha(strip: VlmStrip, alpha: number): number {
  const ty = strip.spanTangent[1];
  const tz = strip.spanTangent[2];
  const len = Math.hypot(ty, tz);
  // z-component of the untwisted section normal: x^ x t (right) or t x x^ (left), unit length.
  let n0z: number;
  if (len < 1e-9) n0z = 1;
  else n0z = strip.side === 'right' ? ty / len : -ty / len;
  const vn0 = Math.sin(alpha) * n0z; // freestream . untwisted normal
  const ca = Math.cos(alpha);
  const ct = Math.cos(strip.twist);
  const st = Math.sin(strip.twist);
  const vn = st * ca + ct * vn0;
  const vc = ct * ca - st * vn0;
  return Math.atan2(vn, vc);
}

/* ------------------------------------------------------------------------------------------ */
/* Solve                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * Solve (or fetch) the coupled VLM for a wing + flight condition. Shared by computeAero and
 * computeSection so the section view reuses the 3D solution.
 */
export function solveState(wing: WingConfig, flow: FlowConditions, cache: AeroCache): SolvedState {
  const wingKey = stableKey(wing);
  const key = `${wingKey}|${stableKey(flow)}`;
  const hit = lruGet(cache.solves, key);
  if (hit) return hit;

  const atmosphere = isaAtmosphere(flow.altitude);
  const velocity = Math.max(flow.airspeed, MIN_AIRSPEED);
  const mach = velocity / atmosphere.speedOfSound;
  const dynamicPressure = 0.5 * atmosphere.density * velocity * velocity;
  const alpha = flow.alphaDeg * DEG;

  const geometry = getGeometry(wing, wingKey, cache);
  const entry = getModelEntry(geometry, wingKey, machBucketIndex(mach), cache);
  const { model } = entry;
  const airfoils = limitedStripAirfoils(entry, wing, geometry, mach);

  const n = model.strips.length;
  const stripReynolds = new Float64Array(n);
  const stripAlphaGeometric = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const strip = model.strips[i]!;
    stripReynolds[i] = reynoldsNumber(atmosphere, velocity, strip.chord);
    stripAlphaGeometric[i] = stripGeometricAlpha(strip, alpha);
  }

  const solution = solveCoupled(model, alpha, makeProvider(model, airfoils, stripReynolds));
  cache.stats.coupledSolves++;

  const state: SolvedState = {
    wing,
    flow,
    geometry,
    entry,
    atmosphere,
    velocity,
    mach,
    dynamicPressure,
    alpha,
    airfoils,
    stripReynolds,
    stripAlphaGeometric,
    solution,
    aero: null,
    section: null,
  };
  lruSet(cache.solves, key, state, cache.capacity);
  return state;
}

/** Profile-drag coefficient: strip section cd weighted by strip area, over the reference area. */
function profileDrag(model: VlmModel, stripCd: Float64Array, referenceArea: number): number {
  let sum = 0;
  for (let i = 0; i < model.strips.length; i++) {
    const s = model.strips[i]!;
    sum += stripCd[i]! * s.chord * s.width;
  }
  return referenceArea > 0 ? sum / referenceArea : 0;
}

export interface StallSummary {
  any: boolean;
  fraction: number;
  firstEta: number | null;
  margin: number;
}

/**
 * Stall state from the coupled solution. A strip's margin is clMax - cl while attached; once
 * stalled its viscous cl has fallen from clMax, so the margin is reported as -(clMax - cl) to stay
 * negative (0 right at stall onset, more negative as lift is lost).
 */
export function summarizeStall(
  model: VlmModel,
  solution: CoupledSolution,
  isBaseWing: Uint8Array,
): StallSummary {
  let any = false;
  let stalledWidth = 0;
  let totalWidth = 0;
  let margin = Infinity;
  let marginEta = 0;
  for (let i = 0; i < model.strips.length; i++) {
    const strip = model.strips[i]!;
    const stalled = solution.stripStalled[i] !== 0;
    const gap = solution.stripClMax[i]! - solution.stripClViscous[i]!;
    const m = stalled ? -Math.abs(gap) : gap;
    if (stalled) any = true;
    if (isBaseWing[i]) {
      totalWidth += strip.width;
      if (stalled) stalledWidth += strip.width;
    }
    if (m < margin) {
      margin = m;
      marginEta = strip.eta;
    }
  }
  if (!Number.isFinite(margin)) margin = 0;
  return {
    any,
    fraction: totalWidth > 0 ? Math.min(1, stalledWidth / totalWidth) : 0,
    firstEta: margin < STALL_WARNING_MARGIN ? marginEta : null,
    margin,
  };
}

/**
 * Lift-weighted centre of the strip quarter-chord points (weights = vertical force per strip),
 * clamped to their bounding box so it stays on the wing when the net lift is nearly zero. Falls
 * back to the area centroid when lift contributions cancel.
 */
function centerOfPressure(strips: StripResult[]): Vec3 {
  if (strips.length === 0) return [0, 0, 0];
  const lo = new Float64Array([Infinity, Infinity, Infinity]);
  const hi = new Float64Array([-Infinity, -Infinity, -Infinity]);
  const byLift = new Float64Array(3);
  const byArea = new Float64Array(3);
  let w = 0;
  let wAbs = 0;
  let aSum = 0;
  for (const s of strips) {
    const wi = s.liftPerSpan * s.width * s.normal[2];
    const ai = s.chord * s.width;
    w += wi;
    wAbs += Math.abs(wi);
    aSum += ai;
    for (let k = 0; k < 3; k++) {
      const c = s.center[k]!;
      byLift[k] = byLift[k]! + wi * c;
      byArea[k] = byArea[k]! + ai * c;
      lo[k] = Math.min(lo[k]!, c);
      hi[k] = Math.max(hi[k]!, c);
    }
  }
  const useLift = w !== 0 && Math.abs(w) > 1e-3 * wAbs;
  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = useLift ? byLift[k]! / w : aSum > 0 ? byArea[k]! / aSum : 0;
    out[k] = Math.min(hi[k]!, Math.max(lo[k]!, v));
  }
  return out;
}

function formatReynolds(re: number): string {
  if (re >= 1e6) return `${(re / 1e6).toFixed(1)} million`;
  return `${Math.round(re / 1000)} thousand`;
}

/**
 * True when the stall is shock-induced (buffet): on the most deeply stalled base-wing strip the
 * Mach-dependent buffet limit, not the low-speed stall of the section, sets the maximum lift.
 */
function highSpeedStall(state: SolvedState): boolean {
  const { entry, solution: sol } = state;
  const plain = entry.stripAirfoils;
  if (!plain) return false;
  let worst = -1;
  for (let i = 0; i < sol.stripStalled.length; i++) {
    if (!sol.stripStalled[i] || !entry.isBaseWing[i]) continue;
    if (worst < 0 || sol.stripAlphaEffective[i]! > sol.stripAlphaEffective[worst]!) worst = i;
  }
  if (worst < 0) return false;
  const lowSpeedClMax = plain[worst]!.polar.clMax(state.stripReynolds[worst]!);
  return buffetLimited(maxLiftInput(state.wing, state.geometry, state.mach), lowSpeedClMax);
}

function assembleAero(state: SolvedState, requestId: number): AeroResult {
  const { wing, geometry, entry, solution: sol, alpha, velocity, mach, dynamicPressure } = state;
  const { model } = entry;
  const { airfoils } = state;
  const q = dynamicPressure;
  const S = geometry.referenceArea;

  const strips: StripResult[] = model.strips.map((strip, i) => {
    const cl = sol.stripClViscous[i]!;
    const alphaEffective = sol.stripAlphaEffective[i]!;
    const alphaGeometric = state.stripAlphaGeometric[i]!;
    const reynolds = state.stripReynolds[i]!;
    return {
      surfaceId: strip.surfaceId,
      side: strip.side,
      center: bodyToTunnel(strip.center, geometry.pivot, alpha),
      eta: strip.eta,
      width: strip.width,
      chord: strip.chord,
      cl,
      clMax: sol.stripClMax[i]!,
      alphaGeometric,
      alphaInduced: alphaGeometric - alphaEffective,
      alphaEffective,
      cd: sol.stripCd[i]!,
      circulation: sol.stripCirculation[i]! * velocity,
      liftPerSpan: q * strip.chord * cl,
      normal: bodyDirToTunnel(strip.normal, alpha),
      stalled: sol.stripStalled[i] !== 0,
      attachedFraction: sol.stripAttachedFraction[i]!,
      cp: airfoils[i]!.chordwiseCp(alphaEffective, reynolds, STRIP_CP_STATIONS, cl),
    };
  });

  const CL = sol.CL;
  const CDi = sol.CDi;
  const CD0 = profileDrag(model, sol.stripCd, S);
  const comp = compressibilityEstimate({
    mach,
    sweep: geometry.sweepQuarterChord,
    thicknessRatio: wing.airfoil.thickness,
    cl: CL,
    supercritical: wing.supercritical,
  });
  const CDw = comp.waveDrag;
  const CD = CD0 + CDi + CDw;
  const qS = q * S;
  const lift = qS * CL;
  const drag = qS * CD;

  const AR = geometry.aspectRatio;
  const spanEfficiency =
    Math.abs(CL) < 1e-3 || !(CDi > 0) || !(AR > 0) ? NaN : (CL * CL) / (Math.PI * AR * CDi);

  // Linear (attached-flow) lift slope by central difference of the inviscid solution.
  const dA = 1 * DEG;
  const liftSlope =
    (solveVlm(model, { alpha: alpha + dA }).CL - solveVlm(model, { alpha: alpha - dA }).CL) /
    (2 * dA);

  const stall = summarizeStall(model, sol, entry.isBaseWing);

  const lattice = vlmLatticeToTunnel(model, sol, alpha, velocity);
  lattice.sources = buildThicknessSources(geometry, alpha, velocity);

  const reynoldsMac = reynoldsNumber(state.atmosphere, velocity, geometry.meanAeroChord);

  const warnings: string[] = [];
  if (mach > MACH_ROUGH_LIMIT) {
    warnings.push(
      `At Mach ${mach.toFixed(2)} the simple compressibility corrections used here are pushed ` +
        `beyond about Mach ${MACH_ROUGH_LIMIT}, so treat these numbers as rough estimates.`,
    );
  }
  // Between the critical and the drag-divergence Mach number the wing has weak shocks and a
  // little wave drag: that is normal airliner cruise, so it is not a warning (the UI may show
  // it as information from machCritical / machDragDivergence).
  if (mach > comp.machDragDivergence) {
    warnings.push(
      `Past drag divergence (about Mach ${comp.machDragDivergence.toFixed(2)} for this wing at ` +
        `this lift): the shock waves over the wing are now strong and wave drag climbs steeply ` +
        `with every bit of extra speed.`,
    );
  }
  if (reynoldsMac < LOW_REYNOLDS) {
    warnings.push(
      `Very low Reynolds number (${formatReynolds(reynoldsMac)}): at this small size and speed ` +
        `air behaves more like syrup, and the drag and stall estimates are rough.`,
    );
  }
  if (stall.any) {
    const pct = Math.round(stall.fraction * 100);
    const where = pct > 0 ? `over about ${pct}% of the span` : `over part of the wing`;
    warnings.push(
      highSpeedStall(state)
        ? `Stall (high-speed buffet): shock waves on the upper surface have made the air ` +
            `separate ${where}. Near the speed of sound a wing stalls at a much smaller angle.`
        : `Stall: the air has separated from the upper surface ${where}.`,
    );
  }
  if (!sol.converged) {
    warnings.push('The stall calculation did not fully settle; values near stall are approximate.');
  }

  return {
    requestId,
    atmosphere: state.atmosphere,
    velocity,
    mach,
    dynamicPressure: q,
    reynoldsMac,
    alpha,
    CL,
    CDi,
    CD0,
    CDw,
    CD,
    Cm: sol.Cm,
    liftToDrag: Math.abs(CD) > 1e-12 ? CL / CD : 0,
    spanEfficiency,
    lift,
    drag,
    inducedDrag: qS * CDi,
    liftSlope,
    machCritical: comp.machCritical,
    machDragDivergence: comp.machDragDivergence,
    stall,
    strips,
    lattice,
    force: [drag, 0, lift],
    centerOfPressure: centerOfPressure(strips),
    warnings,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Public API                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Solve the wing at one flight condition. Repeated calls with equal inputs are nearly free. */
export function computeAero(
  wing: WingConfig,
  flow: FlowConditions,
  requestId: number,
  cache: AeroCache,
): { geometry: WingGeometry; aero: AeroResult } {
  const state = solveState(wing, flow, cache);
  if (!state.aero) state.aero = assembleAero(state, requestId);
  const aero = state.aero.requestId === requestId ? state.aero : { ...state.aero, requestId };
  return { geometry: state.geometry, aero };
}

/**
 * Whole-wing lift and drag curves for alpha = -6..24 deg (step 1), reusing the cached VLM model,
 * plus the 2D section cl of the root airfoil at the same root angles for comparison (with the
 * same Prandtl-Glauert factor as the 3D solve, and the same maximum-lift limit as the wing's
 * strips: reduced for sweep and, at high Mach, capped by buffet).
 * Independent of flow.alphaDeg, so it is cached by wing + airspeed + altitude.
 */
export function computePolarSweep(
  wing: WingConfig,
  flow: FlowConditions,
  requestId: number,
  cache: AeroCache,
): PolarSweep {
  const wingKey = stableKey(wing);
  const key = `${wingKey}|${stableKey({ airspeed: flow.airspeed, altitude: flow.altitude })}`;
  const hit = lruGet(cache.polars, key);
  if (hit) return hit.requestId === requestId ? hit : { ...hit, requestId };

  const atmosphere = isaAtmosphere(flow.altitude);
  const velocity = Math.max(flow.airspeed, MIN_AIRSPEED);
  const mach = velocity / atmosphere.speedOfSound;
  const geometry = getGeometry(wing, wingKey, cache);
  const machIndex = machBucketIndex(mach);
  const entry = getModelEntry(geometry, wingKey, machIndex, cache);
  const { model } = entry;
  const airfoils = limitedStripAirfoils(entry, wing, geometry, mach);
  // The VLM applies Prandtl-Glauert at the bucketed Mach (clamped); scale the 2D curve alike so
  // the finite-vs-infinite wing comparison stays fair at airliner speeds.
  const pgFactor = prandtlGlauertFactor(machIndex * MACH_BUCKET);
  const reynolds = new Float64Array(model.strips.length);
  for (let i = 0; i < model.strips.length; i++) {
    reynolds[i] = reynoldsNumber(atmosphere, velocity, model.strips[i]!.chord);
  }
  const provider = makeProvider(model, airfoils, reynolds);

  // Root section: the innermost right base-wing strip (carries the root flap/slat state).
  const rootIndex = entry.rightWingStrips[0] ?? 0;
  const rootPolar = airfoils[rootIndex]?.polar;
  const rootRe = reynolds[rootIndex] ?? reynoldsNumber(atmosphere, velocity, wing.rootChord);
  const rootIncidence = wing.rootIncidenceDeg * DEG;

  const n = Math.round((POLAR_ALPHA_MAX_DEG - POLAR_ALPHA_MIN_DEG) / POLAR_ALPHA_STEP_DEG) + 1;
  const alphaDeg = new Float32Array(n);
  const CL = new Float32Array(n);
  const CD = new Float32Array(n);
  const sectionCl = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const aDeg = POLAR_ALPHA_MIN_DEG + k * POLAR_ALPHA_STEP_DEG;
    const a = aDeg * DEG;
    const sol = solveCoupled(model, a, provider);
    cache.stats.coupledSolves++;
    const comp = compressibilityEstimate({
      mach,
      sweep: geometry.sweepQuarterChord,
      thicknessRatio: wing.airfoil.thickness,
      cl: sol.CL,
      supercritical: wing.supercritical,
    });
    alphaDeg[k] = aDeg;
    CL[k] = sol.CL;
    CD[k] =
      profileDrag(model, sol.stripCd, geometry.referenceArea) +
      sol.CDi +
      lockWaveDrag(mach, comp.machCritical);
    sectionCl[k] = rootPolar ? rootPolar.cl(a + rootIncidence, rootRe) * pgFactor : NaN;
  }
  const best = stallPeakIndex(CL);
  cache.stats.polarSweeps++;

  const polar: PolarSweep = {
    requestId,
    alphaDeg,
    CL,
    CD,
    sectionCl,
    alphaStallDeg: alphaDeg[best]!,
    CLmax: CL[best]!,
  };
  lruSet(cache.polars, key, polar, cache.capacity);
  return polar;
}

/** A lift peak counts as the stall when no lift within this many sweep points beyond it is higher. */
const STALL_PEAK_LOOKAHEAD = 4;

/**
 * Index of the stall peak of a lift curve: the first local maximum that the next
 * STALL_PEAK_LOOKAHEAD points do not exceed (falling back to the highest point). Deep-stall
 * (flat-plate) lift can climb above a low buffet peak at the far end of the sweep; that is not
 * the stall, so the first real peak wins.
 */
export function stallPeakIndex(cl: ArrayLike<number>): number {
  const n = cl.length;
  let best = 0;
  for (let k = 0; k < n; k++) if (cl[k]! > cl[best]!) best = k;
  for (let k = 1; k < n - 1; k++) {
    if (!(cl[k]! >= cl[k - 1]! && cl[k]! > cl[k + 1]!)) continue;
    let exceeded = false;
    for (let j = k + 1; j <= Math.min(n - 1, k + STALL_PEAK_LOOKAHEAD); j++) {
      if (cl[j]! > cl[k]!) exceeded = true;
    }
    if (!exceeded) return k;
  }
  return best;
}

/** Linear interpolation of a per-strip quantity over the sorted right-wing strips at eta. */
function interpolateStrips(
  model: VlmModel,
  order: number[],
  eta: number,
): { i0: number; i1: number; t: number; nearest: number } {
  const first = order[0]!;
  const last = order[order.length - 1]!;
  if (eta <= model.strips[first]!.eta) return { i0: first, i1: first, t: 0, nearest: first };
  if (eta >= model.strips[last]!.eta) return { i0: last, i1: last, t: 0, nearest: last };
  for (let k = 1; k < order.length; k++) {
    const i1 = order[k]!;
    const e1 = model.strips[i1]!.eta;
    if (eta <= e1) {
      const i0 = order[k - 1]!;
      const e0 = model.strips[i0]!.eta;
      const t = e1 > e0 ? (eta - e0) / (e1 - e0) : 0;
      return { i0, i1, t, nearest: t < 0.5 ? i0 : i1 };
    }
  }
  return { i0: last, i1: last, t: 0, nearest: last };
}

/**
 * 2D flow around the right wing's section at `eta` (0 root .. 1 tip), at the effective angle the
 * 3D solution gives there: geometric (alpha + local twist) minus the induced downwash angle.
 * The induced angle is taken as geometric - effective of the coupled solution, so the section
 * view carries the same lift as the 3D strip it represents.
 */
export function computeSection(
  wing: WingConfig,
  flow: FlowConditions,
  eta: number,
  cache: AeroCache,
): SectionFlow {
  const state = solveState(wing, flow, cache);
  const { entry, solution: sol, airfoils } = state;
  const { model } = entry;
  const etaClamped = Math.min(1, Math.max(0, Number.isFinite(eta) ? eta : 0));
  if (entry.rightWingStrips.length === 0) throw new Error('computeSection: no right wing strips');

  if (state.section && state.section.eta === etaClamped) return state.section.flow;

  const { i0, i1, t, nearest } = interpolateStrips(model, entry.rightWingStrips, etaClamped);
  const lerp = (arr: Float64Array): number => arr[i0]! + (arr[i1]! - arr[i0]!) * t;
  const alphaGeometric = lerp(state.stripAlphaGeometric);
  const alphaEffective = lerp(sol.stripAlphaEffective);
  const reynolds = lerp(state.stripReynolds);

  const flowResult = computeSectionFlow(airfoils[nearest]!, {
    eta: etaClamped,
    alphaGeometric,
    alphaInduced: alphaGeometric - alphaEffective,
    reynolds,
  });
  state.section = { eta: etaClamped, flow: flowResult };
  return flowResult;
}
