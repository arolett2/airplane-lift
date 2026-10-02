/**
 * Fast inside/outside test for the pitched wing (all surfaces incl. tip devices), plus a
 * "push out" used by streamline tracing to slide along the surface instead of piercing it.
 *
 * Each spanwise segment (between two consecutive sections) is a ruled solid: for a body-frame
 * point we find the spanwise fraction s from the signed distances to the two section planes,
 * interpolate the section frame at s, and compare the point's airfoil coordinates (xi, zeta)
 * against the local upper and lower surface heights, read from precomputed tables.
 *
 * The tables hold the airfoil contour exactly as the wing mesh draws it (`surfacePoint`: the
 * half-thickness is laid off PERPENDICULAR to the camber line), resampled at fixed xi stations.
 * Laying the thickness off vertically instead would make the solid up to ~3% of the chord thinner
 * than the drawn wing on a deflected flap or a strongly cambered nose, and smoke would visibly
 * run through the skin there.
 */
import type { FlapState, Naca4Params, WingGeometry } from '../types';
import { camberLine, nacaHalfThickness, surfacePoint } from '../airfoil/naca';
import { sectionAxes, segmentFlap } from './wingFrames';

/** Table resolution in u = sqrt(xi) (clusters samples at the blunt leading edge). */
const TABLE_N = 64;
/** Parametric samples per surface used to resample the contour onto the table stations. */
const CONTOUR_SAMPLES = 400;
/** Push-out clearance above the surface, as a fraction of local chord. */
const PUSH_MARGIN = 0.004;

// Per-segment packed data, BODY frame.
const LE0 = 0;
const LE1 = 3;
const C0 = 6;
const C1 = 7;
const CD0 = 8;
const CD1 = 11;
const ND0 = 14;
const ND1 = 17;
const T0 = 20;
const T1 = 23;
const BB = 26; // minx, miny, minz, maxx, maxy, maxz
const STRIDE = 32;

/**
 * Upper and lower surface heights (airfoil frame, unit chord) of the drawn contour at the table
 * stations xi_j = (j / (TABLE_N - 1))^2, written to upper/lower at offset `o`. Where the contour
 * crosses a station more than once (only possible right at a strongly cambered nose) the outer
 * crossing wins.
 */
function contourTables(
  airfoil: Naca4Params,
  flap: FlapState | null,
  upper: Float64Array,
  lower: Float64Array,
  o: number,
): void {
  const xs = new Float64Array(CONTOUR_SAMPLES + 1);
  const ys = new Float64Array(CONTOUR_SAMPLES + 1);
  for (const isUpper of [true, false]) {
    const out = isUpper ? upper : lower;
    for (let k = 0; k <= CONTOUR_SAMPLES; k++) {
      const xc = (k / CONTOUR_SAMPLES) ** 2;
      const [x, y] = surfacePoint(airfoil, flap, xc, isUpper);
      xs[k] = x;
      ys[k] = y;
    }
    for (let j = 0; j < TABLE_N; j++) {
      const u = j / (TABLE_N - 1);
      const xi = u * u;
      let best = Number.NaN;
      for (let k = 0; k < CONTOUR_SAMPLES; k++) {
        const x0 = xs[k]!;
        const x1 = xs[k + 1]!;
        if ((xi < x0 && xi < x1) || (xi > x0 && xi > x1)) continue;
        const t = x1 !== x0 ? (xi - x0) / (x1 - x0) : 0;
        const y = ys[k]! + t * (ys[k + 1]! - ys[k]!);
        if (Number.isNaN(best) || (isUpper ? y > best : y < best)) best = y;
      }
      if (Number.isNaN(best)) {
        // Not crossed (cannot happen for a NACA contour): fall back to a vertical offset.
        const yt = nacaHalfThickness(airfoil.thickness, xi);
        best = camberLine(airfoil, flap, xi).yc + (isUpper ? yt : -yt);
      }
      out[o + j] = best;
    }
  }
}

export class WingSolid {
  readonly segCount: number;
  private readonly data: Float64Array;
  /** Surface tables: segment k, end e (0 inboard, 1 outboard) at (2k + e) * TABLE_N. */
  private readonly upper: Float64Array;
  private readonly lower: Float64Array;
  private readonly px: number;
  private readonly pz: number;
  private readonly ca: number;
  private readonly sa: number;
  /** Overall body-frame bounds. */
  private readonly bounds = new Float64Array([
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ]);

