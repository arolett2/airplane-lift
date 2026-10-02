/**
 * Airfoil module facade: memoised geometry + panel solver + polar per section definition.
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 */
import type { AirfoilGeometry, ChordwiseCp, FlapState, Naca4Params, SectionPolar } from '../types';
import type { LinearVortexPanelSolver, PanelSolver } from './panel';
import { createPanelSolver } from './panel';
import type { ViscousSectionPolar } from './polar';
import { createSectionPolar } from './polar';
import { generateAirfoil } from './naca';

export interface AirfoilKey {
  params: Naca4Params;
  flap: FlapState | null;
  slat: boolean;
  supercritical: boolean;
}

export interface AirfoilModel {
  key: AirfoilKey;
  geometry: AirfoilGeometry;
  solver: PanelSolver;
  polar: SectionPolar;
  /**
   * Chordwise surface Cp at an effective angle of attack, with the upper-surface pressure
   * flattened aft of the separation point when stalled. When `targetCl` is given the Cp
   * difference is scaled so the section integrates to that cl (quasi-3D colouring).
   * @param nStations number of cosine-spaced x/c stations (default 41)
   */
  chordwiseCp(
    alphaEffective: number,
    reynolds: number,
    nStations?: number,
    targetCl?: number,
  ): ChordwiseCp;
}

/** What getAirfoilModel actually returns: the contract plus typed access to the internals. */
export interface AirfoilModelInternal extends AirfoilModel {
  solver: LinearVortexPanelSolver;
  polar: ViscousSectionPolar;
  /**
   * Equivalent inviscid angle: the angle at which the panel method (Kutta condition) produces
   * the viscous cl of the polar at alphaEffective. Used for Cp shapes.
   */
  equivalentInviscidAlpha(alphaEffective: number, reynolds: number): number;
}

/** Panels used for every memoised airfoil model. */
export const MODEL_PANELS = 140;
/**
 * Models kept in the LRU. A wing whose airfoil varies along the span needs one model per strip
 * (24 per semispan, plus tip-device strips, the section view and the polar sweep), so a
 * capacity near that working set makes every update miss and rebuild all of them (~2 ms each).
 * A model retains ~80 KB, so 128 of them cost ~10 MB.
 */
export const LRU_CAPACITY = 128;

/** Thinnest section actually modelled (the contract range starts at 0.03). */
const MIN_THICKNESS = 0.005;

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Canonical cache key: numbers rounded to 1e-5, irrelevant fields normalised away. */
export function airfoilKeyString(key: AirfoilKey): string {
  const p = key.params;
  const camber = round5(Math.max(0, p.camber));
  const flap =
    key.flap && round5(key.flap.deflection) !== 0 && round5(key.flap.chordFrac) > 0
      ? { c: round5(key.flap.chordFrac), d: round5(key.flap.deflection) }
      : null;
  return JSON.stringify({
    m: camber,
    p: camber === 0 ? 0 : round5(p.camberPos),
    t: round5(p.thickness),
    f: flap,
    s: key.slat,
    sc: key.supercritical,
  });
}

const cache = new Map<string, AirfoilModelInternal>();

