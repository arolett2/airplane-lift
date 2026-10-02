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
  /**
   * Axes of the WingSection interpolated at the strip centre (types.ts): the chord direction
   * (+x rotated by twist about the section span tangent), the matching normal, and the section
   * span tangent (0, cos roll, sin roll) itself, about which twist (and virtual twist) rotates.
   * Unlike `chordDir`, these are streamwise: sweep does not tilt them.
   */
  sectionChordDir: Vec3;
  sectionNormal: Vec3;
  twistAxis: Vec3;
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

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
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

/**
 * One side edge of a strip: the section it is cut from, the flap camber lines averaged on it,
 * whether it is a wing root that must lie in the symmetry plane, and an optional transition
 * shift: weight * (from - to), pointwise along the chord. A segment that starts on an edge other
 * than its own inboard section (a device on its parent's tip edge, or a segment stretched back
 * over skipped slivers) blends from that edge (weight 1 at the segment start) to its own sections
 * (weight 0 at its end), so the junction is exact and its skew is spread over the whole segment.
 */
interface StripEdge {
  section: FramedSection;
  flaps: readonly (FlapState | null)[];
  onSymmetryPlane: boolean;
  shift?: { from: StripEdge; to: StripEdge; weight: number };
}

/**
 * Camber-surface point of a strip edge. A root edge on the symmetry plane is projected onto
 * y = 0 along its section span tangent: with dihedral (roll != 0) the section plane is tilted, so
 * camber and twist would otherwise push the root's camber line across y = 0, where it would
 * overlap its own mirror image (crossed root trailing legs pass right next to the root control
 * points, and the error grows without bound as the mesh is refined).
 */
function edgePoint(e: StripEdge, x: number): Vec3 {
  const p = camberPoint(e.section, e.flaps, x);
  const d = edgeShift(e, x);
  p[0] += d[0];
  p[1] += d[1];
  p[2] += d[2];
  if (e.onSymmetryPlane) {
    const ty = Math.cos(e.section.roll);
    const tz = Math.sin(e.section.roll);
    if (Math.abs(ty) > 0.2) p[2] -= (p[1] / ty) * tz;
    p[1] = 0;
  }
  return p;
}

