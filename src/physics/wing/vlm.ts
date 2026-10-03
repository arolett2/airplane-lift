/**
 * Vortex-lattice method on the mean-camber surface of every lifting surface (non-planar, so
 * winglets work), with horseshoe vortices, Prandtl-Glauert compressibility, Trefftz-plane
 * induced drag, and a strip-wise viscous coupling ("virtual twist") for stall.
 * OWNER: physics-vlm agent. CONTRACT — keep the exported signatures.
 *
 * All VLM quantities are solved for V_inf = 1 in the BODY frame (trailing legs along body +x);
 * callers scale circulation by the true airspeed.
 *
 * Method summary
 * - Layout (vlmLayout.ts): per right-side surface, strips with half-cosine spacing toward the tip
 *   whose edges land on the geometry's sections; cosine-spaced chordwise stations on the camber
 *   surface (flap included) and flat panels between them. Bound vortex on the panel 1/4-chord
 *   line, control point at 3/4 chord (normal from the camber slope there), trailing legs along
 *   the strip's side edges station by station to the trailing edge, then along body +x.
 *   (Straight legs from the bound vortex to the trailing edge would cut below a deflected flap
 *   and cost a 40-degree flapped AR-8 wing ~20% of its lift slope.) Wing edges lie in vertical
 *   streamwise planes (the root in the symmetry plane); a tip device starts exactly on its
 *   parent's last edge; slivers that would make the lattice singular are left out (see
 *   vlmLayout.ts). buildVlmModel finally checks the solution for plausibility.
 *   Spanwise, control points (and the Trefftz and Kutta–Joukowski evaluation points) sit at each
 *   strip's mid-ANGLE in the cosine parameter (semicircle method): the arithmetic mid-span near
 *   the root, 3/4 of the strip width at the tip. With plain mid-span points a horseshoe lattice
 *   has an O(1/N) tip error (span efficiency > 1 on coarse meshes); with mid-angle points
 *   CL_alpha and span efficiency are mesh-independent to ~4 digits (see vlm.test.ts).
 * - Symmetry: only the right half is solved. Each right horseshoe is paired with its mirror image
 *   (orientation rule from types.ts: left A outboard, B inboard), which carries the same gamma.
 *   Panels/strips p + half mirror p in every array.
 * - Compressibility (Prandtl–Glauert–Göthert): influence coefficients are evaluated on the
 *   geometry stretched x -> x/beta; the perturbation u is divided by beta. Circulation and
 *   Kutta–Joukowski forces are then physical, so CL_alpha grows ~1/beta for high AR.
 * - Forces: Kutta–Joukowski on bound segments with freestream + induced velocity; induced drag in
 *   the Trefftz plane from the wake trace (non-planar), which is also where the per-strip induced
 *   angle comes from (half the far-field normalwash).
 */
import type {
  FlapState,
  LiftingSurface,
  Naca4Params,
  SectionPolar,
  Vec3,
  VortexLattice,
  WingGeometry,
} from '../types';
import { bodyToTunnel } from '../math/frames';
import { luFactor, luSolve, type LuFactorization } from '../math/linalg';
import {
  addStripHorseshoeVelocities,
  addTrefftzVortexVelocity,
  stripScratchLength,
} from './vlmBiotSavart';
import { layoutHalfWing } from './vlmLayout';

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

/** Mach numbers above this are treated as this value by the Prandtl–Glauert correction. */
export const VLM_MAX_MACH = 0.85;

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

/**
 * Precomputed solver data (built once per geometry/options). Arrays cover the RIGHT half only;
 * the left half is implied by symmetry. Treat as opaque.
 */
export interface VlmSolverData {
  /** LU factors of the symmetric (right-half + mirror) influence matrix. */
  lu: LuFactorization;
  /** Strip index of each right panel. */
  panelStrip: Int32Array;
  /**
   * Camber-surface points along each right strip's A and B side edges at the chordwise panel
   * stations (nc + 1 per strip, xyz, body frame). Horseshoe k of a strip trails from its bound
   * vortex along these edges (stations k+1 .. nc) to the trailing edge, then along +x.
   */
  edgeA: Float64Array;
  edgeB: Float64Array;
  /**
   * x and z components of (twistAxis × normal) per right panel: d(normal)/d(virtual twist). The
   * axis is the strip's section span tangent (0, cos roll, sin roll), the axis WingSection.twist
   * rotates about, so a virtual twist is an incidence change exactly like twist: a uniform one on
   * any wing without dihedral (swept or not) equals the same change of alpha.
   */
  twistDnX: Float64Array;
  twistDnZ: Float64Array;
  /**
   * Kutta–Joukowski evaluation point on each right bound segment (xyz), at the strip's control
   * fraction (semicircle method; the midpoint near the root).
   */
  kjPoint: Float64Array;
  /**
   * Physical induced velocity at each right kjPoint per unit gamma of each right horseshoe and
   * its mirror. Row-major [target * half + source].
   */
  kjVx: Float64Array;
  kjVy: Float64Array;
  kjVz: Float64Array;
  /** Trefftz-plane normalwash at right strip i's wake trace per unit circulation of strip j (+ mirror). */
  trefftz: Float64Array;
  /** Length of each right strip's wake trace in the Trefftz (y-z) plane. */
  traceLength: Float64Array;
  /**
   * Right-strip circulation response to a unit virtual twist of right strip j (and its mirror),
   * split so response = cos(alpha) * twistResponseCos + sin(alpha) * twistResponseSin.
   * Row-major [strip * halfStrips + twistedStrip].
   */
  twistResponseCos: Float64Array;
  twistResponseSin: Float64Array;
  /**
   * Streamwise section axes at each right strip's centre (WingSection chord direction and normal,
   * xyz), for the geometric angle of attack.
   */
  stripChordDir: Float64Array;
  stripSectionNormal: Float64Array;
  /** Right-strip neighbours along the same surface (-1 at a surface end). */
  stripPrev: Int32Array;
  stripNext: Int32Array;
  /** Scratch buffers (right half). */
  rhs: Float64Array;
  gammaHalf: Float64Array;
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
  /** Right-side strip count. Strips [0, half) are the right side; strip j + half mirrors strip j. */
  halfStripCount: number;
  /** Right-side panel count. Panel p + half mirrors panel p (same gamma). */
  halfPanelCount: number;
  /** Prandtl–Glauert factor sqrt(1 - M^2) with M clamped to [0, VLM_MAX_MACH]. */
  beta: number;
  solver: VlmSolverData;
  /**
   * Problems met while building the lattice, in plain words for AeroResult.warnings (empty when
   * all is well). See buildVlmModel's lattice health check.
   */
  warnings: string[];
}

