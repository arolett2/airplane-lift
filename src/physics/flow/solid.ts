/**
 * Fast inside/outside test for the pitched wing (all surfaces incl. tip devices), plus a
 * "push out" used by streamline tracing to slide along the surface instead of piercing it.
 *
 * Each spanwise segment (between two consecutive sections) is a ruled solid: for a body-frame
 * point we find the spanwise fraction s from the signed distances to the two section planes,
 * interpolate the section frame at s, and compare the point's airfoil coordinates (xi, zeta)
 * against the local camber line and half-thickness, read from precomputed tables.
 */
import type { WingGeometry } from '../types';
import { camberLine, nacaHalfThickness } from '../airfoil/naca';
import { sectionAxes, segmentFlap } from './wingFrames';

/** Table resolution in u = sqrt(xi) (clusters samples at the blunt leading edge). */
const TABLE_N = 48;
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
const TH0 = 26;
const TH1 = 27;
const BB = 28; // minx, miny, minz, maxx, maxy, maxz
const STRIDE = 34;

/** Half-thickness of a unit-t NACA section at u = sqrt(xi) table stations. */
const baseThickness = (() => {
  const t = new Float64Array(TABLE_N);
  for (let i = 0; i < TABLE_N; i++) {
    const u = i / (TABLE_N - 1);
    t[i] = nacaHalfThickness(1, u * u);
  }
  return t;
})();

export class WingSolid {
  readonly segCount: number;
  private readonly data: Float64Array;
  /** Camber tables: segment k, end e (0 inboard, 1 outboard) at (2k + e) * TABLE_N. */
  private readonly camber: Float64Array;
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

  // Scratch from the last successful locate().
  private hitZeta = 0;
  private hitYc = 0;
  private hitYt = 0;
  private hitChord = 0;
  private hitNx = 0;
  private hitNy = 0;
  private hitNz = 0;
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
    this.camber = new Float64Array(Math.max(1, segs.length) * 2 * TABLE_N);
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
        d[o + (e === 0 ? TH0 : TH1)] = sec.airfoil.thickness;
        const tab = (2 * k + e) * TABLE_N;
        for (let j = 0; j < TABLE_N; j++) {
          const u = j / (TABLE_N - 1);
          const xi = u * u;
          const yc = camberLine(sec.airfoil, flap, xi).yc;
          this.camber[tab + j] = yc;
          const yt = sec.airfoil.thickness * baseThickness[j]!;
          for (const zeta of [yc - yt, yc + yt]) {
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
   * normal (to the nearer of the upper/lower surface). Returns false if it is still inside.
   */
  pushOut(p: Float64Array): boolean {
    for (let iter = 0; iter < 4; iter++) {
      this.toBody(p[0]!, p[1]!, p[2]!);
      if (this.locate() < 0) return true;
      const target =
        this.hitZeta >= this.hitYc
          ? this.hitYc + this.hitYt + PUSH_MARGIN
          : this.hitYc - this.hitYt - PUSH_MARGIN;
      const shift = (target - this.hitZeta) * this.hitChord;
      const bx = this.bx + shift * this.hitNx;
      const by = this.by + shift * this.hitNy;
      const bz = this.bz + shift * this.hitNz;
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
      // Table lookup in u = sqrt(xi).
      const fu = Math.sqrt(xi) * (TABLE_N - 1);
      let j = Math.floor(fu);
      if (j > TABLE_N - 2) j = TABLE_N - 2;
      const w = fu - j;
      const tab0 = 2 * k * TABLE_N;
      const tab1 = tab0 + TABLE_N;
      const yc0 =
        this.camber[tab0 + j]! + w * (this.camber[tab0 + j + 1]! - this.camber[tab0 + j]!);
      const yc1 =
        this.camber[tab1 + j]! + w * (this.camber[tab1 + j + 1]! - this.camber[tab1 + j]!);
      const yc = r * yc0 + s * yc1;
      const thick = r * d[o + TH0]! + s * d[o + TH1]!;
      const yt = thick * (baseThickness[j]! + w * (baseThickness[j + 1]! - baseThickness[j]!));
      if (Math.abs(zeta - yc) <= yt) {
        this.hitZeta = zeta;
        this.hitYc = yc;
        this.hitYt = yt;
        this.hitChord = chord;
        this.hitNx = nx;
        this.hitNy = ny;
        this.hitNz = nz;
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
