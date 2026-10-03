/**
 * 2D linear-strength vortex panel method (inviscid, incompressible).
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 *
 * The influence matrix depends only on geometry, so a solver factorises it once and reuses
 * the factorisation (superposing alpha = 0 and alpha = 90 deg solutions) for any alpha.
 *
 * Method (Katz & Plotkin, "Low-Speed Aerodynamics", ch. 11.4):
 *  - N straight panels between N+1 contour nodes (TE -> lower -> LE -> upper -> TE, clockwise).
 *  - Vorticity varies linearly along each panel; gamma_j is the strength at node j, continuous
 *    across nodes. Positive gamma is CLOCKWISE (so positive circulation means positive lift).
 *  - No flow through the surface at each panel midpoint (N equations) plus the Kutta condition
 *    gamma_0 + gamma_N = 0 at the sharp trailing edge (equal speeds leave the TE).
 *  - Because the interior flow is at rest, the surface speed along the contour direction equals
 *    the local vortex strength; we nevertheless evaluate the outer-limit tangential velocity at
 *    each control point explicitly, which is slightly more accurate for Cp.
 *
 * Every solution is a linear combination of three basis solutions computed once:
 *   gamma(alpha, kappa) = cos(alpha) g0 + sin(alpha) g90 + kappa gc
 * where g0/g90 satisfy Kutta for unit freestream along x/y and gc is the pure-circulation flow
 * (no freestream, no flow through the surface, Kutta violated). kappa = 0 is the classic Kutta
 * solution; kappa != 0 prescribes a different circulation (used to show reduced, stalled lift).
 */
import type { AirfoilGeometry, PanelSolution } from '../types';
import { luFactor, luSolve } from '../math/linalg';

export interface PanelSolver {
  readonly geometry: AirfoilGeometry;
  /** Solve at angle of attack alpha (rad). Cheap after construction. */
  solve(alpha: number): PanelSolution;
  /**
   * Velocity (normalised by V_inf) at an arbitrary field point (airfoil frame) for a solution.
   * Writes [u, v] into `out`. Points on/inside the body return finite values.
   */
  velocityAt(solution: PanelSolution, x: number, y: number, out: [number, number]): void;
}

/** Extra capabilities of the linear-vortex solver beyond the {@link PanelSolver} contract. */
export interface LinearVortexPanelSolver extends PanelSolver {
  readonly nPanels: number;
  /** Inviscid lift slope dcl/dalpha at zero lift (per rad). cl(alpha) = slope * sin(alpha - a0). */
  readonly liftSlope: number;
  /** Inviscid zero-lift angle (rad). */
  readonly alphaZeroLift: number;
  /** Kutta-condition lift coefficient at alpha without building a full solution. */
  clAt(alpha: number): number;
  /**
   * Solve at alpha with a PRESCRIBED lift coefficient: no flow through the surface still holds,
   * but the Kutta condition is relaxed (circulation is added or removed). Used to draw flow
   * fields whose circulation matches a viscous/stalled lift.
   */
  solveWithLift(alpha: number, cl: number): PanelSolution;
  /**
   * Allocation-free Kutta solution at alpha: writes the signed outer tangential speed at each
   * control point (along the contour direction) into `out` (length nPanels).
   * Cp = 1 - speed^2. (Nodal gamma is unreliable right at a closed trailing edge, control-point
   * speeds are not, so surface sampling should use these.)
   */
  surfaceSpeedInto(alpha: number, out: Float64Array): void;
}

/** Type guard: does this solver expose the linear-vortex extras? */
export function isLinearVortexSolver(s: PanelSolver): s is LinearVortexPanelSolver {
  return typeof (s as Partial<LinearVortexPanelSolver>).solveWithLift === 'function';
}

const TWO_PI = 2 * Math.PI;
const INV_TWO_PI = 1 / TWO_PI;
/** Squared-distance floor that keeps the log kernel finite at panel nodes. */
const R2_MIN = 1e-14;

/** Panels per multipole cluster for fast field evaluation. */
const CLUSTER_SIZE = 10;
/** Number of multipole terms per cluster. */
const MULTIPOLE_TERMS = 12;
/** Use a cluster's multipole when |z - centre| > this factor times the cluster radius. */
const MULTIPOLE_RATIO = 2.6;
/** 6-point Gauss-Legendre on [0, 1] (exact for polynomials up to degree 11). */
const GL_T = [
  0.033765242898424, 0.169395306766868, 0.380690406958402, 0.619309593041598, 0.830604693233132,
  0.966234757101576,
];
const GL_W = [
  0.085662246189585, 0.180380786524069, 0.233956967286346, 0.233956967286346, 0.180380786524069,
  0.085662246189585,
];

