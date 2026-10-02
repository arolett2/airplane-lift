/**
 * 2D flow around one wing section for the cross-section view: velocity grid, streamlines with
 * travel times (for timeline pulses), Cp, stagnation point.
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 *
 * Attached flow: inviscid panel-method flow at the effective angle of attack (Kutta condition).
 *
 * Separated flow (ILLUSTRATIVE): when the polar says the suction side has separated, the
 * "dead-air" region is modelled as a displacement body, the classic free-streamline picture of
 * stall. From the separation point x_sep (= attachedFraction) a shear line leaves the surface
 * tangentially and turns into the freestream direction; a second line leaves the trailing edge;
 * both run downstream and close in a cusp about a bubble-height or two behind the TE. The panel
 * method then solves the flow around airfoil + bubble with the Kutta condition at the cusp, so
 * the outer streamlines detour around the separated region, the circulation drops, and the
 * air inside the bubble is (nearly) at rest. A gentle recirculation is drawn inside the bubble
 * so particles there drift instead of freezing. The real separated wake does not close and its
 * pressure is not given by Bernoulli; this is a teaching picture, not a viscous solution.
 */
import type { AirfoilGeometry, PanelSolution, SectionFlow, Streamline2D } from '../types';
import type { AirfoilModel } from './index';
import type { PanelSolver } from './panel';
import { createPanelSolver } from './panel';
import type { ViscousSectionPolar } from './polar';

export interface SectionFlowInput {
  eta: number;
  alphaGeometric: number; // rad (root alpha + local twist + flap-free incidence)
  alphaInduced: number; // rad
  reynolds: number;
}

export interface SectionFlowOptions {
  /** Grid resolution (default 160 x 96) over the default window x in [-0.6, 1.8], y in [-0.6, 0.6]. */
  nx?: number;
  ny?: number;
  /** Number of streamlines seeded upstream (default 28). */
  streamlines?: number;
}

/** SectionFlow plus an optional per-node "separated" weight (0 attached .. 1 dead air). */
export interface SectionFlowDetailed extends SectionFlow {
  /**
   * Per grid node (length nx*ny): 1 inside the separated dead-air bubble, else 0. In there the
   * pressure is roughly the (low) base pressure, NOT 1 - |V|^2, so colour it accordingly.
   */
  separated: Uint8Array;
}

/** Window of the section view in the airfoil frame (chords). */
export const SECTION_WINDOW = { xMin: -0.6, xMax: 1.8, yMin: -0.6, yMax: 0.6 } as const;

const DEFAULT_NX = 160;
const DEFAULT_NY = 96;
const DEFAULT_STREAMLINES = 28;
/** Upstream distance (chords, from the quarter chord) of the line streamlines start from. */
const SEED_UPSTREAM = 0.85;
/** Nearest seed offset from the stagnation streamline (chords, far upstream). */
const SEED_GAP = 0.008;
const MAX_POINTS = 2500;
const MAX_TIME = 30;
/** Cells closer than this to the body use exact velocities instead of the bilinear grid. */
const NEAR_BODY = 0.07;
const DS_MIN = 0.0025;
const DS_MAX = 0.02;
const DS_OUTSIDE = 0.03;
/** Minimum bubble height (chords) for drawing a separated region. */
const MIN_BUBBLE = 0.012;
/** Peak speed of the illustrative recirculation inside the bubble (fraction of V_inf). */
const RECIRCULATION = 0.12;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------------------------------ */
/* Polygon queries                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Closed polygon (clockwise, first point repeated at the end) with inside/nearest queries. */
class Polygon {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly count: number; // number of edges
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;

  constructor(coords: Float64Array, nPoints: number) {
    this.xs = new Float64Array(nPoints);
    this.ys = new Float64Array(nPoints);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < nPoints; i++) {
      const x = coords[2 * i]!;
      const y = coords[2 * i + 1]!;
      this.xs[i] = x;
      this.ys[i] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.count = nPoints - 1;
    this.minX = minX;
    this.maxX = maxX;
    this.minY = minY;
    this.maxY = maxY;
  }

