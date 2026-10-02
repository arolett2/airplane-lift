/**
 * Pure wing lofting: WingGeometry (sections in the body frame) -> triangle mesh arrays.
 *
 * No three.js and no DOM: the output is plain typed arrays so the whole thing is unit-testable
 * in node. `WingMesh` uploads the arrays to a BufferGeometry.
 *
 * Conventions (see physics/types.ts):
 *  - A section's airfoil point (x, y) maps to `le + chord * (x * chordDir + y * normalDir)`.
 *  - On the right side the span tangent is t = (0, cos roll, sin roll), the normal
 *    n = (0, -sin roll, cos roll), and chordDir is +x rotated about t by `twist`. The left side
 *    is the exact mirror (y -> -y) of the same formulas, with the left section's own `le`.
 *  - Between sections everything is interpolated linearly (as `interpolateSection` does in the
 *    physics module): le, chord, twist, roll and the NACA parameters. A spanwise segment is
 *    flapped / slatted only if BOTH bounding sections have it; the inboard section's flap is used.
 *
 * Per-vertex attributes let the renderer colour the surface from strip results without knowing
 * anything about the lofting: surface index, spanwise parameter `u`, chordwise x/c, upper/lower
 * flag and the vertex kind (skin, end cap or slat).
 */
import { generateAirfoil } from '../../physics/airfoil/naca';
import type {
  FlapState,
  LiftingSurface,
  Naca4Params,
  Vec3,
  WingGeometry,
  WingSection,
} from '../../physics/types';

export const DEFAULT_CONTOUR_PANELS = 80;
export const DEFAULT_SUBDIVISIONS = 10;

/** Vertex kinds stored in `LoftedWing.kind`. */
export const VERTEX_SKIN = 0;
export const VERTEX_CAP = 1;
export const VERTEX_SLAT = 2;

export interface LoftOptions {
  /** Airfoil contour panels (points per ring = even(panels) + 1). Default 80. */
  contourPanels?: number;
  /** Spanwise subdivisions per segment between sections. Default 10. */
  subdivisions?: number;
  /** Build the drooped leading-edge slat slivers for slatted segments. Default true. */
  slats?: boolean;
}

export interface LoftedSurfaceInfo {
  id: string;
  side: 'right' | 'left';
  role: LiftingSurface['role'];
  vertexStart: number;
  vertexCount: number;
  /** Number of skin rings (spanwise stations incl. duplicated flap-edge rings). */
  ringCount: number;
  /** Vertices per skin ring. */
  ringSize: number;
}

export interface LoftedWing {
  vertexCount: number;
  /** xyz, body frame (meters). */
  positions: Float32Array;
  /** Unit vertex normals, outward. */
  normals: Float32Array;
  /** Triangle list, counter-clockwise seen from outside. */
  indices: Uint32Array;
  /** Index into `surfaces` for each vertex. */
  surfaceIndex: Uint16Array;
  /**
   * Spanwise parameter 0 (root end) .. 1 (outboard end): normalised arc length along the
   * surface's quarter-chord line. Matches strips of the same surface by cumulative width.
   */
  u: Float32Array;
  /** Chordwise position x/c of the vertex (0 LE .. 1 TE). */
  xc: Float32Array;
  /** 1 on the upper surface (including the LE point), 0 on the lower. */
  upper: Uint8Array;
  /** VERTEX_SKIN | VERTEX_CAP | VERTEX_SLAT. */
  kind: Uint8Array;
  surfaces: LoftedSurfaceInfo[];
}

/* ------------------------------------------------------------------------------------------ */
/* Section axes                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Chord direction and surface normal of a section (unit vectors, body frame).
 * `side === 'left'` mirrors the right-hand formulas in y.
 */
export function sectionAxes(
  roll: number,
  twist: number,
  side: 'right' | 'left',
  outChord: Vec3,
  outNormal: Vec3,
): void {
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ct = Math.cos(twist);
  const st = Math.sin(twist);
  // Rodrigues rotation of +x (and of the untwisted normal) about the span tangent.
  outChord[0] = ct;
  outChord[1] = sr * st;
  outChord[2] = -cr * st;
  outNormal[0] = st;
  outNormal[1] = -sr * ct;
  outNormal[2] = cr * ct;
  if (side === 'left') {
    outChord[1] = -outChord[1];
    outNormal[1] = -outNormal[1];
  }
}