/** Memoised (small LRU) — calling repeatedly with an equal key returns the same model. */
export function getAirfoilModel(key: AirfoilKey): AirfoilModelInternal {
  const k = airfoilKeyString(key);
  const hit = cache.get(k);
  if (hit) {
    // Refresh recency.
    cache.delete(k);
    cache.set(k, hit);
    return hit;
  }
  const model = buildAirfoilModel(key);
  cache.set(k, model);
  if (cache.size > LRU_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return model;
}

/** Drop all memoised models (tests, memory pressure). */
export function clearAirfoilModelCache(): void {
  cache.clear();
}

/**
 * Precomputed sampling of control-point values at cosine-spaced x/c stations.
 * Values are read from an extended array: indices 0..n-1 are control points, n is the leading
 * edge (mean of the two control points around the LE node) and n+1 the trailing edge.
 */
interface StationTable {
  xc: Float32Array;
  upperA: Int32Array;
  upperB: Int32Array;
  upperW: Float64Array;
  lowerA: Int32Array;
  lowerB: Int32Array;
  lowerW: Float64Array;
  /** Trapezoid weights for integrating over x/c. */
  dx: Float64Array;
}

function buildStationTable(geometry: AirfoilGeometry, nStations: number): StationTable {
  const n = geometry.nPoints - 1;
  const le = geometry.leIndex;
  const xy = geometry.coords;
  const cpx = (i: number) => 0.5 * (xy[2 * i]! + xy[2 * i + 2]!);
  // Paths from LE to TE as (x, value index) sequences.
  const upper: [number, number][] = [[0, n]];
  for (let i = le; i < n; i++) upper.push([cpx(i), i]);
  upper.push([1, n + 1]);
  const lower: [number, number][] = [[0, n]];
  for (let i = le - 1; i >= 0; i--) lower.push([cpx(i), i]);
  lower.push([1, n + 1]);

  const ns = Math.max(2, Math.floor(nStations));
  const t: StationTable = {
    xc: new Float32Array(ns),
    upperA: new Int32Array(ns),
    upperB: new Int32Array(ns),
    upperW: new Float64Array(ns),
    lowerA: new Int32Array(ns),
    lowerB: new Int32Array(ns),
    lowerW: new Float64Array(ns),
    dx: new Float64Array(ns),
  };
  const locate = (path: [number, number][], x: number): [number, number, number] => {
    for (let i = 0; i < path.length - 1; i++) {
      const [x0, i0] = path[i]!;
      const [x1, i1] = path[i + 1]!;
      const lo = Math.min(x0, x1);
      const hi = Math.max(x0, x1);
      if (x >= lo && x <= hi) {
        const w = hi > lo ? (x - x0) / (x1 - x0) : 0;
        return [i0, i1, w];
      }
    }
    const last = path[path.length - 1]!;
    return x <= 0 ? [n, n, 0] : [last[1], last[1], 0];
  };
  const xs = new Float64Array(ns);
  for (let k = 0; k < ns; k++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * k) / (ns - 1)));
    xs[k] = x;
    t.xc[k] = x;
    [t.upperA[k], t.upperB[k], t.upperW[k]] = locate(upper, x);
    [t.lowerA[k], t.lowerB[k], t.lowerW[k]] = locate(lower, x);
  }
  for (let k = 0; k < ns; k++) {
    const left = k > 0 ? xs[k]! - xs[k - 1]! : 0;
    const right = k < ns - 1 ? xs[k + 1]! - xs[k]! : 0;
    t.dx[k] = 0.5 * (left + right);
  }
  return t;
}

/** Identity above Cp = -6, then a smooth knee that never goes below -12. */
function softSuctionLimit(cp: number): number {
  const knee = -6;
  if (cp >= knee) return cp;
  return knee - 6 * Math.tanh((knee - cp) / 6);
}

