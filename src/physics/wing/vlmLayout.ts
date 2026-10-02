/**
 * Vortex-lattice layout: turns the RIGHT-side lifting surfaces of a WingGeometry into spanwise
 * strips and chordwise horseshoe panels on the mean camber surface (body frame).
 * The left side is produced later by mirroring (see vlm.ts).
 *
 * Section axes follow WingSection (types.ts), right-side convention:
 *   span tangent t = (0, cos roll, sin roll), base normal n0 = (0, -sin roll, cos roll),
 *   chordDir = +x rotated nose-up by twist about t  = cos(tw) x - sin(tw) n0,
 *   normalDir = n0 rotated the same way              = cos(tw) n0 + sin(tw) x.
 * The airfoil point (x, y) sits at le + chord * (x * chordDir + y * normalDir).
 */
import type { FlapState, LiftingSurface, Naca4Params, Vec3, WingGeometry } from '../types';
import { camberLine, cosineSpacing } from '../airfoil/naca';

/** A section interpolated at an arbitrary spanwise position, with its local axes. */
interface FramedSection {
  le: Vec3;
  chord: number;
  twist: number;
  roll: number;
  airfoil: Naca4Params;
  chordDir: Vec3;
  normalDir: Vec3;
}

/** A right-side strip with everything the solver needs. */
export interface HalfStrip {
  surface: LiftingSurface;
  eta: number;
  width: number;
  chord: number;
  /** Quarter-chord point of the chord line at the strip centre. */
  center: Vec3;
  /** Unit normal of the strip's chord plane (excludes camber and flap). */
  normal: Vec3;
  /** Unit span tangent, outboard. */
  spanTangent: Vec3;
  /** Unit chord direction (LE -> TE) orthogonal to the span tangent. */
  chordDir: Vec3;
  airfoil: Naca4Params;
  flap: FlapState | null;
  slat: boolean;
  twist: number;
  panelStart: number;
  panelCount: number;
  /** Trailing-edge points (camber line) of the inboard (A) and outboard (B) strip edges. */
  teA: Vec3;
  teB: Vec3;
  /** Spanwise position of the control points across the strip (see StripPiece.fc). */
  controlFraction: number;
}

export interface HalfLayout {
  strips: HalfStrip[];
  panelCount: number;
  /** Interleaved xyz, length 3 * panelCount. */
  boundA: Float64Array;
  boundB: Float64Array;
  trailingA: Float64Array;
  trailingB: Float64Array;
  controlPoints: Float64Array;
  normals: Float64Array;
  /** length panelCount */
  panelAreas: Float64Array;
  /** Strip index of each panel. */
  panelStrip: Int32Array;
  /** Chordwise panels per strip. */
  chordwisePanels: number;
  /**
   * Camber-surface points along each strip's inboard (A) and outboard (B) side edge at the
   * chordwise panel stations x_0 = 0 .. x_nc = 1: xyz, (nc + 1) points per strip, strip-major.
   * The trailing legs run along these edges from the bound vortex to the trailing edge.
   */
  edgeA: Float64Array;
  edgeB: Float64Array;
  /** Base-wing semispan measured along the surface in the y-z plane (m). */
  semispanArc: number;
}

export interface LayoutOptions {
  chordwisePanels: number;
  spanwisePanelsWing: number;
  spanwisePanelsDevice: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Small vector helpers (build time only)                                                      */
/* ------------------------------------------------------------------------------------------ */

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 1];
}
function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Section axes (right-side convention) for a twist and roll. */
export function sectionAxes(twist: number, roll: number): { chordDir: Vec3; normalDir: Vec3 } {
  const ct = Math.cos(twist);
  const st = Math.sin(twist);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return {
    chordDir: [ct, st * sr, -st * cr],
    normalDir: [st, -ct * sr, ct * cr],
  };
}

/** Linear interpolation of section k -> k+1 of a surface at fraction f (geometry + axes). */
function framedSection(surface: LiftingSurface, k: number, f: number): FramedSection {
  const s0 = surface.sections[k]!;
  const s1 = surface.sections[k + 1]!;
  const twist = lerp(s0.twist, s1.twist, f);
  const roll = lerp(s0.roll, s1.roll, f);
  const axes = sectionAxes(twist, roll);
  return {
    le: [lerp(s0.le[0], s1.le[0], f), lerp(s0.le[1], s1.le[1], f), lerp(s0.le[2], s1.le[2], f)],
    chord: lerp(s0.chord, s1.chord, f),
    twist,
    roll,
    airfoil: {
      camber: lerp(s0.airfoil.camber, s1.airfoil.camber, f),
      camberPos: lerp(s0.airfoil.camberPos, s1.airfoil.camberPos, f),
      thickness: lerp(s0.airfoil.thickness, s1.airfoil.thickness, f),
    },
    chordDir: axes.chordDir,
    normalDir: axes.normalDir,
  };
}