/** The transition shift of an edge at chord fraction x (zero without one). */
function edgeShift(e: StripEdge, x: number): Vec3 {
  if (!e.shift || e.shift.weight === 0) return [0, 0, 0];
  const { from, to, weight } = e.shift;
  return scaleVec(sub(edgePoint(from, x), edgePoint(to, x)), weight);
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
 * (so the total can exceed n only when there are more segments than strips). Segments with
 * `usable[k] === false` get no strips (a gap in the lattice).
 */
export function distributeStrips(
  arcs: readonly number[],
  n: number,
  usable?: readonly boolean[],
): StripPiece[] {
  const total = arcs.reduce((s, a) => s + a, 0);
  if (!(total > 0)) return [];
  // Cumulative arc fraction u at each section, and the cosine parameter g(u) = (2/pi) asin(u):
  // strips uniform in g are clustered toward u = 1.
  const g = (u: number) => (2 / Math.PI) * Math.asin(Math.min(1, Math.max(0, u)));
  const u: number[] = [0];
  for (let k = 0; k < arcs.length; k++) u.push(u[k]! + arcs[k]! / total);
  u[arcs.length] = 1;
  const valid = arcs.map((a, k) => a > 1e-9 * total && usable?.[k] !== false);
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

/**
 * Limits for a usable strip (see edgesUsable): the chordwise run of the edge-to-edge vector per
 * unit spanwise run (tan of the local sweep, ~83 deg), and the largest turn of the spanwise
 * direction between the leading and trailing edge (beyond 90 deg the strip overlaps itself).
 */
export const MAX_SEGMENT_SKEW = 8;
export const MAX_SEGMENT_FOLD = Math.PI / 2;

/**
 * Whether a strip between two edges can carry horseshoes. The edge-to-edge vector d(x) is checked
 * along the chord (x = 0, 1/2, 1). The strip is unusable when, at any station, d runs mostly
 * along the chord (bound vortices nearly parallel to the trailing legs: near-singular influence
 * matrix), or when its spanwise part turns by more than MAX_SEGMENT_FOLD between stations (a
 * strip twisted, rolled or toed so hard over a tiny span that it folds over itself). Both happen
 * only on slivers whose span is a small fraction of their chord, e.g. the blend of a very small
 * winglet on a long tip chord; leaving such a sliver out costs nothing, while keeping it can wreck
 * the whole solution.
 */
function edgesUsable(a: StripEdge, b: StripEdge): boolean {
  const ca = a.section.chordDir;
  const cb = b.section.chordDir;
  const u = normalize([ca[0] + cb[0], ca[1] + cb[1], ca[2] + cb[2]]);
  let first: Vec3 | null = null;
  for (const x of [0, 0.5, 1]) {
    const d = sub(edgePoint(b, x), edgePoint(a, x));
    const along = dot(d, u);
    const perp = sub(d, scaleVec(u, along));
    const p = norm(perp);
    if (!(p > 0) || Math.abs(along) > MAX_SEGMENT_SKEW * p) return false;
    if (!first) first = perp;
    else if (dot(first, perp) < Math.cos(MAX_SEGMENT_FOLD) * norm(first) * p) return false;
  }
  return true;
}

/** Whether segment k of a surface can carry strips (see edgesUsable). */
export function segmentUsable(surface: LiftingSurface, k: number): boolean {
  const flap = [segmentFlap(surface, k)];
  return edgesUsable(
    { section: framedSection(surface, k, 0), flaps: flap, onSymmetryPlane: false },
    { section: framedSection(surface, k, 1), flaps: flap, onSymmetryPlane: false },
  );
}

/**
 * For each right surface, the surface whose tip its root sits on (a tip device on the wing tip),
 * or null. Match: root and tip leading edges within 2% of the larger chord in the y-z plane and
 * within one chord in x.
 */
function findParents(right: readonly LiftingSurface[]): (LiftingSurface | null)[] {
  const parents = right.map((s) => {
    const root = s.sections[0]!;
    let best: LiftingSurface | null = null;
    let bestD = Infinity;
    for (const p of right) {
      if (p === s) continue;
      const tip = p.sections[p.sections.length - 1]!;
      const scale = Math.max(tip.chord, root.chord);
      const d = Math.hypot(root.le[1] - tip.le[1], root.le[2] - tip.le[2]);
      if (d <= 0.02 * scale && Math.abs(root.le[0] - tip.le[0]) <= scale && d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  });
  // No cycles (two surfaces each starting on the other's tip): keep neither link.
  return parents.map((p, i) => (p && parents[right.indexOf(p)] === right[i] ? null : p));
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

  // A surface starting on another's tip (tip device on the wing tip) starts exactly on that
  // surface's last strip edge (see StripEdge.shift), so the two share their trailing legs. With
  // separately built edges (other roll, twist, toe or chord at the junction) one surface's legs
  // land next to the other's control points; the wing's tip strips are only millimetres wide.
  const parentList = findParents(right);
  const parentOf = new Map(right.map((s, i) => [s, parentList[i]!]));
  // Parents before the devices that hang off them (the geometry's order already is, usually).
  const ordered: LiftingSurface[] = [];
  while (ordered.length < right.length) {
    const ready = right.filter((s) => {
      const parent = parentOf.get(s);
      return !ordered.includes(s) && (!parent || ordered.includes(parent));
    });
    ordered.push(...(ready.length > 0 ? ready : right.filter((s) => !ordered.includes(s))));
  }
  // A wing whose root sits on the symmetry plane gets its root edge projected onto y = 0.
  const symTol = 1e-6 * Math.max(geometry.referenceSpan, geometry.overallSpan, 1);
  /** Outboard edge of each surface's last strip, where its devices start. */
  const lastEdge = new Map<LiftingSurface, StripEdge>();

  const boundA: number[] = [];
  const boundB: number[] = [];
  const trailingA: number[] = [];
  const trailingB: number[] = [];
  const controlPoints: number[] = [];
  const normals: number[] = [];
  const panelAreas: number[] = [];
  const panelStrip: number[] = [];
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const strips: HalfStrip[] = [];

  let wingArcSoFar = 0;
  for (const surface of ordered) {
    const parent = parentOf.get(surface) ?? null;
    const arcs = segmentArcs(surface);
    const arc = arcs.reduce((a, b) => a + b, 0);
    const nSeg = arcs.length;
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
    const rootOnSymmetryPlane =
      surface.role === 'wing' && Math.abs(surface.sections[0]!.le[1]) <= symTol;
    const ownEdge = (k: number, f: number): StripEdge => ({
      section: framedSection(surface, k, f),
      flaps: [segmentFlap(surface, k)],
      onSymmetryPlane: rootOnSymmetryPlane && k === 0 && f === 0,
    });

    // Which segments carry strips, decided per segment (so independent of the mesh). A segment
    // starts where the lattice left off: the previous usable segment's end, the parent's last
    // edge (device) or the surface's own root. If it cannot blend from there (see edgesUsable),
    // its own inboard section is tried (leaving a gap), and if that fails too it is skipped and
    // the next segment blends back over it.
    const parentEdge = parent ? lastEdge.get(parent) : undefined;
    let cur: StripEdge = parentEdge ?? ownEdge(0, 0);
    let curIsOwn = !parentEdge;
    const usable: boolean[] = [];
    /** Edge segment k blends from (null: its own inboard section). */
    const blendFrom: (StripEdge | null)[] = [];
    for (let k = 0; k < nSeg; k++) {
      const end = ownEdge(k, 1);
      if (edgesUsable(cur, end)) {
        usable.push(true);
        blendFrom.push(curIsOwn ? null : cur);
      } else if (edgesUsable(ownEdge(k, 0), end)) {
        usable.push(true);
        blendFrom.push(null);
      } else {
        usable.push(false);
        blendFrom.push(null);
        curIsOwn = false;
        continue;
      }
      cur = end;
      curIsOwn = true;
    }
    const pieces = distributeStrips(arcs, n, usable);

    const cumArc: number[] = [0];
    for (let k = 0; k < nSeg; k++) cumArc.push(cumArc[k]! + arcs[k]!);
    let prevB: StripEdge | null = null;
    for (const piece of pieces) {
      const k = piece.segment;
      const s0 = surface.sections[k]!;
      const s1 = surface.sections[k + 1]!;
      const flap = segmentFlap(surface, k);
      const slat = s0.slat && s1.slat;
      // Edge camber: on a section shared with a differently-flapped segment, average the two
      // so the neighbours' trailing legs coincide (else the wake gets a spurious vortex dipole
      // along the flap end; the real sheet's vertical step there carries no vorticity).
      const flapsA =
        piece.f0 === 0 && k > 0 && !sameFlap(segmentFlap(surface, k - 1), flap)
          ? [segmentFlap(surface, k - 1), flap]
          : [flap];
      const flapsB =
        piece.f1 === 1 && k + 1 < nSeg && !sameFlap(segmentFlap(surface, k + 1), flap)
          ? [flap, segmentFlap(surface, k + 1)]
          : [flap];
      const from = blendFrom[k]!;
      const shift = (f: number): StripEdge['shift'] =>
        from && f < 1 ? { from, to: ownEdge(k, 0), weight: 1 - f } : undefined;
      // The first strip of a blended segment starts exactly on the edge it blends from; any other
      // strip starts on the previous strip's outboard edge (they coincide when contiguous).
      const edgeSpecA: StripEdge =
        piece.f0 === 0 && from
          ? from
          : piece.f0 > 0 && prevB
            ? prevB
            : {
                section: framedSection(surface, k, piece.f0),
                flaps: flapsA,
                onSymmetryPlane: rootOnSymmetryPlane && k === 0 && piece.f0 === 0,
              };
      const edgeSpecB: StripEdge = {
        section: framedSection(surface, k, piece.f1),
        flaps: flapsB,
        onSymmetryPlane: false,
        shift: shift(piece.f1),
      };
      prevB = edgeSpecB;
      const ea = edgeSpecA.section;
      const eb = edgeSpecB.section;
      const fm = 0.5 * (piece.f0 + piece.f1);
      const ec = framedSection(surface, k, fm);

      const qa = add(quarterChord(ea), edgeShift(edgeSpecA, 0.25));
      const qb = add(quarterChord(eb), edgeShift(edgeSpecB, 0.25));
      const span = sub(qb, qa);
      const width = norm(span);
      const t = normalize(span);
      const cd = normalize(sub(ec.chordDir, scaleVec(t, dot(ec.chordDir, t))));
      const normal = normalize(cross(cd, t));
      const teA = edgePoint(edgeSpecA, 1);
      const teB = edgePoint(edgeSpecB, 1);

      const panelStart = panelAreas.length;
      for (let m = 0; m <= nc; m++) {
        edgeA.push(...edgePoint(edgeSpecA, xs[m]!));
        edgeB.push(...edgePoint(edgeSpecB, xs[m]!));
      }
      const stripIndex = strips.length;
      const fc = piece.fc;
      for (let i = 0; i < nc; i++) {
        const x0 = xs[i]!;
        const x1 = xs[i + 1]!;
        const xq = x0 + 0.25 * (x1 - x0);
        const x3 = x0 + 0.75 * (x1 - x0);
        boundA.push(...edgePoint(edgeSpecA, xq));
        boundB.push(...edgePoint(edgeSpecB, xq));
        trailingA.push(...teA);
        trailingB.push(...teB);
        const pa3 = edgePoint(edgeSpecA, x3);
        const pb3 = edgePoint(edgeSpecB, x3);
        controlPoints.push(
          pa3[0] + fc * (pb3[0] - pa3[0]),
          pa3[1] + fc * (pb3[1] - pa3[1]),
          pa3[2] + fc * (pb3[2] - pa3[2]),
        );
        // Normal of the local camber surface: chordwise tangent (camber slope in the centre
        // section's axes) crossed with the spanwise tangent through the control point.
        const slope = camberLine(ec.airfoil, flap, x3).slope;
        const tc: Vec3 = [
          ec.chordDir[0] + slope * ec.normalDir[0],
          ec.chordDir[1] + slope * ec.normalDir[1],
          ec.chordDir[2] + slope * ec.normalDir[2],
        ];
        normals.push(...normalize(cross(tc, sub(pb3, pa3))));
        const pa0 = edgePoint(edgeSpecA, x0);
        const pa1 = edgePoint(edgeSpecA, x1);
        const pb0 = edgePoint(edgeSpecB, x0);
        const pb1 = edgePoint(edgeSpecB, x1);
        panelAreas.push(0.5 * norm(cross(sub(pb1, pa0), sub(pb0, pa1))));
        panelStrip.push(stripIndex);
      }

      const arcMid = cumArc[k]! + fm * arcs[k]!;
      strips.push({
        surface,
        eta: eta0 + arcMid / semispanArc,
        width,
        chord: ec.chord,
        center: add(quarterChord(ec), edgeShift({ ...edgeSpecB, shift: shift(fm) }, 0.25)),
        normal,
        spanTangent: t,
        chordDir: cd,
        sectionChordDir: ec.chordDir,
        sectionNormal: ec.normalDir,
        twistAxis: [0, Math.cos(ec.roll), Math.sin(ec.roll)],
        airfoil: ec.airfoil,
        flap,
        slat,
        twist: ec.twist,
        panelStart,
        panelCount: nc,
        teA,
        teB,
        controlFraction: fc,
      });
    }
    if (prevB) lastEdge.set(surface, prevB);
  }

  return {
    strips,
    panelCount: panelAreas.length,
    boundA: Float64Array.from(boundA),
    boundB: Float64Array.from(boundB),
    trailingA: Float64Array.from(trailingA),
    trailingB: Float64Array.from(trailingB),
    controlPoints: Float64Array.from(controlPoints),
    normals: Float64Array.from(normals),
    panelAreas: Float64Array.from(panelAreas),
    panelStrip: Int32Array.from(panelStrip),
    chordwisePanels: nc,
    edgeA: Float64Array.from(edgeA),
    edgeB: Float64Array.from(edgeB),
    semispanArc,
  };
}

function scaleVec(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