/**
 * Velocity induced at a point by one linear-vortex panel, split into the contributions of the
 * strengths at its start node (a) and end node (b). Panel-local coordinates: X along the panel
 * from node a, Y along the outward normal. Writes local-frame coefficients into `c`:
 * [ua, va, ub, vb] such that (u, v)_local = ga * (ua, va) + gb * (ub, vb).
 * `onSelf` evaluates the outer limit at the panel's own midpoint.
 */
function panelCoefficients(X: number, Y: number, L: number, onSelf: boolean, c: Float64Array) {
  let r1 = X * X + Y * Y;
  const dxb = X - L;
  let r2 = dxb * dxb + Y * Y;
  if (r1 < R2_MIN) r1 = R2_MIN;
  if (r2 < R2_MIN) r2 = R2_MIN;
  // Angle subtended by the panel at the point, in (-pi, pi]; +pi on the outer side of the panel.
  const beta = onSelf ? Math.PI : Math.atan2(Y * L, X * dxb + Y * Y);
  const lnr = 0.5 * Math.log(r1 / r2);
  const i1u = X * beta - Y * lnr;
  const i1v = X * lnr - L + Y * beta;
  const invL = 1 / L;
  c[0] = (beta - i1u * invL) * INV_TWO_PI;
  c[1] = -(lnr - i1v * invL) * INV_TWO_PI;
  c[2] = i1u * invL * INV_TWO_PI;
  c[3] = -i1v * invL * INV_TWO_PI;
}

interface ClusterTable {
  /** First panel and panel count of each cluster. */
  start: Int32Array;
  count: Int32Array;
  /** Cluster centre (complex) and acceptance radius squared. */
  cx: Float64Array;
  cy: Float64Array;
  farR2: Float64Array;
}

/** Multipole coefficients a_k (complex, interleaved re/im) per cluster for one solution. */
type Multipoles = Float64Array;