  /** Point-in-polygon by crossing number. */
  contains(x: number, y: number): boolean {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    let inside = false;
    const xs = this.xs;
    const ys = this.ys;
    for (let i = 0; i < this.count; i++) {
      const y0 = ys[i]!;
      const y1 = ys[i + 1]!;
      if (y0 > y !== y1 > y) {
        const xc = xs[i]! + ((y - y0) * (xs[i + 1]! - xs[i]!)) / (y1 - y0);
        if (x < xc) inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Distance to the boundary. Writes [px, py, nx, ny] into `out`: the nearest boundary point
   * and the outward normal of its edge.
   */
  nearest(x: number, y: number, out: Float64Array): number {
    let best = Infinity;
    const xs = this.xs;
    const ys = this.ys;
    for (let i = 0; i < this.count; i++) {
      const ax = xs[i]!;
      const ay = ys[i]!;
      const ex = xs[i + 1]! - ax;
      const ey = ys[i + 1]! - ay;
      const l2 = ex * ex + ey * ey;
      if (l2 <= 0) continue;
      const t = clamp(((x - ax) * ex + (y - ay) * ey) / l2, 0, 1);
      const px = ax + t * ex;
      const py = ay + t * ey;
      const d2 = (x - px) ** 2 + (y - py) ** 2;
      if (d2 < best) {
        best = d2;
        const l = Math.sqrt(l2);
        out[0] = px;
        out[1] = py;
        out[2] = -ey / l; // outward normal of a clockwise contour
        out[3] = ex / l;
      }
    }
    return Math.sqrt(best);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Separated-flow displacement body                                                           */
/* ------------------------------------------------------------------------------------------ */

interface Bubble {
  geometry: AirfoilGeometry;
  /** Bubble frame: origin at the separation point, xi along the freestream, eta away from the wall. */
  ox: number;
  oy: number;
  ex: number;
  ey: number;
  nx: number;
  ny: number;
  /** Upper (shear-line) and lower (wall / TE wake line) boundary heights eta(xi), sampled. */
  xiStart: number;
  xiEnd: number;
  upperEta: (xi: number) => number;
  /** Polygon of the dead-air region only (excluding the airfoil). */
  region: Polygon;
}

/** Interpolate the contour (between consecutive nodes) where x first crosses xTarget. */
function surfaceCrossing(
  coords: Float64Array,
  from: number,
  step: 1 | -1,
  to: number,
  xTarget: number,
): { x: number; y: number; next: number; tx: number; ty: number } | null {
  for (let i = from; i !== to; i += step) {
    const x0 = coords[2 * i]!;
    const x1 = coords[2 * (i + step)]!;
    if ((x0 - xTarget) * (x1 - xTarget) <= 0 && x1 !== x0) {
      const w = (xTarget - x0) / (x1 - x0);
      const y0 = coords[2 * i + 1]!;
      const y1 = coords[2 * (i + step) + 1]!;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const l = Math.hypot(dx, dy);
      return { x: x0 + w * dx, y: y0 + w * dy, next: i + step, tx: dx / l, ty: dy / l };
    }
  }
  return null;
}

/** Cosine-clustered samples of [a, b] (dense at both ends), n intervals, endpoints included. */
function cosineSamples(a: number, b: number, n: number): Float64Array {
  const out = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = a + (b - a) * 0.5 * (1 - Math.cos((Math.PI * i) / n));
  return out;
}

/**
 * Build the airfoil + dead-air displacement body, or null when the separated region is too
 * thin to matter (or the geometry is degenerate).
 */
function buildBubble(
  base: AirfoilGeometry,
  alpha: number,
  suctionUpper: boolean,
  xSep: number,
): Bubble | null {
  const coords = base.coords;
  const last = base.nPoints - 1;
  const le = base.leIndex;
  const sep = suctionUpper
    ? surfaceCrossing(coords, le, 1, last, xSep)
    : surfaceCrossing(coords, le, -1, 0, xSep);
  if (!sep) return null;
  const ex = Math.cos(alpha);
  const ey = Math.sin(alpha);
  const side = suctionUpper ? 1 : -1;
  const nx = -side * ey;
  const ny = side * ex;
  const sx = sep.x;
  const sy = sep.y;
  const xiOf = (x: number, y: number) => (x - sx) * ex + (y - sy) * ey;
  const etaOf = (x: number, y: number) => (x - sx) * nx + (y - sy) * ny;
  const tex = coords[0]!;
  const tey = coords[1]!;
  const xiT = xiOf(tex, tey);
  const etaT = etaOf(tex, tey);
  if (!(xiT > 0.02) || !(etaT < -MIN_BUBBLE)) return null;

  // Downstream surface directions as slopes d(eta)/d(xi): suction side at S (along the contour
  // direction for the upper side, against it for the lower side), other side at the TE.
  const sdx = sep.tx; // already points downstream (towards the TE) on either side
  const sdy = sep.ty;
  const sDot = sdx * ex + sdy * ey;
  const slopeS = clamp((sdx * nx + sdy * ny) / Math.max(0.2, sDot), -1.5, 0);
  // Non-suction side at the TE: lower surface runs TE->LE from node 0, upper ends at node last.
  const o = suctionUpper ? 1 : last - 1;
  const tdx = tex - coords[2 * o]!;
  const tdy = tey - coords[2 * o + 1]!;
  const tDot = tdx * ex + tdy * ey;
  const slopeT = clamp((tdx * nx + tdy * ny) / Math.max(0.2 * Math.hypot(tdx, tdy), tDot), -1, 1);

  // Boundary heights: leave tangentially, relax to the freestream direction over xiB.
  const xiB = 0.05;
  const u0 = (xi: number) => slopeS * xiB * (1 - Math.exp(-xi / xiB));
  const l0 = (xi: number) => etaT + slopeT * xiB * (1 - Math.exp(-(xi - xiT) / xiB));
  const height = u0(xiT) - etaT;
  if (!(height > MIN_BUBBLE)) return null;
  const xiHold = xiT + clamp(1.5 * height, 0.08, 0.5);
  const tail = clamp(2.5 * height, 0.12, 0.9);
  const xiC = xiHold + tail;
  const etaMid = 0.5 * (u0(xiHold) + l0(xiHold));
  const taper = (xi: number) =>
    xi <= xiHold ? 1 : 0.5 * (1 + Math.cos((Math.PI * Math.min(xi - xiHold, tail)) / tail));
  const upperEta = (xi: number) => etaMid + (u0(xi) - etaMid) * taper(xi);
  const lowerEta = (xi: number) => etaMid + (l0(xi) - etaMid) * taper(xi);
  const toX = (xi: number, eta: number) => sx + xi * ex + eta * nx;
  const toY = (xi: number, eta: number) => sy + xi * ey + eta * ny;

  const nShear = clamp(Math.ceil(xiC / 0.022) + 6, 14, 90);
  const nWake = clamp(Math.ceil((xiC - xiT) / 0.022) + 6, 10, 90);
  const shear = cosineSamples(0, xiC, nShear); // S .. C
  const wake = cosineSamples(xiT, xiC, nWake); // TE .. C

  // Assemble the clockwise contour starting and ending at the cusp C.
  const pts: number[] = [];
  const push = (x: number, y: number) => {
    const n = pts.length;
    if (n >= 2 && Math.hypot(x - pts[n - 2]!, y - pts[n - 1]!) < 1e-6) return;
    pts.push(x, y);
  };
  const cx = toX(xiC, etaMid);
  const cy = toY(xiC, etaMid);
  push(cx, cy);
  let leIndex: number;
  if (suctionUpper) {
    // Lower boundary: TE wake line back to the TE, then the airfoil lower surface to the LE.
    for (let i = nWake - 1; i >= 1; i--)
      push(toX(wake[i]!, lowerEta(wake[i]!)), toY(wake[i]!, lowerEta(wake[i]!)));
    for (let i = 0; i <= le; i++) push(coords[2 * i]!, coords[2 * i + 1]!);
    leIndex = pts.length / 2 - 1;
    // Upper boundary: airfoil upper surface up to S, then the shear line to C.
    for (let i = le + 1; i < sep.next; i++) push(coords[2 * i]!, coords[2 * i + 1]!);
    push(sx, sy);
    for (let i = 1; i < nShear; i++)
      push(toX(shear[i]!, upperEta(shear[i]!)), toY(shear[i]!, upperEta(shear[i]!)));
  } else {
    // Lower boundary: shear line from C back to S, then the lower surface from S to the LE.
    for (let i = nShear - 1; i >= 1; i--)
      push(toX(shear[i]!, upperEta(shear[i]!)), toY(shear[i]!, upperEta(shear[i]!)));
    push(sx, sy);
    for (let i = sep.next + 1; i <= le; i++) push(coords[2 * i]!, coords[2 * i + 1]!);
    leIndex = pts.length / 2 - 1;
    // Upper boundary: whole upper surface to the TE, then the TE wake line to C.
    for (let i = le + 1; i <= last; i++) push(coords[2 * i]!, coords[2 * i + 1]!);
    for (let i = 1; i < nWake; i++)
      push(toX(wake[i]!, lowerEta(wake[i]!)), toY(wake[i]!, lowerEta(wake[i]!)));
  }
  pts.push(cx, cy);
  const nPoints = pts.length / 2;
  const geometry: AirfoilGeometry = {
    coords: Float64Array.from(pts),
    nPoints,
    leIndex,
    params: base.params,
    flap: base.flap,
  };

  // Dead-air region polygon (clockwise): wall/TE-wake side below, shear line above.
  const region: number[] = [];
  if (suctionUpper) {
    for (let i = nWake; i >= 1; i--)
      region.push(toX(wake[i]!, lowerEta(wake[i]!)), toY(wake[i]!, lowerEta(wake[i]!)));
    for (let i = last; i >= sep.next; i--) region.push(coords[2 * i]!, coords[2 * i + 1]!);
    region.push(sx, sy);
    for (let i = 1; i <= nShear; i++)
      region.push(toX(shear[i]!, upperEta(shear[i]!)), toY(shear[i]!, upperEta(shear[i]!)));
  } else {
    for (let i = nShear; i >= 1; i--)
      region.push(toX(shear[i]!, upperEta(shear[i]!)), toY(shear[i]!, upperEta(shear[i]!)));
    region.push(sx, sy);
    for (let i = sep.next; i >= 0; i--) region.push(coords[2 * i]!, coords[2 * i + 1]!);
    for (let i = 1; i <= nWake; i++)
      region.push(toX(wake[i]!, lowerEta(wake[i]!)), toY(wake[i]!, lowerEta(wake[i]!)));
  }
  region.push(region[0]!, region[1]!);

  return {
    geometry,
    ox: sx,
    oy: sy,
    ex,
    ey,
    nx,
    ny,
    xiStart: 0,
    xiEnd: xiC,
    upperEta,
    region: new Polygon(Float64Array.from(region), region.length / 2),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Main entry                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export function computeSectionFlow(
  model: AirfoilModel,
  input: SectionFlowInput,
  options: SectionFlowOptions = {},
): SectionFlowDetailed {
  const re = Number.isFinite(input.reynolds) && input.reynolds > 0 ? input.reynolds : 6e6;
  const alphaE = input.alphaGeometric - input.alphaInduced;
  const polar = model.polar as Partial<ViscousSectionPolar> & typeof model.polar;
  const cl = polar.cl(alphaE, re);
  const attachedFraction = polar.attachedFraction(alphaE, re);
  const stalled = polar.isStalled ? polar.isStalled(alphaE, re) : alphaE > polar.alphaStall(re);
  const severity = clamp((1 - attachedFraction) / 0.9, 0, 1);
  const suctionUpper = alphaE >= polar.alphaZeroLift;

  // ---- Flow model: airfoil alone, or airfoil + separated displacement bubble ------------
  let solver: PanelSolver = model.solver;
  let bubble: Bubble | null = null;
  if (severity > 0 && Math.abs(alphaE) < (80 * Math.PI) / 180) {
    bubble = buildBubble(model.geometry, alphaE, suctionUpper, clamp(attachedFraction, 0.03, 0.97));
    if (bubble) {
      try {
        solver = createPanelSolver(bubble.geometry);
      } catch {
        bubble = null;
        solver = model.solver;
      }
    }
  }
  const solution: PanelSolution = solver.solve(alphaE);
  const body = new Polygon(model.geometry.coords, model.geometry.nPoints);
  const outer = bubble ? new Polygon(bubble.geometry.coords, bubble.geometry.nPoints) : body;

  const vel: [number, number] = [0, 0];
  /** Exact flow velocity (V_inf = 1) at a point, including the bubble recirculation. */
  const velocity = (x: number, y: number, out: [number, number]) => {
    solver.velocityAt(solution, x, y, out);
    if (bubble && bubble.region.contains(x, y)) {
      // Illustrative recirculation: forward under the shear layer, reversed along the wall.
      const xi = (x - bubble.ox) * bubble.ex + (y - bubble.oy) * bubble.ey;
      const eta = (x - bubble.ox) * bubble.nx + (y - bubble.oy) * bubble.ny;
      const top = bubble.upperEta(xi);
      const depth = clamp((top - eta) / 0.12, 0, 1); // 0 at the shear layer, 1 deep inside
      const along = clamp(xi / Math.max(1e-6, bubble.xiEnd), 0, 1);
      const envelope = Math.sin(Math.PI * along);
      const u = RECIRCULATION * envelope * (1 - 2 * depth) * severity;
      out[0] = 0.25 * out[0] + u * bubble.ex;
      out[1] = 0.25 * out[1] + u * bubble.ey;
    }
  };

  // ---- Grid --------------------------------------------------------------------------
  const W = SECTION_WINDOW;
  const nx = Math.max(2, Math.floor(options.nx ?? DEFAULT_NX));
  const ny = Math.max(2, Math.floor(options.ny ?? DEFAULT_NY));
  const dx = (W.xMax - W.xMin) / (nx - 1);
  const dy = (W.yMax - W.yMin) / (ny - 1);
  const uv = new Float32Array(2 * nx * ny);
  const inside = new Uint8Array(nx * ny);
  const separated = new Uint8Array(nx * ny);
  /** Distance to the outer (airfoil or airfoil + bubble) body, capped at NEAR_BODY * 2. */
  const dist = new Float32Array(nx * ny);
  const near = new Float64Array(4);
  const cap = 2 * NEAR_BODY;
  for (let j = 0; j < ny; j++) {
    const y = W.yMin + j * dy;
    for (let i = 0; i < nx; i++) {
      const x = W.xMin + i * dx;
      const k = i + nx * j;
      const inBox =
        x > outer.minX - cap &&
        x < outer.maxX + cap &&
        y > outer.minY - cap &&
        y < outer.maxY + cap;
      dist[k] = inBox ? Math.min(cap, outer.nearest(x, y, near)) : cap;
      if (body.contains(x, y)) {
        inside[k] = 1;
        dist[k] = 0;
        continue; // uv stays 0 inside the airfoil
      }
      if (bubble && bubble.region.contains(x, y)) {
        separated[k] = 1;
        dist[k] = 0;
      }
      velocity(x, y, vel);
      uv[2 * k] = vel[0];
      uv[2 * k + 1] = vel[1];
    }
  }
  // Cells that need exact velocities: any corner near the body (or in the bubble).
  const exactCell = new Uint8Array((nx - 1) * (ny - 1));
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = i + nx * j;
      const m = Math.min(dist[k]!, dist[k + 1]!, dist[k + nx]!, dist[k + nx + 1]!);
      if (m < NEAR_BODY) exactCell[i + (nx - 1) * j] = 1;
    }
  }

  /** Velocity for tracing: bilinear grid far from the body, exact near it / off-grid. */
  const sample = (x: number, y: number, out: [number, number]): number => {
    const fx = (x - W.xMin) / dx;
    const fy = (y - W.yMin) / dy;
    if (fx >= 0 && fy >= 0 && fx < nx - 1 && fy < ny - 1) {
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const k = i + nx * j;
      const tx = fx - i;
      const ty = fy - j;
      const d =
        (1 - ty) * ((1 - tx) * dist[k]! + tx * dist[k + 1]!) +
        ty * ((1 - tx) * dist[k + nx]! + tx * dist[k + nx + 1]!);
      if (exactCell[i + (nx - 1) * j]) {
        velocity(x, y, out);
      } else {
        const a = 2 * k;
        const b = 2 * (k + 1);
        const c = 2 * (k + nx);
        const e = 2 * (k + nx + 1);
        out[0] =
          (1 - ty) * ((1 - tx) * uv[a]! + tx * uv[b]!) + ty * ((1 - tx) * uv[c]! + tx * uv[e]!);
        out[1] =
          (1 - ty) * ((1 - tx) * uv[a + 1]! + tx * uv[b + 1]!) +
          ty * ((1 - tx) * uv[c + 1]! + tx * uv[e + 1]!);
      }
      return clamp(0.3 * d, DS_MIN, DS_MAX);
    }
    velocity(x, y, out);
    return DS_OUTSIDE;
  };

  // ---- Streamlines ---------------------------------------------------------------------
  const ex = Math.cos(alphaE);
  const ey = Math.sin(alphaE);
  const nrmX = -ey;
  const nrmY = ex;
  const qx = 0.25 - SEED_UPSTREAM * ex;
  const qy = -SEED_UPSTREAM * ey;
  const inWindow = (x: number, y: number) =>
    x >= W.xMin && x <= W.xMax && y >= W.yMin && y <= W.yMax;

  const bufX = new Float64Array(MAX_POINTS);
  const bufY = new Float64Array(MAX_POINTS);
  const bufS = new Float64Array(MAX_POINTS);
  const bufT = new Float64Array(MAX_POINTS);
  const v1: [number, number] = [0, 0];
  const v2: [number, number] = [0, 0];
  const v3: [number, number] = [0, 0];
  const v4: [number, number] = [0, 0];

  /**
   * One RK4 step along arc length from (x, y) with the velocity at the start already in v1.
   * Returns [x', y', dt]. `sign` = -1 integrates upstream.
   */
  const step = (x: number, y: number, ds: number, sign: number, res: Float64Array) => {
    const s1 = Math.max(1e-6, Math.hypot(v1[0], v1[1]));
    const d1x = (sign * v1[0]) / s1;
    const d1y = (sign * v1[1]) / s1;
    sample(x + 0.5 * ds * d1x, y + 0.5 * ds * d1y, v2);
    const s2 = Math.max(1e-6, Math.hypot(v2[0], v2[1]));
    const d2x = (sign * v2[0]) / s2;
    const d2y = (sign * v2[1]) / s2;
    sample(x + 0.5 * ds * d2x, y + 0.5 * ds * d2y, v3);
    const s3 = Math.max(1e-6, Math.hypot(v3[0], v3[1]));
    const d3x = (sign * v3[0]) / s3;
    const d3y = (sign * v3[1]) / s3;
    sample(x + ds * d3x, y + ds * d3y, v4);
    const s4 = Math.max(1e-6, Math.hypot(v4[0], v4[1]));
    const d4x = (sign * v4[0]) / s4;
    const d4y = (sign * v4[1]) / s4;
    res[0] = x + (ds / 6) * (d1x + 2 * d2x + 2 * d3x + d4x);
    res[1] = y + (ds / 6) * (d1y + 2 * d2y + 2 * d3y + d4y);
    const inv = (s: number) => 1 / Math.max(0.02, s);
    res[2] = (ds / 6) * (inv(s1) + 2 * inv(s2) + 2 * inv(s3) + inv(s4));
  };

  /** Keep a point out of the (outer) body: push it to just outside the nearest surface. */
  const keepOutside = (res: Float64Array) => {
    if (!outer.contains(res[0]!, res[1]!)) return;
    outer.nearest(res[0]!, res[1]!, near);
    res[0] = near[0]! + 0.002 * near[2]!;
    res[1] = near[1]! + 0.002 * near[3]!;
  };

  const res = new Float64Array(3);

  /** Trace downstream from a seed on the seed line; null if it never enters the window. */
  const trace = (sx: number, sy: number): Streamline2D | null => {
    let x = sx;
    let y = sy;
    let t = 0;
    let count = 0;
    let travelled = 0;
    let prevX = x;
    let prevY = y;
    let prevT = 0;
    let prevS = 1;
    let wasIn = false;
    for (let it = 0; it < 4 * MAX_POINTS; it++) {
      const ds = sample(x, y, v1);
      const speed = Math.hypot(v1[0], v1[1]);
      const isIn = inWindow(x, y);
      if (isIn) {
        if (!wasIn && it > 0) {
          // Entering: add the boundary point first.
          const f = boxCrossing(x, y, prevX, prevY);
          bufX[count] = x + f * (prevX - x);
          bufY[count] = y + f * (prevY - y);
          bufS[count] = speed + f * (prevS - speed);
          bufT[count] = t + f * (prevT - t);
          count++;
        }
        bufX[count] = x;
        bufY[count] = y;
        bufS[count] = speed;
        bufT[count] = t;
        count++;
        wasIn = true;
      } else if (wasIn) {
        // Leaving: end exactly on the window boundary.
        const f = boxCrossing(prevX, prevY, x, y);
        bufX[count] = prevX + f * (x - prevX);
        bufY[count] = prevY + f * (y - prevY);
        bufS[count] = prevS + f * (speed - prevS);
        bufT[count] = prevT + f * (t - prevT);
        count++;
        break;
      } else if (travelled > 4) {
        return null;
      }
      if (count >= MAX_POINTS - 2 || t > MAX_TIME) break;
      prevX = x;
      prevY = y;
      prevT = t;
      prevS = speed;
      step(x, y, ds, 1, res);
      keepOutside(res);
      x = res[0]!;
      y = res[1]!;
      t += res[2]!;
      travelled += ds;
    }
    if (count < 2) return null;
    return {
      points: interleave(bufX, bufY, count),
      speed: Float32Array.from(bufS.subarray(0, count)),
      time: Float32Array.from(bufT.subarray(0, count)),
    };
  };

  /** Fraction along a (inside) -> b (outside) where the segment leaves the window. */
  function boxCrossing(ax: number, ay: number, bx: number, by: number): number {
    let f = 1;
    if (bx > W.xMax) f = Math.min(f, (W.xMax - ax) / (bx - ax));
    if (bx < W.xMin) f = Math.min(f, (W.xMin - ax) / (bx - ax));
    if (by > W.yMax) f = Math.min(f, (W.yMax - ay) / (by - ay));
    if (by < W.yMin) f = Math.min(f, (W.yMin - ay) / (by - ay));
    return clamp(f, 0, 1);
  }

  // Seed-line offset of the stagnation streamline: trace upstream from just off the
  // stagnation point until the seed line is reached.
  const stag = solution.stagnation;
  outer.nearest(stag[0], stag[1], near);
  let rx = stag[0] + 0.012 * near[2]!;
  let ry = stag[1] + 0.012 * near[3]!;
  for (let it = 0; it < 800; it++) {
    if ((rx - qx) * ex + (ry - qy) * ey <= 0) break;
    const ds = sample(rx, ry, v1);
    step(rx, ry, Math.max(ds, 0.004), -1, res);
    keepOutside(res);
    rx = res[0]!;
    ry = res[1]!;
  }
  const nStag = (rx - qx) * nrmX + (ry - qy) * nrmY;

  // Range of seed offsets whose (straight) lanes cross the window.
  let nLo = Infinity;
  let nHi = -Infinity;
  for (const [cx, cy] of [
    [W.xMin, W.yMin],
    [W.xMax, W.yMin],
    [W.xMin, W.yMax],
    [W.xMax, W.yMax],
  ] as const) {
    const n = (cx - qx) * nrmX + (cy - qy) * nrmY;
    nLo = Math.min(nLo, n);
    nHi = Math.max(nHi, n);
  }
  const margin = 0.03;
  nLo += margin;
  nHi -= margin;
  const total = Math.max(0, Math.floor(options.streamlines ?? DEFAULT_STREAMLINES));
  const offsets = seedOffsets(total, nLo, nHi, clamp(nStag, nLo, nHi));
  const streamlines: Streamline2D[] = [];
  for (const n of offsets) {
    const line = trace(qx + n * nrmX, qy + n * nrmY);
    if (line) streamlines.push(line);
  }

  return {
    eta: input.eta,
    alphaEffective: alphaE,
    alphaGeometric: input.alphaGeometric,
    alphaInduced: input.alphaInduced,
    contour: Float32Array.from(model.geometry.coords),
    cp: model.chordwiseCp(alphaE, re, 41, cl),
    cl,
    stalled,
    attachedFraction,
    stagnation: [solution.stagnation[0], solution.stagnation[1]],
    grid: { xMin: W.xMin, xMax: W.xMax, yMin: W.yMin, yMax: W.yMax, nx, ny, uv, inside },
    streamlines,
    separated,
  };
}

/**
 * Seed offsets (perpendicular to the freestream, on the seed line), denser close to the
 * stagnation streamline but never on it, split between the two sides by available width.
 */
export function seedOffsets(total: number, lo: number, hi: number, stag: number): number[] {
  if (total <= 0) return [];
  const up = Math.max(0, hi - stag);
  const down = Math.max(0, stag - lo);
  if (total === 1 || up + down <= 0) return [stag + SEED_GAP];
  let nUp = Math.round((total * up) / (up + down));
  nUp = clamp(nUp, up > SEED_GAP ? 1 : 0, total - (down > SEED_GAP ? 1 : 0));
  const nDown = total - nUp;
  const out: number[] = [];
  const side = (count: number, range: number, sign: number) => {
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      const gap = Math.min(SEED_GAP, 0.5 * range);
      out.push(stag + sign * (gap + (range - gap) * u ** 1.5));
    }
  };
  side(nDown, down, -1);
  side(nUp, up, 1);
  return out.sort((a, b) => a - b);
}

function interleave(xs: Float64Array, ys: Float64Array, count: number): Float32Array {
  const out = new Float32Array(2 * count);
  for (let i = 0; i < count; i++) {
    out[2 * i] = xs[i]!;
    out[2 * i + 1] = ys[i]!;
  }
  return out;
}
