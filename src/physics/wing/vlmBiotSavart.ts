/**
 * Biot–Savart kernels for the vortex-lattice solver.
 *
 * A horseshoe vortex of unit circulation is the closed-at-infinity path
 *   +inf -> TA -> A -> B -> TB -> +inf
 * made of two finite trailing legs (TA -> A and B -> TB), the bound segment A -> B, and two
 * semi-infinite legs parallel to +x. Positive circulation follows that path (right-hand rule).
 *
 * The kernels take scalar coordinates and write into a caller-owned buffer so the AIC loops
 * allocate nothing. Points closer than sqrt(cut2) to a segment's line receive no velocity from
 * that segment: a straight filament induces nothing on its own line, and this also removes the
 * 0/0 at points on a segment or its extension.
 */

const INV_4PI = 1 / (4 * Math.PI);

/**
 * Add the velocity induced at (px,py,pz) by a horseshoe of circulation `strength` into
 * out[o], out[o+1], out[o+2]. Trailing legs run to +infinity along +x.
 */
export function addHorseshoeVelocity(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  tax: number,
  tay: number,
  taz: number,
  tbx: number,
  tby: number,
  tbz: number,
  strength: number,
  cut2: number,
  out: Float64Array,
  o: number,
): void {
  // Vectors from the four nodes to the field point, and their lengths.
  const rax = px - ax;
  const ray = py - ay;
  const raz = pz - az;
  const rbx = px - bx;
  const rby = py - by;
  const rbz = pz - bz;
  const rtax = px - tax;
  const rtay = py - tay;
  const rtaz = pz - taz;
  const rtbx = px - tbx;
  const rtby = py - tby;
  const rtbz = pz - tbz;
  const na = Math.sqrt(rax * rax + ray * ray + raz * raz);
  const nb = Math.sqrt(rbx * rbx + rby * rby + rbz * rbz);
  const nta = Math.sqrt(rtax * rtax + rtay * rtay + rtaz * rtaz);
  const ntb = Math.sqrt(rtbx * rtbx + rtby * rtby + rtbz * rtbz);

  let vx = 0;
  let vy = 0;
  let vz = 0;
  const k = strength * INV_4PI;

  // Finite segment P1 -> P2: v = (r1 x r2)(|r1|+|r2|) / (|r1||r2|(|r1||r2| + r1.r2)).
  // |r1 x r2|^2 = |P2-P1|^2 * dist^2, so the cutoff test needs the segment length squared.
  // Segment TA -> A.
  {
    const lx = ax - tax;
    const ly = ay - tay;
    const lz = az - taz;
    const len2 = lx * lx + ly * ly + lz * lz;
    const cx = rtay * raz - rtaz * ray;
    const cy = rtaz * rax - rtax * raz;
    const cz = rtax * ray - rtay * rax;
    const c2 = cx * cx + cy * cy + cz * cz;
    if (c2 > cut2 * len2) {
      const nn = nta * na;
      const f = (k * (nta + na)) / (nn * (nn + rtax * rax + rtay * ray + rtaz * raz));
      vx += cx * f;
      vy += cy * f;
      vz += cz * f;
    }
  }
  // Bound segment A -> B.
  {
    const lx = bx - ax;
    const ly = by - ay;
    const lz = bz - az;
    const len2 = lx * lx + ly * ly + lz * lz;
    const cx = ray * rbz - raz * rby;
    const cy = raz * rbx - rax * rbz;
    const cz = rax * rby - ray * rbx;
    const c2 = cx * cx + cy * cy + cz * cz;
    if (c2 > cut2 * len2) {
      const nn = na * nb;
      const f = (k * (na + nb)) / (nn * (nn + rax * rbx + ray * rby + raz * rbz));
      vx += cx * f;
      vy += cy * f;
      vz += cz * f;
    }
  }
  // Segment B -> TB.
  {
    const lx = tbx - bx;
    const ly = tby - by;
    const lz = tbz - bz;
    const len2 = lx * lx + ly * ly + lz * lz;
    const cx = rby * rtbz - rbz * rtby;
    const cy = rbz * rtbx - rbx * rtbz;
    const cz = rbx * rtby - rby * rtbx;
    const c2 = cx * cx + cy * cy + cz * cz;
    if (c2 > cut2 * len2) {
      const nn = nb * ntb;
      const f = (k * (nb + ntb)) / (nn * (nn + rbx * rtbx + rby * rtby + rbz * rtbz));
      vx += cx * f;
      vy += cy * f;
      vz += cz * f;
    }
  }
  // Semi-infinite leg from Q to +inf along +x: v = (x̂ × r)/|x̂ × r|^2 * (1 + r.x̂/|r|),
  // x̂ × r = (0, -rz, ry). Outgoing at TB (+), incoming at TA (-).
  {
    const d2 = rtby * rtby + rtbz * rtbz;
    if (d2 > cut2) {
      const f = (k * (1 + rtbx / ntb)) / d2;
      vy -= rtbz * f;
      vz += rtby * f;
    }
  }
  {
    const d2 = rtay * rtay + rtaz * rtaz;
    if (d2 > cut2) {
      const f = (k * (1 + rtax / nta)) / d2;
      vy += rtaz * f;
      vz -= rtay * f;
    }
  }
  out[o] = out[o]! + vx;
  out[o + 1] = out[o + 1]! + vy;
  out[o + 2] = out[o + 2]! + vz;
}