  // Scratch from surfaceAt().
  private yu = 0;
  private yl = 0;
  // Scratch from the last successful locate().
  private hitK = 0;
  private hitS = 0;
  private hitXi = 0;
  private hitZeta = 0;
  private hitUpper = 0;
  private hitLower = 0;
  private hitChord = 0;
  private hitNx = 0;
  private hitNy = 0;
  private hitNz = 0;
  private hitLx = 0;
  private hitLy = 0;
  private hitLz = 0;
  private hitCx = 0;
  private hitCy = 0;
  private hitCz = 0;
  private bx = 0;
  private by = 0;
  private bz = 0;

  constructor(geometry: WingGeometry, alpha: number) {
    const segs: { surfaceIndex: number; i: number }[] = [];
    geometry.surfaces.forEach((surf, si) => {
      for (let i = 0; i + 1 < surf.sections.length; i++) segs.push({ surfaceIndex: si, i });
    });
    this.segCount = segs.length;
    this.data = new Float64Array(Math.max(1, segs.length) * STRIDE);
    this.upper = new Float64Array(Math.max(1, segs.length) * 2 * TABLE_N);
    this.lower = new Float64Array(Math.max(1, segs.length) * 2 * TABLE_N);
    this.px = geometry.pivot[0];
    this.pz = geometry.pivot[2];
    this.ca = Math.cos(alpha);
    this.sa = Math.sin(alpha);

    segs.forEach(({ surfaceIndex, i }, k) => {
      const surf = geometry.surfaces[surfaceIndex]!;
      const flap = segmentFlap(surf, i);
      const d = this.data;
      const o = k * STRIDE;
      const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let e = 0; e < 2; e++) {
        const sec = surf.sections[i + e]!;
        const ax = sectionAxes(sec.le, sec.chord, sec.twist, sec.roll, surf.side);
        const put = (off: number, v: readonly number[]) => {
          d[o + off] = v[0]!;
          d[o + off + 1] = v[1]!;
          d[o + off + 2] = v[2]!;
        };
        put(e === 0 ? LE0 : LE1, ax.le);
        put(e === 0 ? CD0 : CD1, ax.chordDir);
        put(e === 0 ? ND0 : ND1, ax.normalDir);
        put(e === 0 ? T0 : T1, ax.spanDir);
        d[o + (e === 0 ? C0 : C1)] = sec.chord;
        const tab = (2 * k + e) * TABLE_N;
        contourTables(sec.airfoil, flap, this.upper, this.lower, tab);
        for (let j = 0; j < TABLE_N; j++) {
          const u = j / (TABLE_N - 1);
          const xi = u * u;
          for (const zeta of [this.lower[tab + j]!, this.upper[tab + j]!]) {
            for (let c = 0; c < 3; c++) {
              const p = ax.le[c]! + sec.chord * (xi * ax.chordDir[c]! + zeta * ax.normalDir[c]!);
              bb[c] = Math.min(bb[c]!, p);
              bb[c + 3] = Math.max(bb[c + 3]!, p);
            }
          }
        }
      }
      for (let c = 0; c < 6; c++) {
        const pad = 1e-6 * (1 + Math.abs(bb[c]!));
        d[o + BB + c] = bb[c]! + (c < 3 ? -pad : pad);
        this.bounds[c] =
          c < 3
            ? Math.min(this.bounds[c]!, d[o + BB + c]!)
            : Math.max(this.bounds[c]!, d[o + BB + c]!);
      }
    });
  }

  /** True when the tunnel-frame point lies inside any surface's thickness envelope. */
  contains(x: number, y: number, z: number): boolean {
    this.toBody(x, y, z);
    return this.locate() >= 0;
  }

  /**
   * If the tunnel-frame point p is inside the wing, move it just outside along the local section
   * normal. It leaves through the surface on the side of `from` (the line's previous point, so a
   * step that dived deep into a thin flap comes back out where it went in rather than crossing
   * it), or through the nearer surface without `from`. `nudge` (in local chords) additionally
   * moves it toward the trailing edge, which frees a line stuck against the leading edge (where
   * the flow runs into the nose). Returns false if it is still inside.
   */
  pushOut(p: Float64Array, nudge = 0, from?: Float64Array): boolean {
    let side = 0;
    for (let iter = 0; iter < 4; iter++) {
      this.toBody(p[0]!, p[1]!, p[2]!);
      if (this.locate() < 0) return true;
      if (side === 0) {
        if (from) {
          // Which side of the (thin, possibly deflected) section `from` lies on, measured at
          // its own chord station in the hit's section frame.
          const fdx = from[0]! - this.px;
          const fdz = from[2]! - this.pz;
          const fx = this.px + fdx * this.ca - fdz * this.sa - this.hitLx;
          const fy = from[1]! - this.hitLy;
          const fz = this.pz + fdx * this.sa + fdz * this.ca - this.hitLz;
          const c = this.hitChord;
          const xi = (fx * this.hitCx + fy * this.hitCy + fz * this.hitCz) / c;
          const zeta = (fx * this.hitNx + fy * this.hitNy + fz * this.hitNz) / c;
          this.surfaceAt(this.hitK, this.hitS, xi);
          side = zeta >= 0.5 * (this.yu + this.yl) ? 1 : -1;
        } else {
          side = this.hitUpper - this.hitZeta <= this.hitZeta - this.hitLower ? 1 : -1;
        }
      }
      const target = side > 0 ? this.hitUpper + PUSH_MARGIN : this.hitLower - PUSH_MARGIN;
      const shift = (target - this.hitZeta) * this.hitChord;
      let tx = 0;
      let ty = 0;
      let tz = 0;
      if (iter === 0 && nudge !== 0) {
        // Along the local mid-surface (follows a deflected flap), toward the trailing edge.
        const xi0 = Math.max(0, this.hitXi - 0.01);
        const xi1 = Math.min(1, this.hitXi + 0.01);
        this.surfaceAt(this.hitK, this.hitS, xi0);
        const m0 = this.yu + this.yl;
        this.surfaceAt(this.hitK, this.hitS, xi1);
        const slope = (0.5 * (this.yu + this.yl - m0)) / Math.max(xi1 - xi0, 1e-9);
        const scale = (nudge * this.hitChord) / Math.sqrt(1 + slope * slope);
        tx = scale * (this.hitCx + slope * this.hitNx);
        ty = scale * (this.hitCy + slope * this.hitNy);
        tz = scale * (this.hitCz + slope * this.hitNz);
      }
      const bx = this.bx + shift * this.hitNx + tx;
      const by = this.by + shift * this.hitNy + ty;
      const bz = this.bz + shift * this.hitNz + tz;
      // Body -> tunnel.
      const dx = bx - this.px;
      const dz = bz - this.pz;
      p[0] = this.px + dx * this.ca + dz * this.sa;
      p[1] = by;
      p[2] = this.pz - dx * this.sa + dz * this.ca;
    }
    this.toBody(p[0]!, p[1]!, p[2]!);
    return this.locate() < 0;
  }

  private toBody(x: number, y: number, z: number): void {
    const dx = x - this.px;
    const dz = z - this.pz;
    this.bx = this.px + dx * this.ca - dz * this.sa;
    this.by = y;
    this.bz = this.pz + dx * this.sa + dz * this.ca;
  }

  /** Upper and lower surface heights (unit chord) of segment k at span fraction s, chord xi. */
  private surfaceAt(k: number, s: number, xi: number): void {
    const fu = Math.sqrt(xi < 0 ? 0 : xi > 1 ? 1 : xi) * (TABLE_N - 1);
    let j = Math.floor(fu);
    if (j > TABLE_N - 2) j = TABLE_N - 2;
    const w = fu - j;
    const r = 1 - s;
    const tab0 = 2 * k * TABLE_N + j;
    const tab1 = tab0 + TABLE_N;
    const up = this.upper;
    const lo = this.lower;
    this.yu =
      r * (up[tab0]! + w * (up[tab0 + 1]! - up[tab0]!)) +
      s * (up[tab1]! + w * (up[tab1 + 1]! - up[tab1]!));
    this.yl =
      r * (lo[tab0]! + w * (lo[tab0 + 1]! - lo[tab0]!)) +
      s * (lo[tab1]! + w * (lo[tab1 + 1]! - lo[tab1]!));
  }

  /** Index of a segment containing the current body point, or -1. Fills the hit scratch. */
  private locate(): number {
    const { bx, by, bz } = this;
    const b = this.bounds;
    if (bx < b[0]! || by < b[1]! || bz < b[2]! || bx > b[3]! || by > b[4]! || bz > b[5]!) {
      return -1;
    }
    const d = this.data;
    for (let k = 0; k < this.segCount; k++) {
      const o = k * STRIDE;
      if (
        bx < d[o + BB]! ||
        by < d[o + BB + 1]! ||
        bz < d[o + BB + 2]! ||
        bx > d[o + BB + 3]! ||
        by > d[o + BB + 4]! ||
        bz > d[o + BB + 5]!
      ) {
        continue;
      }
      // Signed distances to the two section planes (positive = outboard).
      const f0 =
        d[o + T0]! * (bx - d[o + LE0]!) +
        d[o + T0 + 1]! * (by - d[o + LE0 + 1]!) +
        d[o + T0 + 2]! * (bz - d[o + LE0 + 2]!);
      const f1 =
        d[o + T1]! * (bx - d[o + LE1]!) +
        d[o + T1 + 1]! * (by - d[o + LE1 + 1]!) +
        d[o + T1 + 2]! * (bz - d[o + LE1 + 2]!);
      if (f0 < -1e-9 || f1 > 1e-9) continue;
      const den = f0 - f1;
      let s = den > 1e-15 ? f0 / den : 0.5;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const r = 1 - s;
      const lx = r * d[o + LE0]! + s * d[o + LE1]!;
      const ly = r * d[o + LE0 + 1]! + s * d[o + LE1 + 1]!;
      const lz = r * d[o + LE0 + 2]! + s * d[o + LE1 + 2]!;
      const chord = r * d[o + C0]! + s * d[o + C1]!;
      let cx = r * d[o + CD0]! + s * d[o + CD1]!;
      let cy = r * d[o + CD0 + 1]! + s * d[o + CD1 + 1]!;
      let cz = r * d[o + CD0 + 2]! + s * d[o + CD1 + 2]!;
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
      cx /= cl;
      cy /= cl;
      cz /= cl;
      const qx = bx - lx;
      const qy = by - ly;
      const qz = bz - lz;
      const xi = (qx * cx + qy * cy + qz * cz) / chord;
      if (xi < 0 || xi > 1) continue;
      let nx = r * d[o + ND0]! + s * d[o + ND1]!;
      let ny = r * d[o + ND0 + 1]! + s * d[o + ND1 + 1]!;
      let nz = r * d[o + ND0 + 2]! + s * d[o + ND1 + 2]!;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const zeta = (qx * nx + qy * ny + qz * nz) / chord;
      this.surfaceAt(k, s, xi);
      const yu = this.yu;
      if (zeta > yu) continue;
      const yl = this.yl;
      if (zeta >= yl) {
        this.hitK = k;
        this.hitS = s;
        this.hitXi = xi;
        this.hitZeta = zeta;
        this.hitUpper = yu;
        this.hitLower = yl;
        this.hitChord = chord;
        this.hitNx = nx;
        this.hitNy = ny;
        this.hitNz = nz;
        this.hitLx = lx;
        this.hitLy = ly;
        this.hitLz = lz;
        this.hitCx = cx;
        this.hitCy = cy;
        this.hitCz = cz;
        return k;
      }
    }
    return -1;
  }
}

const solidCache = new WeakMap<WingGeometry, { alpha: number; solid: WingSolid }>();

/** Memoised WingSolid for (geometry, alpha). */
export function getWingSolid(geometry: WingGeometry, alpha: number): WingSolid {
  const e = solidCache.get(geometry);
  if (e && e.alpha === alpha) return e.solid;
  const solid = new WingSolid(geometry, alpha);
  solidCache.set(geometry, { alpha, solid });
  return solid;
}

/** A fast (x, y, z) => inside test for the pitched wing, tunnel frame. */
export function createWingSolidTester(
  geometry: WingGeometry,
  alpha: number,
): (x: number, y: number, z: number) => boolean {
  const solid = new WingSolid(geometry, alpha);
  return (x, y, z) => solid.contains(x, y, z);
}