export function createPanelSolver(geometry: AirfoilGeometry): LinearVortexPanelSolver {
  const nNodes = geometry.nPoints;
  const n = nNodes - 1; // panels
  if (n < 4) throw new Error('createPanelSolver: need at least 4 panels');
  const xy = geometry.coords;

  // ---- Panel geometry --------------------------------------------------------------------
  const px = new Float64Array(nNodes); // node coordinates
  const py = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    px[i] = xy[2 * i]!;
    py[i] = xy[2 * i + 1]!;
  }
  const len = new Float64Array(n);
  const tx = new Float64Array(n); // unit tangent (contour direction)
  const ty = new Float64Array(n);
  const cpx = new Float64Array(n); // control points (midpoints)
  const cpy = new Float64Array(n);
  const controlPoints = new Float64Array(2 * n);
  for (let j = 0; j < n; j++) {
    const dx = px[j + 1]! - px[j]!;
    const dy = py[j + 1]! - py[j]!;
    const l = Math.hypot(dx, dy);
    if (!(l > 0)) throw new Error(`createPanelSolver: panel ${j} has zero length`);
    len[j] = l;
    tx[j] = dx / l;
    ty[j] = dy / l;
    cpx[j] = 0.5 * (px[j]! + px[j + 1]!);
    cpy[j] = 0.5 * (py[j]! + py[j + 1]!);
    controlPoints[2 * j] = cpx[j]!;
    controlPoints[2 * j + 1] = cpy[j]!;
  }
  // Outward normal of a clockwise contour = tangent rotated +90 deg: (-ty, tx).

  // ---- Influence matrices ----------------------------------------------------------------
  // A (normal velocity, (n+1)x(n+1) incl. Kutta row) and AT (tangential, n x (n+1)).
  const m = n + 1;
  const A = new Float64Array(m * m);
  const AT = new Float64Array(n * m);
  const c = new Float64Array(4);
  for (let i = 0; i < n; i++) {
    const nix = -ty[i]!;
    const niy = tx[i]!;
    const tix = tx[i]!;
    const tiy = ty[i]!;
    const row = i * m;
    for (let j = 0; j < n; j++) {
      const dx = cpx[i]! - px[j]!;
      const dy = cpy[i]! - py[j]!;
      const tjx = tx[j]!;
      const tjy = ty[j]!;
      const X = dx * tjx + dy * tjy;
      const Y = -dx * tjy + dy * tjx;
      panelCoefficients(X, Y, len[j]!, i === j, c);
      // Local -> global: v_global = u_l * t_j + v_l * n_j, n_j = (-tjy, tjx).
      const uax = c[0]! * tjx - c[1]! * tjy;
      const uay = c[0]! * tjy + c[1]! * tjx;
      const ubx = c[2]! * tjx - c[3]! * tjy;
      const uby = c[2]! * tjy + c[3]! * tjx;
      A[row + j] = A[row + j]! + uax * nix + uay * niy;
      A[row + j + 1] = A[row + j + 1]! + ubx * nix + uby * niy;
      AT[row + j] = AT[row + j]! + uax * tix + uay * tiy;
      AT[row + j + 1] = AT[row + j + 1]! + ubx * tix + uby * tiy;
    }
  }
  // Kutta condition row.
  A[n * m + 0] = 1;
  A[n * m + n] = 1;
  const lu = luFactor(A, m);

  // ---- Basis solutions -------------------------------------------------------------------
  const rhs = new Float64Array(m);
  for (let i = 0; i < n; i++) rhs[i] = ty[i]!; // -(1,0).n_i = -(-ty_i)
  const g0 = luSolve(lu, rhs);
  for (let i = 0; i < n; i++) rhs[i] = -tx[i]!; // -(0,1).n_i
  const g90 = luSolve(lu, rhs);
  rhs.fill(0);
  rhs[n] = 1;
  const gc = luSolve(lu, rhs);

  /** Outer tangential velocity at control points for a basis (plus its freestream). */
  const tangential = (g: Float64Array, fx: number, fy: number) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = fx * tx[i]! + fy * ty[i]!;
      const row = i * m;
      for (let j = 0; j < m; j++) s += AT[row + j]! * g[j]!;
      out[i] = s;
    }
    return out;
  };
  const vt0 = tangential(g0, 1, 0);
  const vt90 = tangential(g90, 0, 1);
  const vtc = tangential(gc, 0, 0);

  const circulation = (g: Float64Array) => {
    let s = 0;
    for (let j = 0; j < n; j++) s += 0.5 * len[j]! * (g[j]! + g[j + 1]!);
    return s;
  };
  // cl = 2 * Gamma / (V_inf * c) with unit chord.
  const cl0 = 2 * circulation(g0);
  const cl90 = 2 * circulation(g90);
  const clc = 2 * circulation(gc);
  const liftSlope = Math.hypot(cl0, cl90);
  const alphaZeroLift = -Math.atan2(cl0, cl90);

  // ---- Multipole clusters ----------------------------------------------------------------
  const nClusters = Math.ceil(n / CLUSTER_SIZE);
  const clusters: ClusterTable = {
    start: new Int32Array(nClusters),
    count: new Int32Array(nClusters),
    cx: new Float64Array(nClusters),
    cy: new Float64Array(nClusters),
    farR2: new Float64Array(nClusters),
  };
  for (let k = 0; k < nClusters; k++) {
    const s = k * CLUSTER_SIZE;
    const e = Math.min(n, s + CLUSTER_SIZE);
    clusters.start[k] = s;
    clusters.count[k] = e - s;
    let sx = 0;
    let sy = 0;
    for (let j = s; j <= e; j++) {
      sx += px[j]!;
      sy += py[j]!;
    }
    const ccx = sx / (e - s + 1);
    const ccy = sy / (e - s + 1);
    let r2 = 0;
    for (let j = s; j <= e; j++) r2 = Math.max(r2, (px[j]! - ccx) ** 2 + (py[j]! - ccy) ** 2);
    clusters.cx[k] = ccx;
    clusters.cy[k] = ccy;
    clusters.farR2[k] = r2 * MULTIPOLE_RATIO * MULTIPOLE_RATIO;
  }
  const multipoleCache = new WeakMap<PanelSolution, Multipoles>();

  /** a_k = integral of gamma(s) (zeta(s) - zc)^k ds over each cluster, by Gauss-Legendre. */
  function buildMultipoles(gamma: Float64Array): Multipoles {
    const P = MULTIPOLE_TERMS;
    const out = new Float64Array(nClusters * P * 2);
    for (let k = 0; k < nClusters; k++) {
      const zcx = clusters.cx[k]!;
      const zcy = clusters.cy[k]!;
      const base = k * P * 2;
      const s0 = clusters.start[k]!;
      const s1 = s0 + clusters.count[k]!;
      for (let j = s0; j < s1; j++) {
        const ga = gamma[j]!;
        const gb = gamma[j + 1]!;
        const l = len[j]!;
        for (let q = 0; q < GL_T.length; q++) {
          const t = GL_T[q]!;
          const w = GL_W[q]! * l * (ga + (gb - ga) * t);
          const dx = px[j]! + t * (px[j + 1]! - px[j]!) - zcx;
          const dy = py[j]! + t * (py[j + 1]! - py[j]!) - zcy;
          // Accumulate w * (dx + i dy)^p for p = 0..P-1.
          let re = w;
          let im = 0;
          for (let p = 0; p < P; p++) {
            out[base + 2 * p] = out[base + 2 * p]! + re;
            out[base + 2 * p + 1] = out[base + 2 * p + 1]! + im;
            const nre = re * dx - im * dy;
            im = re * dy + im * dx;
            re = nre;
          }
        }
      }
    }
    return out;
  }

  const coef = new Float64Array(4);
  /** Induced velocity of all panels (no freestream) at (x, y), accumulated into out. */
  function inducedVelocity(
    gamma: Float64Array,
    mp: Multipoles,
    x: number,
    y: number,
    out: [number, number],
  ) {
    let u = 0;
    let v = 0;
    const P = MULTIPOLE_TERMS;
    for (let k = 0; k < nClusters; k++) {
      const dzx = x - clusters.cx[k]!;
      const dzy = y - clusters.cy[k]!;
      const d2 = dzx * dzx + dzy * dzy;
      if (d2 > clusters.farR2[k]!) {
        // w = (i / 2pi) * sum_p a_p rho^(p+1), rho = 1 / (z - zc); Horner in rho.
        const rre = dzx / d2;
        const rim = -dzy / d2;
        const base = k * P * 2;
        let sre = mp[base + 2 * (P - 1)]!;
        let sim = mp[base + 2 * (P - 1) + 1]!;
        for (let p = P - 2; p >= 0; p--) {
          const nre = sre * rre - sim * rim + mp[base + 2 * p]!;
          sim = sre * rim + sim * rre + mp[base + 2 * p + 1]!;
          sre = nre;
        }
        const fre = sre * rre - sim * rim;
        const fim = sre * rim + sim * rre;
        // u - i v = (i/2pi)(fre + i fim) = (-fim + i fre)/2pi.
        u -= fim * INV_TWO_PI;
        v -= fre * INV_TWO_PI;
        continue;
      }
      const s0 = clusters.start[k]!;
      const s1 = s0 + clusters.count[k]!;
      for (let j = s0; j < s1; j++) {
        const dx = x - px[j]!;
        const dy = y - py[j]!;
        const tjx = tx[j]!;
        const tjy = ty[j]!;
        const X = dx * tjx + dy * tjy;
        const Y = -dx * tjy + dy * tjx;
        panelCoefficients(X, Y, len[j]!, false, coef);
        const ga = gamma[j]!;
        const gb = gamma[j + 1]!;
        const ul = ga * coef[0]! + gb * coef[2]!;
        const vl = ga * coef[1]! + gb * coef[3]!;
        u += ul * tjx - vl * tjy;
        v += ul * tjy + vl * tjx;
      }
    }
    out[0] = u;
    out[1] = v;
  }

  // ---- Solutions -------------------------------------------------------------------------

  /** Build a full PanelSolution for alpha with circulation weight kappa (0 = Kutta). */
  function build(alpha: number, kappa: number): PanelSolution {
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    const gamma = new Float64Array(nNodes);
    for (let j = 0; j < nNodes; j++) gamma[j] = ca * g0[j]! + sa * g90[j]! + kappa * gc[j]!;
    const cp = new Float64Array(n);
    const vt = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = ca * vt0[i]! + sa * vt90[i]! + kappa * vtc[i]!;
      vt[i] = s;
      cp[i] = 1 - s * s;
    }
    const cl = ca * cl0 + sa * cl90 + kappa * clc;
    // Pitching moment about the quarter chord by pressure integration (nose-up positive).
    let cm = 0;
    for (let i = 0; i < n; i++) {
      // Pressure force per panel: -Cp * n * L, outward normal n = (-ty, tx).
      const fx = cp[i]! * ty[i]! * len[i]!;
      const fy = -cp[i]! * tx[i]! * len[i]!;
      cm -= (cpx[i]! - 0.25) * fy - cpy[i]! * fx;
    }
    return {
      alpha,
      cp,
      controlPoints: controlPoints.slice(),
      gamma,
      cl,
      cmQuarter: cm,
      stagnation: findStagnation(vt),
    };
  }

  /**
   * Stagnation point: where the tangential velocity changes from negative (flow running against
   * the contour direction, as on the lower surface) to positive, choosing the crossing closest
   * to the leading edge. Interpolated along control point -> node -> control point.
   */
  function findStagnation(vt: Float64Array): [number, number] {
    const le = geometry.leIndex;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < n - 1; i++) {
      if (vt[i]! <= 0 && vt[i + 1]! > 0) {
        const d = Math.abs(i + 0.5 - (le - 0.5));
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    if (best < 0) return [px[le]!, py[le]!];
    const a = vt[best]!;
    const b = vt[best + 1]!;
    const w = a === b ? 0.5 : a / (a - b);
    const la = 0.5 * len[best]!;
    const lb = 0.5 * len[best + 1]!;
    const s = w * (la + lb);
    const node = best + 1;
    if (s <= la) {
      const f = s / la;
      return [cpx[best]! + f * (px[node]! - cpx[best]!), cpy[best]! + f * (py[node]! - cpy[best]!)];
    }
    const f = (s - la) / lb;
    return [px[node]! + f * (cpx[node]! - px[node]!), py[node]! + f * (cpy[node]! - py[node]!)];
  }

  return {
    geometry,
    nPanels: n,
    liftSlope,
    alphaZeroLift,
    clAt(alpha: number) {
      return Math.cos(alpha) * cl0 + Math.sin(alpha) * cl90;
    },
    solve(alpha: number) {
      return build(alpha, 0);
    },
    solveWithLift(alpha: number, cl: number) {
      const kutta = Math.cos(alpha) * cl0 + Math.sin(alpha) * cl90;
      return build(alpha, (cl - kutta) / clc);
    },
    surfaceSpeedInto(alpha: number, out: Float64Array) {
      const ca = Math.cos(alpha);
      const sa = Math.sin(alpha);
      for (let i = 0; i < n; i++) out[i] = ca * vt0[i]! + sa * vt90[i]!;
    },
    velocityAt(solution: PanelSolution, x: number, y: number, out: [number, number]) {
      let mp = multipoleCache.get(solution);
      if (!mp) {
        mp = buildMultipoles(solution.gamma);
        multipoleCache.set(solution, mp);
      }
      inducedVelocity(solution.gamma, mp, x, y, out);
      out[0] += Math.cos(solution.alpha);
      out[1] += Math.sin(solution.alpha);
    },
  };
}