export interface VlmSolveInput {
  /** Freestream angle of attack in the body frame (rad). */
  alpha: number;
  /**
   * Extra incidence per strip (rad), length strips.length — the viscous coupling's virtual twist.
   * The solve is symmetric: each right value is averaged with its mirror. A right-half-only array
   * (length halfStripCount) is also accepted.
   */
  stripIncidence?: Float64Array;
}

export interface VlmSolution {
  alpha: number;
  /** Panel circulation for V_inf = 1 (m). */
  gamma: Float64Array;
  /** Net strip circulation for V_inf = 1 (m). */
  stripCirculation: Float64Array;
  /**
   * Local (linear, inviscid) section lift coefficient per strip: the normal-force coefficient
   * 2 * stripCirculation / (V * chord).
   */
  stripCl: Float64Array;
  /**
   * Induced angle per strip (rad), positive = downwash: half the Trefftz-plane normalwash of the
   * trailing system (works for non-planar wings). Pointwise values in the last few, very narrow
   * tip strips are dominated by the neighbouring discrete trailing vortices and should not be
   * over-interpreted; CDi (the integral) is unaffected.
   */
  stripAlphaInduced: Float64Array;
  /** Coefficients referenced to geometry.referenceArea / meanAeroChord. */
  CL: number;
  CDi: number;
  /** Pitching moment about geometry.pivot (nose-up positive). */
  Cm: number;
  /**
   * Near-field Kutta–Joukowski force on the bound vortices divided by (q * referenceArea), BODY
   * frame (x, y, z). y is zero by symmetry. Lift is CL; the drag-wise part is the near-field
   * induced drag (less accurate than CDi, which comes from the Trefftz plane).
   */
  forceCoefficient: Vec3;
}