/**
 * Velocity (y, z components) induced in the Trefftz plane by an infinite straight vortex parallel
 * to +x through (qy, qz) with circulation `strength`, at (py, pz). Adds into out[o], out[o+1].
 */
export function addTrefftzVortexVelocity(
  py: number,
  pz: number,
  qy: number,
  qz: number,
  strength: number,
  cut2: number,
  out: Float64Array,
  o: number,
): void {
  const ry = py - qy;
  const rz = pz - qz;
  const r2 = ry * ry + rz * rz;
  if (r2 <= cut2) return;
  const f = strength / (2 * Math.PI * r2);
  out[o] = out[o]! - rz * f;
  out[o + 1] = out[o + 1]! + ry * f;
}

/** Scratch length needed by addStripHorseshoeVelocities for `nc` chordwise panels. */
export function stripScratchLength(nc: number): number {
  return 4 * (4 * nc + 2);
}

/** Accumulator for the segment helpers below (module scratch: the kernels are synchronous). */
const ACC = new Float64Array(3);

/** Store r = Q - P_idx and |r| at scratch[dst .. dst+3]. */
function fillOffset(
  qx: number,
  qy: number,
  qz: number,
  src: Float64Array,
  idx: number,
  scratch: Float64Array,
  dst: number,
): void {
  const rx = qx - src[3 * idx]!;
  const ry = qy - src[3 * idx + 1]!;
  const rz = qz - src[3 * idx + 2]!;
  scratch[dst] = rx;
  scratch[dst + 1] = ry;
  scratch[dst + 2] = rz;
  scratch[dst + 3] = Math.sqrt(rx * rx + ry * ry + rz * rz);
}

/** ACC += k * velocity of the unit segment between nodes whose offsets sit at scratch i -> j. */
function addSegment(scratch: Float64Array, i: number, j: number, k: number, cut2: number): void {
  const r1x = scratch[i]!;
  const r1y = scratch[i + 1]!;
  const r1z = scratch[i + 2]!;
  const n1 = scratch[i + 3]!;
  const r2x = scratch[j]!;
  const r2y = scratch[j + 1]!;
  const r2z = scratch[j + 2]!;
  const n2 = scratch[j + 3]!;
  const cx = r1y * r2z - r1z * r2y;
  const cy = r1z * r2x - r1x * r2z;
  const cz = r1x * r2y - r1y * r2x;
  const c2 = cx * cx + cy * cy + cz * cz;
  const lx = r1x - r2x;
  const ly = r1y - r2y;
  const lz = r1z - r2z;
  if (!(c2 > cut2 * (lx * lx + ly * ly + lz * lz))) return;
  const nn = n1 * n2;
  const f = (k * INV_4PI * (n1 + n2)) / (nn * (nn + r1x * r2x + r1y * r2y + r1z * r2z));
  ACC[0] = ACC[0]! + cx * f;
  ACC[1] = ACC[1]! + cy * f;
  ACC[2] = ACC[2]! + cz * f;
}

/** ACC += k * velocity of a unit semi-infinite leg leaving the node at scratch i along +x. */
function addSemiInfinite(scratch: Float64Array, i: number, k: number, cut2: number): void {
  const ry = scratch[i + 1]!;
  const rz = scratch[i + 2]!;
  const d2 = ry * ry + rz * rz;
  if (!(d2 > cut2)) return;
  const f = (k * INV_4PI * (1 + scratch[i]! / scratch[i + 3]!)) / d2;
  ACC[1] = ACC[1]! - rz * f;
  ACC[2] = ACC[2]! + ry * f;
}

