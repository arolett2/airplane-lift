/**
 * Regularised Biot–Savart kernels for straight vortex filaments, semi-infinite trailing legs and
 * straight line sources. Every kernel ADDS its contribution into `acc[0..2]` and loops over a
 * range of packed elements, so the hot loops stay monomorphic and allocation-free.
 *
 * Regularisation: the 1/h^2 singularity of a line vortex at distance h is replaced by
 * 1/sqrt(h^4 + rc^4) (Vatistas n = 2 core), which is exact far away and goes smoothly to zero
 * on the filament itself.
 */

export const INV_4PI = 1 / (4 * Math.PI);

/** Endpoint guard: points closer than this to a filament endpoint skip that filament (m). */
const TINY = 1e-12;

/* ------------------------------------------------------------------------------------------ */
/* Packed layouts                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * Finite vortex segment, stride SEG_STRIDE:
 * [x0, y0, z0, x1, y1, z1, dx, dy, dz, gamma/(4 pi), rc^4 * L^4]
 */
export const SEG_STRIDE = 11;

/** Semi-infinite leg from (x, y, z) to +infinity along +x, stride SEMI_STRIDE: [x, y, z, gamma/(4 pi)]. */
export const SEMI_STRIDE = 4;

/**
 * Finite line source, stride SRC_STRIDE:
 * [x0, y0, z0, ex, ey, ez, L, sigma/(4 pi), rc^2, rc^4]  (e = unit direction p0 -> p1)
 */
export const SRC_STRIDE = 10;

/** Write one finite vortex segment P0 -> P1 with circulation `gamma` at element index `i`. */
export function packSegment(
  out: Float64Array,
  i: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  gamma: number,
  coreRadius: number,
): void {
  const o = i * SEG_STRIDE;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const l2 = dx * dx + dy * dy + dz * dz;
  const rc2 = coreRadius * coreRadius;
  out[o] = x0;
  out[o + 1] = y0;
  out[o + 2] = z0;
  out[o + 3] = x1;
  out[o + 4] = y1;
  out[o + 5] = z1;
  out[o + 6] = dx;
  out[o + 7] = dy;
  out[o + 8] = dz;
  // A degenerate segment contributes nothing.
  out[o + 9] = l2 > 1e-24 ? gamma * INV_4PI : 0;
  out[o + 10] = rc2 * rc2 * l2 * l2;
}

/** Write one semi-infinite leg starting at (x, y, z) running to +x infinity. */
export function packSemi(
  out: Float64Array,
  i: number,
  x: number,
  y: number,
  z: number,
  gamma: number,
): void {
  const o = i * SEMI_STRIDE;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = gamma * INV_4PI;
}

/** Write one line source P0 -> P1 with strength `sigma` per unit length and core radius `rc`. */
export function packSource(
  out: Float64Array,
  i: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  sigma: number,
  rc: number,
): void {
  const o = i * SRC_STRIDE;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const inv = len > 1e-12 ? 1 / len : 0;
  out[o] = x0;
  out[o + 1] = y0;
  out[o + 2] = z0;
  out[o + 3] = dx * inv;
  out[o + 4] = dy * inv;
  out[o + 5] = dz * inv;
  out[o + 6] = len;
  out[o + 7] = len > 1e-12 ? sigma * INV_4PI : 0;
  out[o + 8] = rc * rc;
  out[o + 9] = rc * rc * rc * rc;
}

/* ------------------------------------------------------------------------------------------ */
/* Kernels                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Velocity induced at P by finite vortex segments [start, end) of `seg`:
 * v = G/(4 pi) (r1 x r2) / |r1 x r2|^2 * r0 . (r1/|r1| - r2/|r2|), with the core applied to
 * |r1 x r2|^2 = h^2 L^2  ->  L^2 sqrt(h^4 + rc^4).
 */