/**
 * Point on the mean camber surface of a section at chord fraction x. `flaps` lists the flap
 * states whose camber lines are averaged: one entry inside a segment, two on a section shared by
 * segments with different flaps (a flap end), so both neighbouring strips use the same edge.
 */
function camberPoint(s: FramedSection, flaps: readonly (FlapState | null)[], x: number): Vec3 {
  let yc = 0;
  for (const f of flaps) yc += camberLine(s.airfoil, f, x).yc;
  yc /= flaps.length;
  const c = s.chord;
  return [
    s.le[0] + c * (x * s.chordDir[0] + yc * s.normalDir[0]),
    s.le[1] + c * (x * s.chordDir[1] + yc * s.normalDir[1]),
    s.le[2] + c * (x * s.chordDir[2] + yc * s.normalDir[2]),
  ];
}

/** Flap of segment k (between sections k and k+1): needs a flap on both bounding sections. */
function segmentFlap(surface: LiftingSurface, k: number): FlapState | null {
  const s0 = surface.sections[k]!;
  const s1 = surface.sections[k + 1]!;
  return s0.flap && s1.flap ? s0.flap : null;
}

function sameFlap(a: FlapState | null, b: FlapState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.chordFrac === b.chordFrac && a.deflection === b.deflection;
}

/** Quarter-chord point of the chord line (no camber). */
function quarterChord(s: FramedSection): Vec3 {
  const q = 0.25 * s.chord;
  return [s.le[0] + q * s.chordDir[0], s.le[1] + q * s.chordDir[1], s.le[2] + q * s.chordDir[2]];
}

/* ------------------------------------------------------------------------------------------ */
/* Spanwise distribution                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** A strip's extent: segment index and the fractions [f0, f1] within that segment. */
export interface StripPiece {
  segment: number;
  f0: number;
  f1: number;
  /**
   * Where the strip's control point sits across the strip, 0 (inboard edge) .. 1 (outboard edge):
   * the strip's mid-angle in the cosine parameter (semicircle method), 0.5 near the root and
   * 0.75 at the tip. This removes most of the O(1/N) tip error of a horseshoe lattice.
   */
  fc: number;
}

/**
 * Distribute `n` strips over segments of the given (arc) lengths with half-cosine clustering
 * toward the far end (the tip). Strip edges always land on segment boundaries (sections), so
 * kinks and flap ends are resolved exactly. Every non-degenerate segment gets at least one strip
 * (so the total can exceed n only when there are more segments than strips).
 */
export function distributeStrips(arcs: readonly number[], n: number): StripPiece[] {
  const total = arcs.reduce((s, a) => s + a, 0);
  if (!(total > 0)) return [];
  // Cumulative arc fraction u at each section, and the cosine parameter g(u) = (2/pi) asin(u):
  // strips uniform in g are clustered toward u = 1.
  const g = (u: number) => (2 / Math.PI) * Math.asin(Math.min(1, Math.max(0, u)));
  const u: number[] = [0];
  for (let k = 0; k < arcs.length; k++) u.push(u[k]! + arcs[k]! / total);
  u[arcs.length] = 1;
  const valid = arcs.map((a) => a > 1e-9 * total);
  const raw = arcs.map((_, k) => n * (g(u[k + 1]!) - g(u[k]!)));
  const counts = raw.map((r, k) => (valid[k] ? Math.max(1, Math.floor(r)) : 0));
  let deficit = n - counts.reduce((s, c) => s + c, 0);
  while (deficit > 0) {
    let best = -1;
    for (let k = 0; k < arcs.length; k++)
      if (valid[k] && (best < 0 || raw[k]! - counts[k]! > raw[best]! - counts[best]!)) best = k;
    if (best < 0) break;
    counts[best]!++;
    deficit--;
  }
  while (deficit < 0) {
    let best = -1;
    for (let k = 0; k < arcs.length; k++)
      if (counts[k]! > 1 && (best < 0 || raw[k]! - counts[k]! < raw[best]! - counts[best]!))
        best = k;
    if (best < 0) break;
    counts[best]!--;
    deficit++;
  }

  const pieces: StripPiece[] = [];
  for (let k = 0; k < arcs.length; k++) {
    const m = counts[k]!;
    if (m === 0) continue;
    const u0 = u[k]!;
    const u1 = u[k + 1]!;
    const g0 = g(u0);
    const g1 = g(u1);
    const fAt = (i: number) => {
      if (i === 0) return 0;
      if (i === m) return 1;
      const ui = Math.sin((Math.PI / 2) * (g0 + ((g1 - g0) * i) / m));
      return Math.min(1, Math.max(0, (ui - u0) / (u1 - u0)));
    };
    for (let i = 0; i < m; i++) {
      const f0 = fAt(i);
      const f1 = fAt(i + 1);
      const fc = f1 > f0 ? (fAt(i + 0.5) - f0) / (f1 - f0) : 0.5;
      pieces.push({ segment: k, f0, f1, fc });
    }
  }
  return pieces;
}