/**
 * Velocity induced at (qx,qy,qz) by each of the `nc` unit horseshoes of one strip, ADDED into
 * out[3*(p0+k) .. 3*(p0+k)+2] for k = 0..nc-1.
 *
 * Horseshoe k runs  +inf -> Ea[nc] -> ... -> Ea[k+1] -> A_k -> B_k -> Eb[k+1] -> ... -> Eb[nc] -> +inf:
 * its trailing legs follow the strip's side edges on the camber surface (Ea/Eb: edge points at
 * the chordwise panel stations, Ea[nc]/Eb[nc] on the trailing edge) and then run along +x.
 * Downstream edge segments are shared by all upstream horseshoes, so they are evaluated once and
 * accumulated as suffix sums: about 5 segment evaluations per horseshoe.
 *
 * @param bA/bB bound-vortex endpoints (xyz interleaved), horseshoe k at index p0 + k
 * @param eA/eB edge points (xyz interleaved), station m at point index e0 + m (m = 0..nc)
 * @param reflect negate the y component of the result (mirror-image evaluation: the velocity of
 *   the mirrored strip at P equals the reflected velocity of this strip at the mirrored P)
 * @param scratch length >= stripScratchLength(nc)
 */
export function addStripHorseshoeVelocities(
  qx: number,
  qy: number,
  qz: number,
  bA: Float64Array,
  bB: Float64Array,
  p0: number,
  eA: Float64Array,
  eB: Float64Array,
  e0: number,
  nc: number,
  cut2: number,
  reflect: boolean,
  out: Float64Array,
  scratch: Float64Array,
): void {
  // Offsets r = Q - P and |r| for every node: A_k, B_k (nc each), Ea, Eb (nc + 1 each).
  const oA = 0;
  const oB = 4 * nc;
  const oEa = 8 * nc;
  const oEb = oEa + 4 * (nc + 1);
  for (let k = 0; k < nc; k++) {
    fillOffset(qx, qy, qz, bA, p0 + k, scratch, oA + 4 * k);
    fillOffset(qx, qy, qz, bB, p0 + k, scratch, oB + 4 * k);
  }
  for (let m = 0; m <= nc; m++) {
    fillOffset(qx, qy, qz, eA, e0 + m, scratch, oEa + 4 * m);
    fillOffset(qx, qy, qz, eB, e0 + m, scratch, oEb + 4 * m);
  }

  // Suffix sums of the edge paths Ea[k+1] -> ... -> TE -> +inf (sA) and likewise sB.
  ACC[0] = ACC[1] = ACC[2] = 0;
  addSemiInfinite(scratch, oEa + 4 * nc, 1, cut2);
  let sAx = ACC[0]!;
  let sAy = ACC[1]!;
  let sAz = ACC[2]!;
  ACC[0] = ACC[1] = ACC[2] = 0;
  addSemiInfinite(scratch, oEb + 4 * nc, 1, cut2);
  let sBx = ACC[0]!;
  let sBy = ACC[1]!;
  let sBz = ACC[2]!;
  const ySign = reflect ? -1 : 1;
  for (let k = nc - 1; k >= 0; k--) {
    // v = bound(A -> B) + [B -> Eb[k+1]] + sB - [A -> Ea[k+1]] - sA
    ACC[0] = sBx - sAx;
    ACC[1] = sBy - sAy;
    ACC[2] = sBz - sAz;
    addSegment(scratch, oA + 4 * k, oB + 4 * k, 1, cut2);
    addSegment(scratch, oB + 4 * k, oEb + 4 * (k + 1), 1, cut2);
    addSegment(scratch, oA + 4 * k, oEa + 4 * (k + 1), -1, cut2);
    const o = 3 * (p0 + k);
    out[o] = out[o]! + ACC[0]!;
    out[o + 1] = out[o + 1]! + ySign * ACC[1]!;
    out[o + 2] = out[o + 2]! + ACC[2]!;
    if (k > 0) {
      ACC[0] = ACC[1] = ACC[2] = 0;
      addSegment(scratch, oEa + 4 * k, oEa + 4 * (k + 1), 1, cut2);
      sAx += ACC[0]!;
      sAy += ACC[1]!;
      sAz += ACC[2]!;
      ACC[0] = ACC[1] = ACC[2] = 0;
      addSegment(scratch, oEb + 4 * k, oEb + 4 * (k + 1), 1, cut2);
      sBx += ACC[0]!;
      sBy += ACC[1]!;
      sBz += ACC[2]!;
    }
  }
}