export function addSegments(
  seg: Float64Array,
  start: number,
  end: number,
  px: number,
  py: number,
  pz: number,
  acc: Float64Array,
): void {
  let u = 0;
  let v = 0;
  let w = 0;
  for (let i = start; i < end; i++) {
    const o = i * SEG_STRIDE;
    const g = seg[o + 9]!;
    if (g === 0) continue;
    const r1x = px - seg[o]!;
    const r1y = py - seg[o + 1]!;
    const r1z = pz - seg[o + 2]!;
    const r2x = px - seg[o + 3]!;
    const r2y = py - seg[o + 4]!;
    const r2z = pz - seg[o + 5]!;
    const r1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
    const r2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
    if (r1 < TINY || r2 < TINY) continue;
    const cx = r1y * r2z - r1z * r2y;
    const cy = r1z * r2x - r1x * r2z;
    const cz = r1x * r2y - r1y * r2x;
    const c2 = cx * cx + cy * cy + cz * cz;
    const dx = seg[o + 6]!;
    const dy = seg[o + 7]!;
    const dz = seg[o + 8]!;
    const dot = (dx * r1x + dy * r1y + dz * r1z) / r1 - (dx * r2x + dy * r2y + dz * r2z) / r2;
    const k = (g * dot) / Math.sqrt(c2 * c2 + seg[o + 10]!);
    u += k * cx;
    v += k * cy;
    w += k * cz;
  }
  acc[0] = acc[0]! + u;
  acc[1] = acc[1]! + v;
  acc[2] = acc[2]! + w;
}

/**
 * Velocity induced at P by semi-infinite legs [start, end) running from Q to +infinity along +x:
 * v = G/(4 pi) (x^ x r) / |x^ x r|^2 * (1 + r_x/|r|), r = P - Q, regularised like addSegments.
 */
export function addSemiInfinite(
  semi: Float64Array,
  start: number,
  end: number,
  rc4: number,
  px: number,
  py: number,
  pz: number,
  acc: Float64Array,
): void {
  let v = 0;
  let w = 0;
  for (let i = start; i < end; i++) {
    const o = i * SEMI_STRIDE;
    const rx = px - semi[o]!;
    const ry = py - semi[o + 1]!;
    const rz = pz - semi[o + 2]!;
    const h2 = ry * ry + rz * rz;
    const r = Math.sqrt(rx * rx + h2);
    if (r < TINY) continue;
    const k = (semi[o + 3]! * (1 + rx / r)) / Math.sqrt(h2 * h2 + rc4);
    v -= k * rz;
    w += k * ry;
  }
  acc[1] = acc[1]! + v;
  acc[2] = acc[2]! + w;
}

/**
 * Velocity induced at P by finite line sources [start, end) (strength sigma per unit length):
 * radial part sigma/(4 pi) h_vec/h^2 * ((L - a)/|r2| + a/|r1|) and axial part
 * sigma/(4 pi) e (1/|r2| - 1/|r1|), where a = (P - P0).e and h_vec is the perpendicular offset.
 * The radial 1/h^2 gets the same core as the vortices; distances to the ends are softened by rc.
 */
export function addSources(
  src: Float64Array,
  start: number,
  end: number,
  px: number,
  py: number,
  pz: number,
  acc: Float64Array,
): void {
  let u = 0;
  let v = 0;
  let w = 0;
  for (let i = start; i < end; i++) {
    const o = i * SRC_STRIDE;
    const k = src[o + 7]!;
    if (k === 0) continue;
    const r1x = px - src[o]!;
    const r1y = py - src[o + 1]!;
    const r1z = pz - src[o + 2]!;
    const ex = src[o + 3]!;
    const ey = src[o + 4]!;
    const ez = src[o + 5]!;
    const len = src[o + 6]!;
    const rc2 = src[o + 8]!;
    const a = r1x * ex + r1y * ey + r1z * ez;
    const hx = r1x - a * ex;
    const hy = r1y - a * ey;
    const hz = r1z - a * ez;
    const h2 = hx * hx + hy * hy + hz * hz;
    const b = len - a;
    const d1 = Math.sqrt(a * a + h2 + rc2);
    const d2 = Math.sqrt(b * b + h2 + rc2);
    const radial = (k * (b / d2 + a / d1)) / Math.sqrt(h2 * h2 + src[o + 9]!);
    const axial = k * (1 / d2 - 1 / d1);
    u += radial * hx + axial * ex;
    v += radial * hy + axial * ey;
    w += radial * hz + axial * ez;
  }
  acc[0] = acc[0]! + u;
  acc[1] = acc[1]! + v;
  acc[2] = acc[2]! + w;
}