/** Spanwise arc length of each segment, measured in the y-z plane (independent of sweep). */
export function segmentArcs(surface: LiftingSurface): number[] {
  const arcs: number[] = [];
  for (let k = 0; k + 1 < surface.sections.length; k++) {
    const a = surface.sections[k]!.le;
    const b = surface.sections[k + 1]!.le;
    arcs.push(Math.hypot(b[1] - a[1], b[2] - a[2]));
  }
  return arcs;
}

/* ------------------------------------------------------------------------------------------ */
/* Layout                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Build strips and panels for every right-side surface of the geometry. */
export function layoutHalfWing(geometry: WingGeometry, options: LayoutOptions): HalfLayout {
  const right = geometry.surfaces.filter((s) => s.side === 'right' && s.sections.length >= 2);
  const wings = right.filter((s) => s.role === 'wing');
  const wingArcs = wings.map((s) => segmentArcs(s).reduce((a, b) => a + b, 0));
  const totalWingArc = wingArcs.reduce((a, b) => a + b, 0);
  const semispanArc = totalWingArc > 0 ? totalWingArc : Math.max(geometry.referenceSpan / 2, 1e-6);
  const nc = Math.max(1, Math.round(options.chordwisePanels));
  const xs = cosineSpacing(nc);

  // Strip pieces per surface (+ the eta offset where each surface starts).
  const plans: { surface: LiftingSurface; pieces: StripPiece[]; arcs: number[]; eta0: number }[] =
    [];
  let wingArcSoFar = 0;
  for (const surface of right) {
    const arcs = segmentArcs(surface);
    const arc = arcs.reduce((a, b) => a + b, 0);
    let n: number;
    let eta0: number;
    if (surface.role === 'wing') {
      const share = totalWingArc > 0 ? arc / totalWingArc : 1;
      n = Math.max(1, Math.round(options.spanwisePanelsWing * share));
      eta0 = wingArcSoFar / semispanArc;
      wingArcSoFar += arc;
    } else {
      n = Math.max(1, Math.round(options.spanwisePanelsDevice));
      eta0 = 1;
    }
    plans.push({ surface, pieces: distributeStrips(arcs, n), arcs, eta0 });
  }

  const stripCount = plans.reduce((s, p) => s + p.pieces.length, 0);
  const panelCount = stripCount * nc;
  const boundA = new Float64Array(3 * panelCount);
  const boundB = new Float64Array(3 * panelCount);
  const trailingA = new Float64Array(3 * panelCount);
  const trailingB = new Float64Array(3 * panelCount);
  const controlPoints = new Float64Array(3 * panelCount);
  const normals = new Float64Array(3 * panelCount);
  const panelAreas = new Float64Array(panelCount);
  const panelStrip = new Int32Array(panelCount);
  const edgeA = new Float64Array(3 * (nc + 1) * stripCount);
  const edgeB = new Float64Array(3 * (nc + 1) * stripCount);
  const strips: HalfStrip[] = [];

  const put = (arr: Float64Array, p: number, v: Vec3) => {
    arr[3 * p] = v[0];
    arr[3 * p + 1] = v[1];
    arr[3 * p + 2] = v[2];
  };

  let p = 0;
  for (const { surface, pieces, arcs, eta0 } of plans) {
    const cumArc: number[] = [0];
    for (let k = 0; k < arcs.length; k++) cumArc.push(cumArc[k]! + arcs[k]!);
    for (const piece of pieces) {
      const k = piece.segment;
      const s0 = surface.sections[k]!;
      const s1 = surface.sections[k + 1]!;
      const flap = segmentFlap(surface, k);
      const slat = s0.slat && s1.slat;
      // Edge camber: on a section shared with a differently-flapped segment, average the two
      // so the neighbours' trailing legs coincide (else the wake gets a spurious vortex dipole
      // along the flap end; the real sheet's vertical step there carries no vorticity).
      const nSeg = surface.sections.length - 1;
      const flapsA =
        piece.f0 === 0 && k > 0 && !sameFlap(segmentFlap(surface, k - 1), flap)
          ? [segmentFlap(surface, k - 1), flap]
          : [flap];
      const flapsB =
        piece.f1 === 1 && k + 1 < nSeg && !sameFlap(segmentFlap(surface, k + 1), flap)
          ? [flap, segmentFlap(surface, k + 1)]
          : [flap];
      const fm = 0.5 * (piece.f0 + piece.f1);
      const ea = framedSection(surface, k, piece.f0);
      const eb = framedSection(surface, k, piece.f1);
      const ec = framedSection(surface, k, fm);

      const qa = quarterChord(ea);
      const qb = quarterChord(eb);
      const span = sub(qb, qa);
      const width = norm(span);
      const t = normalize(span);
      const cd = normalize(sub(ec.chordDir, scaleVec(t, dot(ec.chordDir, t))));
      const normal = normalize(cross(cd, t));
      const teA = camberPoint(ea, flapsA, 1);
      const teB = camberPoint(eb, flapsB, 1);

      const panelStart = p;
      for (let k = 0; k <= nc; k++) {
        const o = 3 * ((nc + 1) * strips.length + k);
        edgeA.set(camberPoint(ea, flapsA, xs[k]!), o);
        edgeB.set(camberPoint(eb, flapsB, xs[k]!), o);
      }
      const stripIndex = strips.length;
      for (let i = 0; i < nc; i++, p++) {
        const x0 = xs[i]!;
        const x1 = xs[i + 1]!;
        const xq = x0 + 0.25 * (x1 - x0);
        const x3 = x0 + 0.75 * (x1 - x0);
        put(boundA, p, camberPoint(ea, flapsA, xq));
        put(boundB, p, camberPoint(eb, flapsB, xq));
        put(trailingA, p, teA);
        put(trailingB, p, teB);
        const pa3 = camberPoint(ea, flapsA, x3);
        const pb3 = camberPoint(eb, flapsB, x3);
        const fc = piece.fc;
        put(controlPoints, p, [
          pa3[0] + fc * (pb3[0] - pa3[0]),
          pa3[1] + fc * (pb3[1] - pa3[1]),
          pa3[2] + fc * (pb3[2] - pa3[2]),
        ]);
        // Normal of the local camber surface: chordwise tangent (camber slope in the centre
        // section's axes) crossed with the spanwise tangent through the control point.
        const slope = camberLine(ec.airfoil, flap, x3).slope;
        const tc: Vec3 = [
          ec.chordDir[0] + slope * ec.normalDir[0],
          ec.chordDir[1] + slope * ec.normalDir[1],
          ec.chordDir[2] + slope * ec.normalDir[2],
        ];
        put(normals, p, normalize(cross(tc, sub(pb3, pa3))));
        const pa0 = camberPoint(ea, flapsA, x0);
        const pa1 = camberPoint(ea, flapsA, x1);
        const pb0 = camberPoint(eb, flapsB, x0);
        const pb1 = camberPoint(eb, flapsB, x1);
        panelAreas[p] = 0.5 * norm(cross(sub(pb1, pa0), sub(pb0, pa1)));
        panelStrip[p] = stripIndex;
      }

      const arcMid = cumArc[k]! + fm * arcs[k]!;
      strips.push({
        surface,
        eta: eta0 + arcMid / semispanArc,
        width,
        chord: ec.chord,
        center: quarterChord(ec),
        normal,
        spanTangent: t,
        chordDir: cd,
        airfoil: ec.airfoil,
        flap,
        slat,
        twist: ec.twist,
        panelStart,
        panelCount: nc,
        teA,
        teB,
        controlFraction: piece.fc,
      });
    }
  }

  return {
    strips,
    panelCount,
    boundA,
    boundB,
    trailingA,
    trailingB,
    controlPoints,
    normals,
    panelAreas,
    panelStrip,
    chordwisePanels: nc,
    edgeA,
    edgeB,
    semispanArc,
  };
}

function scaleVec(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