/* ------------------------------------------------------------------------------------------ */
/* Model construction                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Find (or synthesise) the mirror partner on the left side of each right surface. */
function pairLeftSurfaces(geometry: WingGeometry, rights: LiftingSurface[]): LiftingSurface[] {
  const lefts = geometry.surfaces.filter((s) => s.side === 'left');
  const used = new Set<LiftingSurface>();
  return rights.map((r) => {
    let best: LiftingSurface | null = null;
    let bestD = Infinity;
    for (const l of lefts) {
      if (used.has(l) || l.role !== r.role || l.sections.length !== r.sections.length) continue;
      let d = 0;
      for (let k = 0; k < r.sections.length; k++) {
        const a = r.sections[k]!.le;
        const b = l.sections[k]!.le;
        d += Math.hypot(a[0] - b[0], a[1] + b[1], a[2] - b[2]);
      }
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    if (best) {
      used.add(best);
      return best;
    }
    return {
      ...r,
      id: /right/.test(r.id) ? r.id.replace(/right/g, 'left') : `${r.id}-left`,
      name: /Right/.test(r.name) ? r.name.replace(/Right/g, 'Left') : `${r.name} (left)`,
      side: 'left',
      sections: r.sections.map((s) => ({ ...s, le: [s.le[0], -s.le[1], s.le[2]] as Vec3 })),
    };
  });
}

function mirrorVec(v: Vec3): Vec3 {
  return [v[0], -v[1], v[2]];
}

/**
 * Plausibility limits for a sound lattice (all times beta): per-strip lift slope and zero-alpha
 * cl, whole-wing lift slope and zero-alpha CL. Over the aircraft presets and 800 random slider
 * settings (flaps to 40 deg, camber to 9%, every tip device, Mach to 0.95) the largest values
 * are 8.5, 4.3, 7.0 and 3.6; lattices broken by self-intersecting geometry reach hundreds or
 * thousands. The limits leave about a factor of two.
 */
const HEALTHY_STRIP_SLOPE = 16;
const HEALTHY_STRIP_CL = 8;
const HEALTHY_WING_SLOPE = 12;
const HEALTHY_WING_CL = 6;

/** Whether the lattice's linear solution is physically plausible (see HEALTHY_STRIP_SLOPE). */
function latticeHealthy(model: VlmModel): boolean {
  const da = 0.1;
  const a = solveVlm(model, { alpha: 0 });
  const b = solveVlm(model, { alpha: da });
  const k = model.beta;
  for (let j = 0; j < model.halfStripCount; j++) {
    const slope = (Math.abs(b.stripCl[j]! - a.stripCl[j]!) / da) * k;
    const cl0 = Math.abs(a.stripCl[j]!) * k;
    if (!(slope <= HEALTHY_STRIP_SLOPE && cl0 <= HEALTHY_STRIP_CL)) return false;
  }
  const wingSlope = (Math.abs(b.CL - a.CL) / da) * k;
  return wingSlope <= HEALTHY_WING_SLOPE && Math.abs(a.CL) * k <= HEALTHY_WING_CL;
}

/**
 * Build (and factorise) the lattice. A health check then solves it at two angles: if any strip's
 * lift is implausible (see HEALTHY_STRIP_SLOPE) the input geometry is beyond what a vortex lattice
 * can represent, which in practice means tip-device surfaces that cross the wing's own camber
 * surface (very large camber, toe and device chord together). The model is then rebuilt without
 * the tip devices and says so in `warnings`, rather than handing on lift values that are off by
 * orders of magnitude. Costs two extra solves (~0.2 ms).
 */
export function buildVlmModel(geometry: WingGeometry, options?: Partial<VlmOptions>): VlmModel {
  const opts: VlmOptions = { ...DEFAULT_VLM_OPTIONS, ...options };
  const model = buildLattice(geometry, opts);
  if (latticeHealthy(model)) return model;
  const wingOnly = geometry.surfaces.filter((s) => s.role !== 'tip-device');
  if (wingOnly.length < geometry.surfaces.length) {
    const bare = buildLattice({ ...geometry, surfaces: wingOnly }, opts);
    if (latticeHealthy(bare)) {
      bare.geometry = geometry;
      bare.warnings.push(
        'The wingtip devices were left out of the lift calculation: with these settings they ' +
          'cut through the wing surface, which the calculation cannot handle. Try less camber, ' +
          'toe or device size.',
      );
      return bare;
    }
  }
  model.warnings.push(
    'This wing shape is beyond what the lift calculation can handle reliably; the numbers may ' +
      'be far off.',
  );
  return model;
}

function buildLattice(geometry: WingGeometry, opts: VlmOptions): VlmModel {
  const mach = Math.min(Math.max(opts.mach || 0, 0), VLM_MAX_MACH);
  const beta = Math.sqrt(1 - mach * mach);
  const layout = layoutHalfWing(geometry, opts);
  const N = layout.panelCount;
  const Ns = layout.strips.length;

  // ---- Strips (right, then mirrored left) ------------------------------------------------------
  const rightSurfaces: LiftingSurface[] = [];
  for (const s of layout.strips)
    if (!rightSurfaces.includes(s.surface)) rightSurfaces.push(s.surface);
  const partners = pairLeftSurfaces(geometry, rightSurfaces);
  const partnerOf = new Map(rightSurfaces.map((r, i) => [r, partners[i]!]));

  const strips: VlmStrip[] = [];
  for (const s of layout.strips) {
    strips.push({
      index: strips.length,
      surfaceId: s.surface.id,
      side: 'right',
      eta: s.eta,
      width: s.width,
      chord: s.chord,
      center: s.center,
      normal: s.normal,
      spanTangent: s.spanTangent,
      airfoil: s.airfoil,
      flap: s.flap,
      slat: s.slat,
      twist: s.twist,
      panelStart: s.panelStart,
      panelCount: s.panelCount,
    });
  }
  for (const s of layout.strips) {
    strips.push({
      index: strips.length,
      surfaceId: partnerOf.get(s.surface)!.id,
      side: 'left',
      eta: s.eta,
      width: s.width,
      chord: s.chord,
      center: mirrorVec(s.center),
      normal: mirrorVec(s.normal),
      spanTangent: mirrorVec(s.spanTangent),
      airfoil: { ...s.airfoil },
      flap: s.flap ? { ...s.flap } : null,
      slat: s.slat,
      twist: s.twist,
      panelStart: N + s.panelStart,
      panelCount: s.panelCount,
    });
  }

  // ---- Panels (right, then mirrored left with the orientation rule) -------------------------
  const boundA = new Float64Array(6 * N);
  const boundB = new Float64Array(6 * N);
  const trailingA = new Float64Array(6 * N);
  const trailingB = new Float64Array(6 * N);
  const controlPoints = new Float64Array(6 * N);
  const normals = new Float64Array(6 * N);
  const panelAreas = new Float64Array(2 * N);
  boundA.set(layout.boundA);
  boundB.set(layout.boundB);
  trailingA.set(layout.trailingA);
  trailingB.set(layout.trailingB);
  controlPoints.set(layout.controlPoints);
  normals.set(layout.normals);
  panelAreas.set(layout.panelAreas);
  panelAreas.set(layout.panelAreas, N);
  const mirrorInto = (dst: Float64Array, src: Float64Array) => {
    for (let p = 0; p < N; p++) {
      dst[3 * (N + p)] = src[3 * p]!;
      dst[3 * (N + p) + 1] = -src[3 * p + 1]!;
      dst[3 * (N + p) + 2] = src[3 * p + 2]!;
    }
  };
  // Left: A = mirror(right B) (outboard), B = mirror(right A) (inboard).
  mirrorInto(boundA, layout.boundB);
  mirrorInto(boundB, layout.boundA);
  mirrorInto(trailingA, layout.trailingB);
  mirrorInto(trailingB, layout.trailingA);
  mirrorInto(controlPoints, layout.controlPoints);
  mirrorInto(normals, layout.normals);

  // ---- Influence matrices ------------------------------------------------------------------------
  // Each right horseshoe's legs follow its strip's side edges on the camber surface to the
  // trailing edge, then run along +x. Influence of the mirror image at P = reflected influence of
  // the right horseshoe at the mirrored P. Prandtl–Glauert: geometry stretched x -> x / beta,
  // induced u divided by beta.
  const cut = 1e-9 * Math.max(geometry.referenceSpan, geometry.overallSpan, 1e-3);
  const cut2 = cut * cut;
  const invBeta = 1 / beta;
  const nc = layout.chordwisePanels;
  const stretch = (src: Float64Array) => {
    const out = Float64Array.from(src);
    for (let i = 0; i < out.length; i += 3) out[i] = out[i]! * invBeta;
    return out;
  };
  const bA = layout.boundA;
  const bB = layout.boundB;
  const nrm = layout.normals;
  const bAS = stretch(bA);
  const bBS = stretch(bB);
  const eAS = stretch(layout.edgeA);
  const eBS = stretch(layout.edgeB);
  // Kutta–Joukowski evaluation point on each bound segment, at the strip's control fraction.
  const kjPoint = new Float64Array(3 * N);
  for (let i = 0; i < N; i++) {
    const fc = layout.strips[layout.panelStrip[i]!]!.controlFraction;
    for (let c = 0; c < 3; c++) {
      kjPoint[3 * i + c] = bA[3 * i + c]! + fc * (bB[3 * i + c]! - bA[3 * i + c]!);
    }
  }
  const cpS = stretch(layout.controlPoints);
  const kjS = stretch(kjPoint);
  const scratch = new Float64Array(stripScratchLength(nc));
  const row = new Float64Array(3 * N);
  /** row <- velocity at stretched point i of `pts` induced by every right horseshoe + mirror. */
  const influenceRow = (pts: Float64Array, i: number) => {
    row.fill(0);
    const qx = pts[3 * i]!;
    const qy = pts[3 * i + 1]!;
    const qz = pts[3 * i + 2]!;
    for (let s = 0; s < Ns; s++) {
      const p0 = s * nc;
      const e0 = s * (nc + 1);
      addStripHorseshoeVelocities(
        qx,
        qy,
        qz,
        bAS,
        bBS,
        p0,
        eAS,
        eBS,
        e0,
        nc,
        cut2,
        false,
        row,
        scratch,
      );
      addStripHorseshoeVelocities(
        qx,
        -qy,
        qz,
        bAS,
        bBS,
        p0,
        eAS,
        eBS,
        e0,
        nc,
        cut2,
        true,
        row,
        scratch,
      );
    }
  };
  const aic = new Float64Array(N * N);
  const kjVx = new Float64Array(N * N);
  const kjVy = new Float64Array(N * N);
  const kjVz = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    influenceRow(cpS, i);
    const nx = nrm[3 * i]! * invBeta;
    const ny = nrm[3 * i + 1]!;
    const nz = nrm[3 * i + 2]!;
    for (let j = 0; j < N; j++) {
      aic[i * N + j] = row[3 * j]! * nx + row[3 * j + 1]! * ny + row[3 * j + 2]! * nz;
    }
    influenceRow(kjS, i);
    for (let j = 0; j < N; j++) {
      kjVx[i * N + j] = row[3 * j]! * invBeta;
      kjVy[i * N + j] = row[3 * j + 1]!;
      kjVz[i * N + j] = row[3 * j + 2]!;
    }
  }
  const lu = luFactor(aic, N);

  // ---- Virtual-twist derivative of each panel normal: t_strip × n_panel ----------------------
  const twistDnX = new Float64Array(N);
  const twistDnZ = new Float64Array(N);
  for (let p = 0; p < N; p++) {
    const t = layout.strips[layout.panelStrip[p]!]!.twistAxis;
    const nx = nrm[3 * p]!;
    const ny = nrm[3 * p + 1]!;
    const nz = nrm[3 * p + 2]!;
    twistDnX[p] = t[1] * nz - t[2] * ny;
    twistDnZ[p] = t[0] * ny - t[1] * nx;
  }

  // ---- Trefftz plane ------------------------------------------------------------------------------
  const trefftz = new Float64Array(Ns * Ns);
  const traceLength = new Float64Array(Ns);
  const v2 = new Float64Array(2);
  for (let i = 0; i < Ns; i++) {
    const si = layout.strips[i]!;
    const sy = si.teB[1] - si.teA[1];
    const sz = si.teB[2] - si.teA[2];
    const len = Math.hypot(sy, sz);
    traceLength[i] = len;
    if (!(len > 0)) continue;
    const ny = -sz / len;
    const nz = sy / len;
    // Evaluate at the strip's control fraction (semicircle method), like the control points.
    const my = si.teA[1] + si.controlFraction * sy;
    const mz = si.teA[2] + si.controlFraction * sz;
    for (let j = 0; j < Ns; j++) {
      const sj = layout.strips[j]!;
      v2[0] = v2[1] = 0;
      // Right strip j: +Gamma leaves at teB, -Gamma arrives at teA. Mirror: A' = m(teB), B' = m(teA).
      addTrefftzVortexVelocity(my, mz, sj.teB[1], sj.teB[2], 1, cut2, v2, 0);
      addTrefftzVortexVelocity(my, mz, sj.teA[1], sj.teA[2], -1, cut2, v2, 0);
      addTrefftzVortexVelocity(my, mz, -sj.teA[1], sj.teA[2], 1, cut2, v2, 0);
      addTrefftzVortexVelocity(my, mz, -sj.teB[1], sj.teB[2], -1, cut2, v2, 0);
      trefftz[i * Ns + j] = v2[0]! * ny + v2[1]! * nz;
    }
  }

  // ---- Strip response to virtual twist (exact for the linear lattice) ----------------------------
  const twistResponseCos = new Float64Array(Ns * Ns);
  const twistResponseSin = new Float64Array(Ns * Ns);
  const rhs = new Float64Array(N);
  const g = new Float64Array(N);
  for (let j = 0; j < Ns; j++) {
    const sj = layout.strips[j]!;
    for (const [dn, out] of [
      [twistDnX, twistResponseCos],
      [twistDnZ, twistResponseSin],
    ] as const) {
      rhs.fill(0);
      for (let p = sj.panelStart; p < sj.panelStart + sj.panelCount; p++) rhs[p] = -dn[p]!;
      luSolve(lu, rhs, g);
      for (let i = 0; i < Ns; i++) {
        const si = layout.strips[i]!;
        let sum = 0;
        for (let p = si.panelStart; p < si.panelStart + si.panelCount; p++) sum += g[p]!;
        out[i * Ns + j] = sum;
      }
    }
  }

  const stripChordDir = new Float64Array(3 * Ns);
  const stripSectionNormal = new Float64Array(3 * Ns);
  const stripPrev = new Int32Array(Ns);
  const stripNext = new Int32Array(Ns);
  for (let i = 0; i < Ns; i++) {
    const s = layout.strips[i]!;
    stripChordDir.set(s.sectionChordDir, 3 * i);
    stripSectionNormal.set(s.sectionNormal, 3 * i);
    stripPrev[i] = i > 0 && layout.strips[i - 1]!.surface === s.surface ? i - 1 : -1;
    stripNext[i] = i + 1 < Ns && layout.strips[i + 1]!.surface === s.surface ? i + 1 : -1;
  }

  return {
    geometry,
    options: opts,
    panelCount: 2 * N,
    strips,
    boundA,
    boundB,
    trailingA,
    trailingB,
    controlPoints,
    normals,
    panelAreas,
    halfStripCount: Ns,
    halfPanelCount: N,
    beta,
    solver: {
      lu,
      panelStrip: layout.panelStrip,
      edgeA: layout.edgeA,
      edgeB: layout.edgeB,
      kjPoint,
      twistDnX,
      twistDnZ,
      kjVx,
      kjVy,
      kjVz,
      trefftz,
      traceLength,
      twistResponseCos,
      twistResponseSin,
      stripChordDir,
      stripSectionNormal,
      stripPrev,
      stripNext,
      rhs: new Float64Array(N),
      gammaHalf: new Float64Array(N),
    },
    warnings: [],
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Linear solve                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Right-half virtual twist from a full (or half) strip-incidence array, symmetrised. */
function halfIncidence(model: VlmModel, inc: Float64Array | undefined, out: Float64Array): void {
  const Ns = model.halfStripCount;
  if (!inc) {
    out.fill(0);
    return;
  }
  if (inc.length >= 2 * Ns) {
    for (let j = 0; j < Ns; j++) out[j] = 0.5 * (inc[j]! + inc[j + Ns]!);
  } else {
    for (let j = 0; j < Ns; j++) out[j] = inc[j] ?? 0;
  }
}

export function solveVlm(model: VlmModel, input: VlmSolveInput): VlmSolution {
  const { alpha } = input;
  const N = model.halfPanelCount;
  const Ns = model.halfStripCount;
  const sd = model.solver;
  const geo = model.geometry;
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const delta = new Float64Array(Ns);
  halfIncidence(model, input.stripIncidence, delta);

  // Boundary condition: (V_inf + v) . n_delta = 0 with n_delta = n + delta (t × n) (small angle).
  const rhs = sd.rhs;
  const nrm = model.normals;
  for (let p = 0; p < N; p++) {
    const d = delta[sd.panelStrip[p]!]!;
    rhs[p] =
      -(ca * nrm[3 * p]! + sa * nrm[3 * p + 2]!) -
      d * (ca * sd.twistDnX[p]! + sa * sd.twistDnZ[p]!);
  }
  const gh = luSolve(sd.lu, rhs, sd.gammaHalf);

  const gamma = new Float64Array(2 * N);
  gamma.set(gh);
  gamma.set(gh, N);

  const stripCirculation = new Float64Array(2 * Ns);
  const stripCl = new Float64Array(2 * Ns);
  const stripAlphaInduced = new Float64Array(2 * Ns);
  for (let j = 0; j < Ns; j++) {
    const s = model.strips[j]!;
    let sum = 0;
    for (let p = s.panelStart; p < s.panelStart + s.panelCount; p++) sum += gh[p]!;
    stripCirculation[j] = stripCirculation[j + Ns] = sum;
    stripCl[j] = stripCl[j + Ns] = s.chord > 0 ? (2 * sum) / s.chord : 0;
  }

  // Trefftz plane: normalwash w_i on each right trace; drag = -(rho/2) sum Gamma w ds (both halves).
  let dragSum = 0;
  for (let i = 0; i < Ns; i++) {
    let w = 0;
    const row = i * Ns;
    for (let j = 0; j < Ns; j++) w += sd.trefftz[row + j]! * stripCirculation[j]!;
    stripAlphaInduced[i] = stripAlphaInduced[i + Ns] = -0.5 * w;
    dragSum += stripCirculation[i]! * w * sd.traceLength[i]!;
  }
  const S = geo.referenceArea;
  const CDi = (-2 * dragSum) / S;

  // Kutta–Joukowski on the right bound segments, freestream + induced velocity; double for left.
  let fx = 0;
  let fz = 0;
  let my = 0;
  const bA = model.boundA;
  const bB = model.boundB;
  const [px0, , pz0] = geo.pivot;
  for (let i = 0; i < N; i++) {
    let vx = ca;
    let vy = 0;
    let vz = sa;
    const row = i * N;
    for (let j = 0; j < N; j++) {
      const gj = gh[j]!;
      vx += sd.kjVx[row + j]! * gj;
      vy += sd.kjVy[row + j]! * gj;
      vz += sd.kjVz[row + j]! * gj;
    }
    const lx = bB[3 * i]! - bA[3 * i]!;
    const ly = bB[3 * i + 1]! - bA[3 * i + 1]!;
    const lz = bB[3 * i + 2]! - bA[3 * i + 2]!;
    const gi = gh[i]!;
    const Fx = gi * (vy * lz - vz * ly);
    const Fz = gi * (vx * ly - vy * lx);
    fx += Fx;
    fz += Fz;
    const rx = sd.kjPoint[3 * i]! - px0;
    const rz = sd.kjPoint[3 * i + 2]! - pz0;
    my += rz * Fx - rx * Fz;
  }
  // Coefficients: total = 2 * right half; q = 1/2 (rho = 1, V = 1).
  const k = 4 / S;
  const CL = k * (-fx * sa + fz * ca);
  const Cm = (k * my) / geo.meanAeroChord;

  return {
    alpha,
    gamma,
    stripCirculation,
    stripCl,
    stripAlphaInduced,
    CL,
    CDi,
    Cm,
    forceCoefficient: [k * fx, 0, k * fz],
  };
}

/**
 * Linear (attached-flow) whole-wing lift slope dCL/dalpha (per rad) at `alpha`, by a central
 * difference of two lattice solves (about 0.1 ms each).
 */
export function vlmLiftSlope(model: VlmModel, alpha = 0): number {
  const h = 0.01;
  return (
    (solveVlm(model, { alpha: alpha + h }).CL - solveVlm(model, { alpha: alpha - h }).CL) / (2 * h)
  );
}

/**
 * Express the solved lattice in the TUNNEL frame for flow-field evaluation: pitch the panels by
 * alpha about the pivot, scale circulation by vInf, and send trailing legs to +x (freestream).
 * `sources` is left empty and `coreRadius` set to a sensible default; the flow module fills sources.
 *
 * The VortexLattice format has one straight leg A -> teA per side, whereas the solver's legs
 * follow the strip edges along the camber surface; the two differ only on the surface itself
 * (by at most the flap droop), which is irrelevant for the flow field around the wing.
 * Orientation follows types.ts (right: A inboard; left: A outboard), so gamma > 0 is lift.
 */
export function vlmLatticeToTunnel(
  model: VlmModel,
  solution: VlmSolution,
  alpha: number,
  vInf: number,
): VortexLattice {
  const n = model.panelCount;
  const pivot = model.geometry.pivot;
  const a = new Float32Array(3 * n);
  const b = new Float32Array(3 * n);
  const teA = new Float32Array(3 * n);
  const teB = new Float32Array(3 * n);
  const gamma = new Float32Array(n);
  const pt: Vec3 = [0, 0, 0];
  const convert = (src: Float64Array, dst: Float32Array, p: number) => {
    pt[0] = src[3 * p]!;
    pt[1] = src[3 * p + 1]!;
    pt[2] = src[3 * p + 2]!;
    const q = bodyToTunnel(pt, pivot, alpha);
    dst[3 * p] = q[0];
    dst[3 * p + 1] = q[1];
    dst[3 * p + 2] = q[2];
  };
  for (let p = 0; p < n; p++) {
    convert(model.boundA, a, p);
    convert(model.boundB, b, p);
    convert(model.trailingA, teA, p);
    convert(model.trailingB, teB, p);
    gamma[p] = (solution.gamma[p] ?? 0) * vInf;
  }
  return {
    count: n,
    a,
    b,
    teA,
    teB,
    gamma,
    sources: {
      count: 0,
      p0: new Float32Array(0),
      p1: new Float32Array(0),
      sigma: new Float32Array(0),
    },
    coreRadius: 0.01 * model.geometry.referenceSpan,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Viscous coupling                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface StripPolarProvider {
  polar(strip: VlmStrip): SectionPolar;
  reynolds(strip: VlmStrip): number;
}

export interface CoupledSolution extends VlmSolution {
  /**
   * Viscous section cl per strip (what the strip actually carries): the lattice cl with the
   * converged virtual twist, so it matches stripCirculation and CL. Before stall it equals the
   * polar's cl at stripAlphaEffective within the iteration tolerance. Past stall the artificial
   * viscosity (see CouplingOptions) shifts it on the strips where the virtual twist bends hardest:
   * typically by 0.1-0.4 at a stall front, up to ~0.9 next to a deep-stall region (flaps down,
   * far past stall). stripClPolar has the polar's value for comparison.
   */
  stripClViscous: Float64Array;
  stripAlphaEffective: Float64Array;
  stripCd: Float64Array;
  stripClMax: Float64Array;
  stripStalled: Uint8Array;
  stripAttachedFraction: Float64Array;
  iterations: number;
  converged: boolean;
  /**
   * Geometric angle of attack of each strip's chord line (rad): the angle between the freestream
   * and the streamwise section chord (WingSection axes at the strip centre) in the section's
   * chord/normal plane. Equals alpha + twist on any flat wing, swept or not, alpha * cos(dihedral)
   * + twist (small angles) with dihedral, and the toe/twist alone on a vertical winglet. Flaps
   * are not included (they act through the polar).
   */
  stripAlphaGeometric: Float64Array;
  /** Converged virtual twist per strip (rad). */
  stripVirtualTwist: Float64Array;
  /** Trefftz-plane downwash angle per strip (rad), i.e. VlmSolution.stripAlphaInduced. */
  stripAlphaDownwash: Float64Array;
  /** Polar cl at stripAlphaEffective (Prandtl–Glauert scaled), for comparison with stripClViscous. */
  stripClPolar: Float64Array;
}

export interface CouplingOptions {
  maxIterations: number;
  relaxation: number;
  tolerance: number;
  /**
   * Artificial viscosity (cl per rad of second difference) smoothing the virtual twist along each
   * surface: the converged residual is cl_visc - cl + mu * (delta[j-1] - 2 delta[j] + delta[j+1]).
   * It suppresses the saw-tooth solutions that strip-wise stall models admit past stall and is
   * inert before stall. The iteration first converges with SELECTION_VISCOSITY_FACTOR times this
   * value to select a contiguous stall pattern, then relaxes to it.
   */
  artificialViscosity: number;
}

export const DEFAULT_COUPLING_OPTIONS: CouplingOptions = {
  maxIterations: 60,
  relaxation: 0.4,
  tolerance: 1e-4,
  artificialViscosity: 2,
};

/**
 * The first coupling stage runs with this multiple of CouplingOptions.artificialViscosity: strong
 * smoothing reliably selects one contiguous stall region, and the second stage then relaxes to
 * the requested viscosity. Compared with a single stage at the strong value (the original
 * design, 5), this cuts the worst cl bias over the aircraft presets (flaps 0 and 30 deg, alpha
 * -10..25 deg) from 1.4 to 0.9 and the cases that miss the tolerance from 18 to 6 of 792, while
 * keeping the stall region contiguous (relaxing further, to 1 or 0, brings saw-tooth and split
 * stall patterns back).
 */
export const SELECTION_VISCOSITY_FACTOR = 2.5;

/** Largest virtual-twist change per strip per iteration (rad). */
const MAX_TWIST_STEP = 0.1;
/** Step for the finite-difference polar slope (rad). */
const SLOPE_STEP = 0.005;

/** In-place Gaussian elimination with partial pivoting: solves a x = b, overwriting a and b. */
function solveSmallDense(a: Float64Array, b: Float64Array, n: number): void {
  for (let k = 0; k < n; k++) {
    let p = k;
    let max = Math.abs(a[k * n + k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]!);
      if (v > max) {
        max = v;
        p = i;
      }
    }
    if (max < 1e-300) {
      b[k] = 0;
      continue;
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = a[k * n + j]!;
        a[k * n + j] = a[p * n + j]!;
        a[p * n + j] = t;
      }
      const t = b[k]!;
      b[k] = b[p]!;
      b[p] = t;
    }
    const piv = a[k * n + k]!;
    for (let i = k + 1; i < n; i++) {
      const f = a[i * n + k]! / piv;
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) a[i * n + j] = a[i * n + j]! - f * a[k * n + j]!;
      b[i] = b[i]! - f * b[k]!;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < n; j++) s -= a[i * n + j]! * b[j]!;
    const d = a[i * n + i]!;
    b[i] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
}

/**
 * Nonlinear VLM: iterate per-strip virtual twist so each strip's inviscid cl matches its viscous
 * polar cl at the strip's effective alpha. Converges to the linear solution when nothing stalls.
 *
 * Effective angle. A strip's effective angle is the angle at which a 2D section would make the
 * lift the lattice gives that strip:  alpha_eff = alpha0 + beta * cl_lattice / (2 pi) - delta,
 * where delta is the strip's virtual twist and 2 pi / beta is the lattice's own 2D lift slope
 * (exact for the 1/4-3/4 rule). On a straight high-aspect-ratio wing this equals geometric angle
 * minus Trefftz downwash; on swept or non-planar strips it also carries the sweep and 3D losses
 * the lattice resolves, so coupling never undoes them. alpha0 is the polar's zero-lift angle, so
 * the flap (already modelled as camber in the lattice) is counted once: in the linear range the
 * coupled solution equals the linear lattice whenever the polar slope is 2 pi.
 *
 * Section cl is Prandtl–Glauert scaled: cl_visc = polar.cl(alpha_eff) / beta.
 *
 * Iteration. The lattice response of every strip's cl to every strip's virtual twist is
 * precomputed (VlmSolverData.twistResponse*), so each iteration is a small dense (right-half
 * strips only) Newton step on r = cl_visc - cl_lattice + mu * L(delta), where L is the spanwise
 * second difference along each surface (artificial viscosity: it picks the smooth, contiguous
 * stall pattern among the many that strip models admit past stall, and is inert before stall
 * where delta is ~0 or smooth). Two stages: mu = SELECTION_VISCOSITY_FACTOR * artificialViscosity
 * to select the pattern, then mu = artificialViscosity from there; each stage may use up to
 * maxIterations, and `converged` refers to the final stage. Negative post-stall polar slopes are clamped to zero in the
 * Jacobian, so the iteration walks away from unstable roots and settles only on stable branches.
 * The step starts at `relaxation`, grows by 1.5x per iteration up to a full step, halves when the
 * dominant residual flips sign (oscillation), and is capped at MAX_TWIST_STEP per strip.
 * Each call starts from delta = 0, so results do not depend on call history.
 * The solve is symmetric by construction. Typical cost: ~0.2 ms attached, ~1 ms in stall.
 */
export function solveCoupled(
  model: VlmModel,
  alpha: number,
  provider: StripPolarProvider,
  options?: Partial<CouplingOptions>,
): CoupledSolution {
  const opts: CouplingOptions = { ...DEFAULT_COUPLING_OPTIONS, ...options };
  const Ns = model.halfStripCount;
  const sd = model.solver;
  const beta = model.beta;
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const twoPi = 2 * Math.PI;
  const mu0 = Math.max(0, opts.artificialViscosity);
  let mu = mu0;

  const linear = solveVlm(model, { alpha });

  // Per-strip polar data (right half).
  const polars: SectionPolar[] = [];
  const re = new Float64Array(Ns);
  const alpha0 = new Float64Array(Ns);
  const clLin = new Float64Array(Ns);
  for (let j = 0; j < Ns; j++) {
    const strip = model.strips[j]!;
    polars.push(provider.polar(strip));
    re[j] = provider.reynolds(strip);
    alpha0[j] = polars[j]!.alphaZeroLift;
    clLin[j] = linear.stripCl[j]!;
  }

  // Strip cl response to virtual twist at this alpha: M[i][j] = d cl_i / d delta_j.
  const M = new Float64Array(Ns * Ns);
  for (let i = 0; i < Ns; i++) {
    const c = model.strips[i]!.chord;
    const f = c > 0 ? 2 / c : 0;
    for (let j = 0; j < Ns; j++) {
      const k = i * Ns + j;
      M[k] = f * (ca * sd.twistResponseCos[k]! + sa * sd.twistResponseSin[k]!);
    }
  }

  const delta = new Float64Array(Ns);
  const clInv = new Float64Array(Ns);
  const alphaEff = new Float64Array(Ns);
  const clVisc = new Float64Array(Ns);
  const slope = new Float64Array(Ns);
  const resid = new Float64Array(Ns);
  const jac = new Float64Array(Ns * Ns);
  const step = new Float64Array(Ns);
  const clampAlpha = (a: number) => Math.min(Math.PI, Math.max(-Math.PI, a));

  /** Evaluate cl_inv, alpha_eff, cl_visc and the residual at the current delta; returns max |r|. */
  const evaluate = (withSlope: boolean): number => {
    let rmax = 0;
    for (let i = 0; i < Ns; i++) {
      let cl = clLin[i]!;
      const row = i * Ns;
      for (let j = 0; j < Ns; j++) cl += M[row + j]! * delta[j]!;
      clInv[i] = cl;
      const ae = clampAlpha(alpha0[i]! + (beta * cl) / twoPi - delta[i]!);
      alphaEff[i] = ae;
      const pol = polars[i]!;
      clVisc[i] = pol.cl(ae, re[i]!) / beta;
      if (withSlope) {
        slope[i] =
          (pol.cl(ae + SLOPE_STEP, re[i]!) - pol.cl(ae - SLOPE_STEP, re[i]!)) / (2 * SLOPE_STEP);
      }
      const prev = sd.stripPrev[i]!;
      const next = sd.stripNext[i]!;
      const d = delta[i]!;
      const lap = (prev >= 0 ? delta[prev]! : d) + (next >= 0 ? delta[next]! : d) - 2 * d;
      const r = clVisc[i]! - cl + mu * lap;
      resid[i] = r;
      rmax = Math.max(rmax, Math.abs(r));
    }
    return rmax;
  };

  let iterations = 0;
  let converged = false;
  // Stage 1 picks the stall pattern with SELECTION_VISCOSITY_FACTOR x the viscosity, stage 2
  // relaxes to the requested viscosity from there (see the function doc).
  for (const stageMu of [SELECTION_VISCOSITY_FACTOR * mu0, mu0]) {
    mu = stageMu;
    let rmax = evaluate(true);
    let omega = Math.min(1, Math.max(0.05, opts.relaxation));
    converged = rmax < opts.tolerance;
    let it = 0;
    while (!converged && it < opts.maxIterations) {
      it++;
      iterations++;
      // Jacobian dr/ddelta with post-stall slopes clamped at zero (stable branches only).
      for (let i = 0; i < Ns; i++) {
        const s = Math.max(0, slope[i]!);
        const row = i * Ns;
        const fm = s / twoPi - 1;
        for (let j = 0; j < Ns; j++) jac[row + j] = M[row + j]! * fm;
        jac[row + i] = jac[row + i]! - s / beta;
        const prev = sd.stripPrev[i]!;
        const next = sd.stripNext[i]!;
        if (prev >= 0) {
          jac[row + prev] = jac[row + prev]! + mu;
          jac[row + i] = jac[row + i]! - mu;
        }
        if (next >= 0) {
          jac[row + next] = jac[row + next]! + mu;
          jac[row + i] = jac[row + i]! - mu;
        }
        step[i] = -resid[i]!;
      }
      solveSmallDense(jac, step, Ns);
      let smax = 0;
      for (let i = 0; i < Ns; i++) smax = Math.max(smax, Math.abs(step[i]!));
      const scale = smax * omega > MAX_TWIST_STEP ? MAX_TWIST_STEP / smax : omega;
      for (let i = 0; i < Ns; i++) delta[i] = delta[i]! + scale * step[i]!;
      let jmax = 0;
      for (let i = 1; i < Ns; i++) if (Math.abs(resid[i]!) > Math.abs(resid[jmax]!)) jmax = i;
      const before = resid[jmax]!;
      rmax = evaluate(true);
      omega = before * resid[jmax]! < 0 ? Math.max(0.1, omega * 0.5) : Math.min(1, omega * 1.5);
      converged = rmax < opts.tolerance;
    }
  }

  // Final lattice solve with the converged virtual twist (both halves).
  const fullDelta = new Float64Array(2 * Ns);
  fullDelta.set(delta);
  fullDelta.set(delta, Ns);
  const sol = solveVlm(model, { alpha, stripIncidence: fullDelta });

  const n2 = 2 * Ns;
  const stripClViscous = new Float64Array(n2);
  const stripClPolar = new Float64Array(n2);
  const stripAlphaEffective = new Float64Array(n2);
  const stripAlphaGeometric = new Float64Array(n2);
  const stripAlphaInduced = new Float64Array(n2);
  const stripCd = new Float64Array(n2);
  const stripClMax = new Float64Array(n2);
  const stripStalled = new Uint8Array(n2);
  const stripAttachedFraction = new Float64Array(n2);
  const stripAlphaDownwash = Float64Array.from(sol.stripAlphaInduced);
  for (let j = 0; j < Ns; j++) {
    const pol = polars[j]!;
    const r = re[j]!;
    const ae = clampAlpha(alpha0[j]! + (beta * sol.stripCl[j]!) / twoPi - delta[j]!);
    const cd = sd.stripChordDir;
    const sn = sd.stripSectionNormal;
    const vc = ca * cd[3 * j]! + sa * cd[3 * j + 2]!;
    const vn = ca * sn[3 * j]! + sa * sn[3 * j + 2]!;
    const ag = Math.atan2(vn, vc);
    const as = pol.alphaStall(r);
    const a0 = alpha0[j]!;
    const values = [
      [stripClViscous, sol.stripCl[j]!],
      [stripClPolar, pol.cl(ae, r) / beta],
      [stripAlphaEffective, ae],
      [stripAlphaGeometric, ag],
      [stripAlphaInduced, ag - ae],
      [stripCd, pol.cd(ae, r)],
      [stripClMax, pol.clMax(r) / beta],
      [stripAttachedFraction, pol.attachedFraction(ae, r)],
    ] as const;
    for (const [arr, v] of values) arr[j] = arr[j + Ns] = v;
    stripStalled[j] = stripStalled[j + Ns] = ae > as || ae < 2 * a0 - as ? 1 : 0;
  }

  return {
    ...sol,
    stripAlphaInduced,
    stripClViscous,
    stripAlphaEffective,
    stripCd,
    stripClMax,
    stripStalled,
    stripAttachedFraction,
    iterations,
    converged,
    stripAlphaGeometric,
    stripVirtualTwist: fullDelta,
    stripAlphaDownwash,
    stripClPolar,
  };
}