interface SectionSample {
  le: Vec3;
  chord: number;
  twist: number;
  roll: number;
  airfoil: Naca4Params;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sampleSection(a: WingSection, b: WingSection, t: number): SectionSample {
  return {
    le: [lerp(a.le[0], b.le[0], t), lerp(a.le[1], b.le[1], t), lerp(a.le[2], b.le[2], t)],
    chord: lerp(a.chord, b.chord, t),
    twist: lerp(a.twist, b.twist, t),
    roll: lerp(a.roll, b.roll, t),
    airfoil: {
      camber: lerp(a.airfoil.camber, b.airfoil.camber, t),
      camberPos: lerp(a.airfoil.camberPos, b.airfoil.camberPos, t),
      thickness: lerp(a.airfoil.thickness, b.airfoil.thickness, t),
    },
  };
}

function sameFlap(a: FlapState | null, b: FlapState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.chordFrac === b.chordFrac && a.deflection === b.deflection;
}

/* ------------------------------------------------------------------------------------------ */
/* Contours                                                                                    */
/* ------------------------------------------------------------------------------------------ */

interface Contour {
  /** Interleaved x,y (unit chord). */
  xy: Float64Array;
  n: number;
  leIndex: number;
}

/** Contour cache keyed by airfoil parameters + flap, valid for a single loft call. */
class ContourCache {
  private readonly map = new Map<string, Contour>();
  constructor(private readonly panels: number) {}

  get(params: Naca4Params, flap: FlapState | null): Contour {
    const key = `${params.camber.toFixed(5)}|${params.camberPos.toFixed(4)}|${params.thickness.toFixed(5)}|${
      flap ? `${flap.chordFrac.toFixed(4)}|${flap.deflection.toFixed(5)}` : '-'
    }`;
    let c = this.map.get(key);
    if (!c) {
      const g = generateAirfoil(params, this.panels, flap);
      c = { xy: g.coords, n: g.nPoints, leIndex: g.leIndex };
      this.map.set(key, c);
    }
    return c;
  }
}

/**
 * Closed crescent for a deployed leading-edge slat, in unit-chord airfoil coordinates, ordered
 * like the airfoil contour (lower -> nose -> upper, then back along the inner concave side) so
 * the same lofting and winding rules apply. Slightly drooped (nose down) and set ahead of the LE.
 */
const SLAT_ARC_POINTS = 9;
function buildSlatContour(): Float64Array {
  const droop = 0.22; // rad, nose down
  const shiftX = -0.008;
  const B: [number, number] = [0.045, -0.04];
  const T: [number, number] = [0.05, 0.052];
  const Co: [number, number] = [-0.12, 0.006];
  const Ci: [number, number] = [-0.045, 0.006];
  const pts: number[] = [];
  const bez = (p0: [number, number], c: [number, number], p1: [number, number], s: number) => {
    const m = 1 - s;
    return [
      m * m * p0[0] + 2 * m * s * c[0] + s * s * p1[0],
      m * m * p0[1] + 2 * m * s * c[1] + s * s * p1[1],
    ] as const;
  };
  const push = (p: readonly [number, number]) => {
    // Rotate nose-down about the nominal LE then shift forward.
    const x = p[0] * Math.cos(droop) - p[1] * Math.sin(droop) + shiftX;
    const y = p[0] * Math.sin(droop) + p[1] * Math.cos(droop);
    pts.push(x, y);
  };
  for (let k = 0; k < SLAT_ARC_POINTS; k++) push(bez(B, Co, T, k / (SLAT_ARC_POINTS - 1)));
  // Inner side from T back toward B, excluding both end points (shared with the outer arc).
  for (let k = 1; k < SLAT_ARC_POINTS - 1; k++) push(bez(T, Ci, B, k / (SLAT_ARC_POINTS - 1)));
  return Float64Array.from(pts);
}
const SLAT_CONTOUR = buildSlatContour();
const SLAT_RING_SIZE = SLAT_CONTOUR.length / 2;

/* ------------------------------------------------------------------------------------------ */
/* Growable mesh builder                                                                       */
/* ------------------------------------------------------------------------------------------ */

function growF32(arr: Float32Array, n: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(n);
  next.set(arr);
  return next;
}
function growU8(arr: Uint8Array, n: number): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(n);
  next.set(arr);
  return next;
}
function growU16(arr: Uint16Array, n: number): Uint16Array<ArrayBuffer> {
  const next = new Uint16Array(n);
  next.set(arr);
  return next;
}
function growU32(arr: Uint32Array, n: number): Uint32Array<ArrayBuffer> {
  const next = new Uint32Array(n);
  next.set(arr);
  return next;
}