/** Exact (non-accelerated) induced velocity of a solution, for tests of the fast path. */
export function directVelocity(
  geometry: AirfoilGeometry,
  solution: PanelSolution,
  x: number,
  y: number,
  out: [number, number],
): void {
  const xy = geometry.coords;
  const n = geometry.nPoints - 1;
  const c = new Float64Array(4);
  let u = Math.cos(solution.alpha);
  let v = Math.sin(solution.alpha);
  for (let j = 0; j < n; j++) {
    const ax = xy[2 * j]!;
    const ay = xy[2 * j + 1]!;
    const dxp = xy[2 * j + 2]! - ax;
    const dyp = xy[2 * j + 3]! - ay;
    const l = Math.hypot(dxp, dyp);
    const tjx = dxp / l;
    const tjy = dyp / l;
    const dx = x - ax;
    const dy = y - ay;
    panelCoefficients(dx * tjx + dy * tjy, -dx * tjy + dy * tjx, l, false, c);
    const ga = solution.gamma[j]!;
    const gb = solution.gamma[j + 1]!;
    const ul = ga * c[0]! + gb * c[2]!;
    const vl = ga * c[1]! + gb * c[3]!;
    u += ul * tjx - vl * tjy;
    v += ul * tjy + vl * tjx;
  }
  out[0] = u;
  out[1] = v;
}