function buildAirfoilModel(key: AirfoilKey): AirfoilModelInternal {
  // A zero-thickness contour makes the panel matrix singular (luFactor throws, which would take
  // the whole aero update down); keep a sliver of thickness for out-of-contract inputs.
  const params = { ...key.params, thickness: Math.max(MIN_THICKNESS, key.params.thickness) };
  const geometry = generateAirfoil(params, MODEL_PANELS, key.flap);
  const solver = createPanelSolver(geometry);
  const polar = createSectionPolar(params, solver, {
    flap: key.flap,
    slat: key.slat,
    supercritical: key.supercritical,
  });
  const n = solver.nPanels;
  const tables = new Map<number, StationTable>();
  // Scratch buffers (models are used from one thread at a time).
  const speed = new Float64Array(n);
  const values = new Float64Array(n + 2);

  const equivalentInviscidAlpha = (alphaEffective: number, reynolds: number) => {
    const cl = polar.cl(alphaEffective, reynolds);
    const ratio = Math.max(-1, Math.min(1, cl / solver.liftSlope));
    return solver.alphaZeroLift + Math.asin(ratio);
  };

  const chordwiseCp = (
    alphaEffective: number,
    reynolds: number,
    nStations = 41,
    targetCl?: number,
  ): ChordwiseCp => {
    let table = tables.get(nStations);
    if (!table) {
      table = buildStationTable(geometry, nStations);
      tables.set(nStations, table);
    }
    const ns = table.xc.length;
    const f = polar.attachedFraction(alphaEffective, reynolds);
    const severity = f < 1 ? Math.min(1, (1 - f) / 0.9) : 0;
    // Attached flow: the Cp shape of the equivalent inviscid angle (same cl as the polar).
    // Separated flow: the nose still sees the true incidence (stagnation point under the nose,
    // suction around it) and the lost lift shows up in the flat separated plateau instead. The
    // equivalent angle of a stalled flapped or highly cambered section is far below the true one
    // and puts the stagnation point on its upper surface, which turns the plateau into a high
    // pressure and the section's Cp lift negative. Blend towards the true angle with severity.
    const alphaEq = equivalentInviscidAlpha(alphaEffective, reynolds);
    solver.surfaceSpeedInto(alphaEq + severity * (alphaEffective - alphaEq), speed);
    for (let i = 0; i < n; i++) values[i] = 1 - speed[i]! * speed[i]!;
    const le = geometry.leIndex;
    values[n] = 0.5 * (values[le - 1]! + values[le]!);
    values[n + 1] = 0.5 * (values[0]! + values[n - 1]!);

    const upper = new Float32Array(ns);
    const lower = new Float32Array(ns);
    for (let k = 0; k < ns; k++) {
      const wu = table.upperW[k]!;
      upper[k] = (1 - wu) * values[table.upperA[k]!]! + wu * values[table.upperB[k]!]!;
      const wl = table.lowerW[k]!;
      lower[k] = (1 - wl) * values[table.lowerA[k]!]! + wl * values[table.lowerB[k]!]!;
    }

    // Real boundary layers never sustain the enormous inviscid suction peaks of very thin or
    // sharply cambered/flapped sections; soften anything beyond Cp = -6 towards -12.
    for (let k = 0; k < ns; k++) {
      upper[k] = softSuctionLimit(upper[k]!);
      lower[k] = softSuctionLimit(lower[k]!);
    }

    // Separation: soften the leading-edge suction peak and flatten the suction side aft of
    // x_sep. At high incidence the peak wraps round the nose onto the other surface (ahead of
    // the stagnation point), so the softening applies to both surfaces.
    if (f < 1) {
      const suction = alphaEffective >= polar.alphaZeroLift ? upper : lower;
      const limit = 8 - 6.8 * severity; // suction-peak limiter scale (Cp units)
      for (const side of [upper, lower]) {
        for (let k = 0; k < ns; k++) {
          const cp = side[k]!;
          if (cp < 0) side[k] = cp + severity * (-limit * Math.tanh(-cp / limit) - cp);
        }
      }
      const xSep = f;
      let plateau = NaN;
      for (let k = 0; k < ns; k++) {
        const x = table.xc[k]!;
        if (x < xSep) continue;
        if (Number.isNaN(plateau)) {
          // Cp at x_sep, interpolated from the station just ahead.
          const x0 = k > 0 ? table.xc[k - 1]! : x;
          const c0 = k > 0 ? suction[k - 1]! : suction[k]!;
          const w = x > x0 ? (xSep - x0) / (x - x0) : 0;
          plateau = c0 + w * (suction[k]! - c0);
        }
        suction[k] = plateau;
      }
    }

    if (targetCl !== undefined && Number.isFinite(targetCl)) {
      let cl = 0;
      for (let k = 0; k < ns; k++) cl += (lower[k]! - upper[k]!) * table.dx[k]!;
      let scale = Math.abs(cl) > 1e-9 ? targetCl / cl : targetCl === 0 ? 0 : 3;
      scale = Math.max(0, Math.min(3, scale));
      for (let k = 0; k < ns; k++) {
        const mean = 0.5 * (upper[k]! + lower[k]!);
        const half = 0.5 * (lower[k]! - upper[k]!) * scale;
        upper[k] = mean - half;
        lower[k] = mean + half;
      }
    }
    return { xc: table.xc.slice(), upper, lower };
  };

  const ownKey: AirfoilKey = {
    params: { ...key.params },
    flap: key.flap ? { ...key.flap } : null,
    slat: key.slat,
    supercritical: key.supercritical,
  };
  return { key: ownKey, geometry, solver, polar, chordwiseCp, equivalentInviscidAlpha };
}