class MeshBuilder {
  vertexCount = 0;
  indexCount = 0;
  private cap = 4096;
  private icap = 16384;
  positions = new Float32Array(this.cap * 3);
  normals = new Float32Array(this.cap * 3);
  u = new Float32Array(this.cap);
  xc = new Float32Array(this.cap);
  upper = new Uint8Array(this.cap);
  kind = new Uint8Array(this.cap);
  surfaceIndex = new Uint16Array(this.cap);
  indices = new Uint32Array(this.icap);

  private ensureVertices(extra: number): void {
    const need = this.vertexCount + extra;
    if (need <= this.cap) return;
    let c = this.cap;
    while (c < need) c *= 2;
    this.positions = growF32(this.positions, c * 3);
    this.normals = growF32(this.normals, c * 3);
    this.u = growF32(this.u, c);
    this.xc = growF32(this.xc, c);
    this.upper = growU8(this.upper, c);
    this.kind = growU8(this.kind, c);
    this.surfaceIndex = growU16(this.surfaceIndex, c);
    this.cap = c;
  }

  private ensureIndices(extra: number): void {
    const need = this.indexCount + extra;
    if (need <= this.icap) return;
    let c = this.icap;
    while (c < need) c *= 2;
    this.indices = growU32(this.indices, c);
    this.icap = c;
  }

  addVertex(
    x: number,
    y: number,
    z: number,
    surface: number,
    u: number,
    xc: number,
    upper: number,
    kind: number,
  ): number {
    this.ensureVertices(1);
    const i = this.vertexCount++;
    this.positions[3 * i] = x;
    this.positions[3 * i + 1] = y;
    this.positions[3 * i + 2] = z;
    this.surfaceIndex[i] = surface;
    this.u[i] = u;
    this.xc[i] = xc;
    this.upper[i] = upper;
    this.kind[i] = kind;
    return i;
  }

  addTriangle(a: number, b: number, c: number): void {
    this.ensureIndices(3);
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  /** Area-weighted smooth normals over vertices [v0, v1) from triangles [t0, t1) (index slots). */
  accumulateNormals(v0: number, v1: number, t0: number, t1: number): void {
    const p = this.positions;
    const n = this.normals;
    for (let i = 3 * v0; i < 3 * v1; i++) n[i] = 0;
    for (let t = t0; t < t1; t += 3) {
      const a = this.indices[t]! * 3;
      const b = this.indices[t + 1]! * 3;
      const c = this.indices[t + 2]! * 3;
      const e1x = p[b]! - p[a]!;
      const e1y = p[b + 1]! - p[a + 1]!;
      const e1z = p[b + 2]! - p[a + 2]!;
      const e2x = p[c]! - p[a]!;
      const e2y = p[c + 1]! - p[a + 1]!;
      const e2z = p[c + 2]! - p[a + 2]!;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      for (const o of [a, b, c]) {
        n[o] = n[o]! + nx;
        n[o + 1] = n[o + 1]! + ny;
        n[o + 2] = n[o + 2]! + nz;
      }
    }
    for (let v = v0; v < v1; v++) {
      const i = 3 * v;
      const len = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
      if (len > 1e-20) {
        n[i] = n[i]! / len;
        n[i + 1] = n[i + 1]! / len;
        n[i + 2] = n[i + 2]! / len;
      } else {
        n[i] = 0;
        n[i + 1] = 0;
        n[i + 2] = 1;
      }
    }
  }

  /** Reverse winding of triangles [t0, t1) and negate normals of vertices [v0, v1). */
  flip(v0: number, v1: number, t0: number, t1: number): void {
    for (let t = t0; t < t1; t += 3) {
      const tmp = this.indices[t + 1]!;
      this.indices[t + 1] = this.indices[t + 2]!;
      this.indices[t + 2] = tmp;
    }
    for (let i = 3 * v0; i < 3 * v1; i++) this.normals[i] = -this.normals[i]!;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Surface loft                                                                                */
/* ------------------------------------------------------------------------------------------ */

interface RingPlan {
  seg: number;
  t: number;
  flap: FlapState | null;
  u: number;
}

/** A ring's vertex positions and local frame, kept for caps and orientation tests. */
interface RingInfo {
  start: number;
  centroid: Vec3;
}

const _chord: Vec3 = [1, 0, 0];
const _normal: Vec3 = [0, 0, 1];

/** Place a unit-chord contour on a section sample, adding vertices to the builder. */
function addRingVertices(
  b: MeshBuilder,
  sample: SectionSample,
  side: 'right' | 'left',
  contourXY: Float64Array,
  n: number,
  leIndex: number,
  surface: number,
  u: number,
  kind: number,
  slat: boolean,
): RingInfo {
  sectionAxes(sample.roll, sample.twist, side, _chord, _normal);
  const c = sample.chord;
  const start = b.vertexCount;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let j = 0; j < n; j++) {
    const ax = contourXY[2 * j]!;
    const ay = contourXY[2 * j + 1]!;
    const px = sample.le[0] + c * (ax * _chord[0] + ay * _normal[0]);
    const py = sample.le[1] + c * (ax * _chord[1] + ay * _normal[1]);
    const pz = sample.le[2] + c * (ax * _chord[2] + ay * _normal[2]);
    cx += px;
    cy += py;
    cz += pz;
    // Slat vertices are neutral: they sit at the leading edge, upper flag by height.
    const xcVal = slat ? 0.02 : ax;
    const upperFlag = slat ? (ay >= 0 ? 1 : 0) : j >= leIndex ? 1 : 0;
    b.addVertex(px, py, pz, surface, u, xcVal, upperFlag, kind);
  }
  return { start, centroid: [cx / n, cy / n, cz / n] };
}

/**
 * Add a flat end cap built from paired contour points (a_k, b_k): the cap vertices are
 * duplicates of the ring (flat normal `dir`), triangulated as a strip between the pairs.
 */
function addCap(
  b: MeshBuilder,
  ring: RingInfo,
  n: number,
  pairs: ReadonlyArray<readonly [number, number]>,
  dir: Vec3,
  surface: number,
  kind: number = VERTEX_CAP,
): void {
  const capStart = b.vertexCount;
  for (let j = 0; j < n; j++) {
    const src = ring.start + j;
    const i = b.addVertex(
      b.positions[3 * src]!,
      b.positions[3 * src + 1]!,
      b.positions[3 * src + 2]!,
      surface,
      b.u[src]!,
      b.xc[src]!,
      b.upper[src]!,
      kind,
    );
    b.normals[3 * i] = dir[0];
    b.normals[3 * i + 1] = dir[1];
    b.normals[3 * i + 2] = dir[2];
  }
  for (let k = 0; k + 1 < pairs.length; k++) {
    const [a0, b0] = pairs[k]!;
    const [a1, b1] = pairs[k + 1]!;
    const tris: Array<[number, number, number]> = [
      [capStart + a0, capStart + b0, capStart + a1],
      [capStart + b0, capStart + b1, capStart + a1],
    ];
    for (const [i0, i1, i2] of tris) {
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      // Orient by the desired outward direction.
      const p = b.positions;
      const e1x = p[3 * i1]! - p[3 * i0]!;
      const e1y = p[3 * i1 + 1]! - p[3 * i0 + 1]!;
      const e1z = p[3 * i1 + 2]! - p[3 * i0 + 2]!;
      const e2x = p[3 * i2]! - p[3 * i0]!;
      const e2y = p[3 * i2 + 1]! - p[3 * i0 + 1]!;
      const e2z = p[3 * i2 + 2]! - p[3 * i0 + 2]!;
      const d =
        (e1y * e2z - e1z * e2y) * dir[0] +
        (e1z * e2x - e1x * e2z) * dir[1] +
        (e1x * e2y - e1y * e2x) * dir[2];
      if (d >= 0) b.addTriangle(i0, i1, i2);
      else b.addTriangle(i0, i2, i1);
    }
  }
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Quarter-chord point of a section (body frame). */
function quarterChordPoint(s: WingSection, side: 'right' | 'left'): Vec3 {
  sectionAxes(s.roll, s.twist, side, _chord, _normal);
  return [
    s.le[0] + 0.25 * s.chord * _chord[0],
    s.le[1] + 0.25 * s.chord * _chord[1],
    s.le[2] + 0.25 * s.chord * _chord[2],
  ];
}

function loftSurfaceInto(
  b: MeshBuilder,
  surface: LiftingSurface,
  surfaceIdx: number,
  cache: ContourCache,
  nSubBase: number,
  withSlats: boolean,
): LoftedSurfaceInfo {
  const secs = surface.sections;
  const side = surface.side;
  const vertexStart = b.vertexCount;
  const info: LoftedSurfaceInfo = {
    id: surface.id,
    side,
    role: surface.role,
    vertexStart,
    vertexCount: 0,
    ringCount: 0,
    ringSize: 0,
  };
  if (secs.length < 2) return info;

  // Arc length of the quarter-chord line, for the spanwise parameter u.
  const q = secs.map((s) => quarterChordPoint(s, side));
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < secs.length; i++) {
    const l = Math.hypot(q[i + 1]![0] - q[i]![0], q[i + 1]![1] - q[i]![1], q[i + 1]![2] - q[i]![2]);
    segLen.push(l);
    total += l;
  }

  // Ring plan: nSub+1 rings per segment, shared at segment boundaries unless the flap differs.
  const rings: RingPlan[] = [];
  const stepAfter: boolean[] = []; // stepAfter[r]: rings r and r+1 are a flap-edge "step"
  const segFlap: Array<FlapState | null> = [];
  const segSlat: boolean[] = [];
  const segU0: number[] = [];
  const segU1: number[] = [];
  let cum = 0;
  for (let s = 0; s + 1 < secs.length; s++) {
    const a = secs[s]!;
    const c = secs[s + 1]!;
    const flap = a.flap && c.flap ? a.flap : null;
    segFlap.push(flap);
    segSlat.push(a.slat && c.slat);
    segU0.push(total > 0 ? cum / total : s / (secs.length - 1));
    segU1.push(total > 0 ? (cum + segLen[s]!) / total : (s + 1) / (secs.length - 1));
    const dRoll = Math.abs(c.roll - a.roll);
    const nSub = dRoll > 0.35 ? Math.round(nSubBase * 1.4) : nSubBase;
    for (let k = 0; k <= nSub; k++) {
      const t = k / nSub;
      if (s > 0 && k === 0 && sameFlap(segFlap[s - 1]!, flap)) continue; // shared ring
      const u = total > 0 ? (cum + t * segLen[s]!) / total : (s + t) / (secs.length - 1);
      if (s > 0 && k === 0) stepAfter[rings.length - 1] = true;
      rings.push({ seg: s, t, flap, u });
      stepAfter[rings.length - 1] = false;
    }
    cum += segLen[s]!;
  }

  // Skin vertices.
  const ringInfos: RingInfo[] = [];
  let ringSize = 0;
  let leIndex = 0;
  const contoursUsed: Contour[] = [];
  for (const r of rings) {
    const sample = sampleSection(secs[r.seg]!, secs[r.seg + 1]!, r.t);
    const contour = cache.get(sample.airfoil, r.flap);
    ringSize = contour.n;
    leIndex = contour.leIndex;
    contoursUsed.push(contour);
    ringInfos.push(
      addRingVertices(
        b,
        sample,
        side,
        contour.xy,
        contour.n,
        contour.leIndex,
        surfaceIdx,
        r.u,
        VERTEX_SKIN,
        false,
      ),
    );
  }

  // Skin faces (smooth segments only; flap-edge steps are appended after the normals).
  const skinT0 = b.indexCount;
  const N = ringSize;
  const quad = (r0: number, r1: number) => {
    const s0 = ringInfos[r0]!.start;
    const s1 = ringInfos[r1]!.start;
    for (let j = 0; j + 1 < N; j++) {
      const a = s0 + j;
      const bb = s0 + j + 1;
      const c = s1 + j;
      const d = s1 + j + 1;
      b.addTriangle(a, bb, c);
      b.addTriangle(bb, d, c);
    }
  };
  for (let r = 0; r + 1 < rings.length; r++) if (!stepAfter[r]) quad(r, r + 1);
  const skinT1 = b.indexCount;
  const skinV1 = b.vertexCount;
  b.accumulateNormals(vertexStart, skinV1, skinT0, skinT1);

  // Orientation: normals should point away from each ring's centroid. Flip if they do not.
  let outward = 0;
  for (const ring of ringInfos) {
    for (let j = 0; j < N; j++) {
      const v = ring.start + j;
      outward +=
        b.normals[3 * v]! * (b.positions[3 * v]! - ring.centroid[0]) +
        b.normals[3 * v + 1]! * (b.positions[3 * v + 1]! - ring.centroid[1]) +
        b.normals[3 * v + 2]! * (b.positions[3 * v + 2]! - ring.centroid[2]);
    }
  }
  const flipped = outward < 0;
  if (flipped) b.flip(vertexStart, skinV1, skinT0, skinT1);

  // Flap-edge steps: connect duplicated rings so the surface stays watertight.
  for (let r = 0; r + 1 < rings.length; r++) {
    if (!stepAfter[r]) continue;
    const s0 = ringInfos[r]!.start;
    const s1 = ringInfos[r + 1]!.start;
    for (let j = 0; j + 1 < N; j++) {
      const a = s0 + j;
      const bb = s0 + j + 1;
      const c = s1 + j;
      const d = s1 + j + 1;
      if (flipped) {
        b.addTriangle(a, c, bb);
        b.addTriangle(bb, c, d);
      } else {
        b.addTriangle(a, bb, c);
        b.addTriangle(bb, d, c);
      }
    }
  }

  // End caps: pair lower_m with upper_m (m = 0 at the LE .. half at the TE).
  const half = leIndex;
  const pairs: Array<readonly [number, number]> = [];
  for (let m = 0; m <= half; m++) pairs.push([leIndex - m, leIndex + m]);
  const last = ringInfos.length - 1;
  const tipDir = normalize3([
    q[secs.length - 1]![0] - q[secs.length - 2]![0],
    q[secs.length - 1]![1] - q[secs.length - 2]![1],
    q[secs.length - 1]![2] - q[secs.length - 2]![2],
  ]);
  addCap(b, ringInfos[last]!, N, pairs, tipDir, surfaceIdx);
  const rootDir = normalize3([q[0]![0] - q[1]![0], q[0]![1] - q[1]![1], q[0]![2] - q[1]![2]]);
  const rootAtCentreline = Math.abs(secs[0]!.le[1]) < 1e-3 * Math.max(1e-6, secs[0]!.chord);
  if (!(surface.role === 'wing' && rootAtCentreline)) {
    addCap(b, ringInfos[0]!, N, pairs, rootDir, surfaceIdx);
  }

  // Leading-edge slat slivers.
  if (withSlats) {
    for (let s = 0; s + 1 < secs.length; s++) {
      if (!segSlat[s]) continue;
      addSlatSliver(b, secs[s]!, secs[s + 1]!, side, surfaceIdx, flipped, segU0[s]!, segU1[s]!);
    }
  }

  info.vertexCount = b.vertexCount - vertexStart;
  info.ringCount = rings.length;
  info.ringSize = N;
  return info;
}

/** A drooped slat crescent along one slatted segment, lofted over a few spanwise rings. */
function addSlatSliver(
  b: MeshBuilder,
  a: WingSection,
  c: WingSection,
  side: 'right' | 'left',
  surfaceIdx: number,
  flip: boolean,
  u0: number,
  u1: number,
): void {
  const nRings = 6;
  const M = SLAT_RING_SIZE;
  const v0 = b.vertexCount;
  const t0 = b.indexCount;
  const infos: RingInfo[] = [];
  for (let k = 0; k < nRings; k++) {
    const t = k / (nRings - 1);
    const sample = sampleSection(a, c, t);
    const u = u0 + t * (u1 - u0);
    infos.push(
      addRingVertices(b, sample, side, SLAT_CONTOUR, M, 0, surfaceIdx, u, VERTEX_SLAT, true),
    );
  }
  for (let k = 0; k + 1 < nRings; k++) {
    const s0 = infos[k]!.start;
    const s1 = infos[k + 1]!.start;
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      b.addTriangle(s0 + j, s0 + j1, s1 + j);
      b.addTriangle(s0 + j1, s1 + j1, s1 + j);
    }
  }
  const v1 = b.vertexCount;
  const t1 = b.indexCount;
  b.accumulateNormals(v0, v1, t0, t1);
  if (flip) b.flip(v0, v1, t0, t1);

  // Closed ends: pair outer arc point k (0..8) with inner arc point (reverse order).
  const arc = SLAT_ARC_POINTS;
  const pairs: Array<readonly [number, number]> = [];
  for (let k = 0; k < arc; k++) {
    // outer index k; inner counterpart: k = 0 and k = arc-1 share the outer end points.
    const inner = k === 0 ? 0 : k === arc - 1 ? arc - 1 : M - k;
    pairs.push([k, inner]);
  }
  const outDir = normalize3([c.le[0] - a.le[0], c.le[1] - a.le[1], c.le[2] - a.le[2]]);
  addCap(b, infos[nRings - 1]!, M, pairs, outDir, surfaceIdx, VERTEX_SLAT);
  addCap(b, infos[0]!, M, pairs, [-outDir[0], -outDir[1], -outDir[2]], surfaceIdx, VERTEX_SLAT);
}

/* ------------------------------------------------------------------------------------------ */
/* Public API                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Loft every surface of a wing geometry into one mesh. */
export function loftWing(geometry: WingGeometry, options: LoftOptions = {}): LoftedWing {
  const panels = options.contourPanels ?? DEFAULT_CONTOUR_PANELS;
  const nSub = Math.max(2, Math.round(options.subdivisions ?? DEFAULT_SUBDIVISIONS));
  const withSlats = options.slats ?? true;
  const cache = new ContourCache(panels);
  const b = new MeshBuilder();
  const surfaces: LoftedSurfaceInfo[] = [];
  geometry.surfaces.forEach((surface, i) => {
    surfaces.push(loftSurfaceInto(b, surface, i, cache, nSub, withSlats));
  });
  const nv = b.vertexCount;
  return {
    vertexCount: nv,
    positions: b.positions.slice(0, nv * 3),
    normals: b.normals.slice(0, nv * 3),
    indices: b.indices.slice(0, b.indexCount),
    surfaceIndex: b.surfaceIndex.slice(0, nv),
    u: b.u.slice(0, nv),
    xc: b.xc.slice(0, nv),
    upper: b.upper.slice(0, nv),
    kind: b.kind.slice(0, nv),
    surfaces,
  };
}

/** Loft a single surface (convenience for tests and tools). */
export function loftSurface(surface: LiftingSurface, options: LoftOptions = {}): LoftedWing {
  const geometry = { surfaces: [surface] } as unknown as WingGeometry;
  return loftWing(geometry, options);
}
