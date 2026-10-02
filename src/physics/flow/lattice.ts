/**
 * A VortexLattice preprocessed for fast velocity evaluation.
 *
 * - Panels sharing the same trailing-edge points form a STRIP (one chordwise column).
 * - Semi-infinite trailing legs are merged per trailing-edge node, so neighbouring strips only
 *   shed their circulation difference (the classic trailing-vortex sheet). They are always exact.
 * - Each strip keeps two representations of its finite filaments: EXACT (every panel's bound
 *   segment and on-surface legs) and LUMPED (one bound segment at the circulation-weighted
 *   quarter-chord line plus two legs). The fast evaluator uses the lumped one when the point is
 *   further than NEAR_CHORDS local chords from the strip.
 * - Line sources are grouped (per strip when built by buildThicknessSources). Far from a group
 *   the group becomes one source + one sink line (same total strengths and first moments), and
 *   very far away it is dropped (a closed body's thickness decays like a doublet).
 */
import type { VortexLattice } from '../types';
import {
  SEG_STRIDE,
  SEMI_STRIDE,
  SRC_STRIDE,
  addSegments,
  addSemiInfinite,
  addSources,
  packSegment,
  packSemi,
  packSource,
} from './kernels';

/** Distance (in local chords, from the strip's capsule) inside which strips are evaluated exactly. */
export const NEAR_CHORDS = 1.5;
/** Source groups beyond this many chords are ignored (thickness doublet decays like 1/r^2 .. 1/r^3). */
export const SOURCE_CUTOFF_CHORDS = 5;

/** Capsule stride: [ax, ay, az, abx, aby, abz, 1/|ab|^2, radius, chord, near^2, far^2]. */
const CAP_STRIDE = 11;

/** Extra per-source data attached by buildThicknessSources (lost on structured clone). */
export interface SourceMeta {
  /** Group start offsets into the source list, length groupCount + 1. */
  groupStart: Int32Array;
  /** Core radius per source (m). */
  coreRadius: Float32Array;
  /** Local chord per group (m). */
  groupChord: Float32Array;
}

const sourceMeta = new WeakMap<VortexLattice['sources'], SourceMeta>();

export function setSourceMeta(sources: VortexLattice['sources'], meta: SourceMeta): void {
  sourceMeta.set(sources, meta);
}

export interface CompiledLattice {
  source: VortexLattice;
  /** Regularisation core (m) and its 4th power. */
  core: number;
  core4: number;
  /** Merged semi-infinite legs. */
  semi: Float64Array;
  semiCount: number;
  /** Finite vortex segments: exact ones first (by strip), then 3 lumped ones per strip. */
  seg: Float64Array;
  stripCount: number;
  stripExactStart: Int32Array; // length stripCount + 1
  lumpedStart: number; // strip j lumped segments: lumpedStart + 3j .. +3
  stripCap: Float64Array;
  /** Line sources: exact ones first (by group), then 2 lumped ones per group. */
  src: Float64Array;
  groupCount: number;
  groupExactStart: Int32Array; // length groupCount + 1
  lumpedSrcStart: number;
  groupCap: Float64Array;
}

/* ------------------------------------------------------------------------------------------ */
/* Compilation                                                                                 */
/* ------------------------------------------------------------------------------------------ */

function latticeScale(l: VortexLattice): number {
  let m = 1;
  const arrays = [l.a, l.b, l.teA, l.teB];
  for (const arr of arrays)
    for (let i = 0; i < 3 * l.count; i++) m = Math.max(m, Math.abs(arr[i]!));
  return m;
}

/** Writes a capsule (segment A->B with radius) at index i. */
function packCapsule(
  out: Float64Array,
  i: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  chord: number,
  nearChords: number,
  farChords: number,
): void {
  const o = i * CAP_STRIDE;
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const l2 = abx * abx + aby * aby + abz * abz;
  const near = radius + nearChords * chord;
  const far = radius + farChords * chord;
  out[o] = ax;
  out[o + 1] = ay;
  out[o + 2] = az;
  out[o + 3] = abx;
  out[o + 4] = aby;
  out[o + 5] = abz;
  out[o + 6] = l2 > 1e-24 ? 1 / l2 : 0;
  out[o + 7] = radius;
  out[o + 8] = chord;
  out[o + 9] = near * near;
  out[o + 10] = far * far;
}

/** Squared distance from P to the capsule axis of element i. */
function capsuleDist2(cap: Float64Array, i: number, px: number, py: number, pz: number): number {
  const o = i * CAP_STRIDE;
  const apx = px - cap[o]!;
  const apy = py - cap[o + 1]!;
  const apz = pz - cap[o + 2]!;
  const abx = cap[o + 3]!;
  const aby = cap[o + 4]!;
  const abz = cap[o + 5]!;
  let t = (apx * abx + apy * aby + apz * abz) * cap[o + 6]!;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - t * abx;
  const dy = apy - t * aby;
  const dz = apz - t * abz;
  return dx * dx + dy * dy + dz * dz;
}

function distToSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * abx, py - ay - t * aby, pz - az - t * abz);
}

function compileVortices(
  l: VortexLattice,
  core: number,
  quantum: number,
): Pick<
  CompiledLattice,
  'semi' | 'semiCount' | 'seg' | 'stripCount' | 'stripExactStart' | 'lumpedStart' | 'stripCap'
> {
  const n = l.count;
  const { a, b, teA, teB, gamma } = l;
  const q = (v: number) => Math.round(v / quantum);
  const pointKey = (arr: Float32Array, i: number) =>
    `${q(arr[3 * i]!)},${q(arr[3 * i + 1]!)},${q(arr[3 * i + 2]!)}`;

  // Strips: panels sharing both trailing-edge points.
  const stripOf = new Map<string, number>();
  const stripPanels: number[][] = [];
  for (let i = 0; i < n; i++) {
    const key = `${pointKey(teA, i)}|${pointKey(teB, i)}`;
    let s = stripOf.get(key);
    if (s === undefined) {
      s = stripPanels.length;
      stripOf.set(key, s);
      stripPanels.push([]);
    }
    stripPanels[s]!.push(i);
  }
  const stripCount = stripPanels.length;

  // Semi-infinite legs merged per trailing-edge node: +gamma at teB, -gamma at teA.
  const nodeOf = new Map<string, number>();
  const nodeXyz: number[] = [];
  const nodeG: number[] = [];
  const addNode = (arr: Float32Array, i: number, g: number) => {
    const key = pointKey(arr, i);
    let k = nodeOf.get(key);
    if (k === undefined) {
      k = nodeG.length;
      nodeOf.set(key, k);
      nodeXyz.push(arr[3 * i]!, arr[3 * i + 1]!, arr[3 * i + 2]!);
      nodeG.push(0);
    }
    nodeG[k]! += g;
  };
  let gMax = 0;
  for (let i = 0; i < n; i++) {
    const g = gamma[i]!;
    gMax = Math.max(gMax, Math.abs(g));
    addNode(teB, i, g);
    addNode(teA, i, -g);
  }
  const keep: number[] = [];
  for (let k = 0; k < nodeG.length; k++) if (Math.abs(nodeG[k]!) > 1e-9 * gMax) keep.push(k);
  const semi = new Float64Array(Math.max(1, keep.length) * SEMI_STRIDE);
  keep.forEach((k, j) =>
    packSemi(semi, j, nodeXyz[3 * k]!, nodeXyz[3 * k + 1]!, nodeXyz[3 * k + 2]!, nodeG[k]!),
  );

  // Finite segments: exact (3 per panel) then lumped (3 per strip).
  const seg = new Float64Array((3 * n + 3 * stripCount) * SEG_STRIDE);
  const stripExactStart = new Int32Array(stripCount + 1);
  const stripCap = new Float64Array(stripCount * CAP_STRIDE);
  const lumpedStart = 3 * n;
  let si = 0;
  for (let s = 0; s < stripCount; s++) {
    stripExactStart[s] = si;
    const panels = stripPanels[s]!;
    const i0 = panels[0]!;
    const tax = teA[3 * i0]!;
    const tay = teA[3 * i0 + 1]!;
    const taz = teA[3 * i0 + 2]!;
    const tbx = teB[3 * i0]!;
    const tby = teB[3 * i0 + 1]!;
    const tbz = teB[3 * i0 + 2]!;
    let wSum = 0;
    let total = 0;
    for (const i of panels) {
      wSum += Math.abs(gamma[i]!);
      total += gamma[i]!;
    }
    let qax = 0;
    let qay = 0;
    let qaz = 0;
    let qbx = 0;
    let qby = 0;
    let qbz = 0;
    for (const i of panels) {
      const g = gamma[i]!;
      const ax = a[3 * i]!;
      const ay = a[3 * i + 1]!;
      const az = a[3 * i + 2]!;
      const bx = b[3 * i]!;
      const by = b[3 * i + 1]!;
      const bz = b[3 * i + 2]!;
      packSegment(seg, si++, tax, tay, taz, ax, ay, az, g, core);
      packSegment(seg, si++, ax, ay, az, bx, by, bz, g, core);
      packSegment(seg, si++, bx, by, bz, tbx, tby, tbz, g, core);
      const w = wSum > 0 ? Math.abs(g) / wSum : 1 / panels.length;
      qax += w * ax;
      qay += w * ay;
      qaz += w * az;
      qbx += w * bx;
      qby += w * by;
      qbz += w * bz;
    }
    const lo = lumpedStart + 3 * s;
    packSegment(seg, lo, tax, tay, taz, qax, qay, qaz, total, core);
    packSegment(seg, lo + 1, qax, qay, qaz, qbx, qby, qbz, total, core);
    packSegment(seg, lo + 2, qbx, qby, qbz, tbx, tby, tbz, total, core);

    // Capsule along the strip's mid-chord line, from the (extrapolated) LE to the TE.
    const tmx = 0.5 * (tax + tbx);
    const tmy = 0.5 * (tay + tby);
    const tmz = 0.5 * (taz + tbz);
    let far = -1;
    let fx = tmx;
    let fy = tmy;
    let fz = tmz;
    for (const i of panels) {
      const mx = 0.5 * (a[3 * i]! + b[3 * i]!);
      const my = 0.5 * (a[3 * i + 1]! + b[3 * i + 1]!);
      const mz = 0.5 * (a[3 * i + 2]! + b[3 * i + 2]!);
      const d = Math.hypot(mx - tmx, my - tmy, mz - tmz);
      if (d > far) {
        far = d;
        fx = mx;
        fy = my;
        fz = mz;
      }
    }
    // The most upstream bound vortex sits at 0.25/nc of the chord behind the LE.
    const frac = 0.25 / panels.length;
    const chord = Math.max(far / (1 - frac), 1e-6);
    const ext = frac / (1 - frac);
    const lex = fx + (fx - tmx) * ext;
    const ley = fy + (fy - tmy) * ext;
    const lez = fz + (fz - tmz) * ext;
    let radius = 0;
    for (const i of panels) {
      for (const arr of [a, b]) {
        radius = Math.max(
          radius,
          distToSegment(
            arr[3 * i]!,
            arr[3 * i + 1]!,
            arr[3 * i + 2]!,
            lex,
            ley,
            lez,
            tmx,
            tmy,
            tmz,
          ),
        );
      }
    }
    radius = Math.max(
      radius,
      distToSegment(tax, tay, taz, lex, ley, lez, tmx, tmy, tmz),
      distToSegment(tbx, tby, tbz, lex, ley, lez, tmx, tmy, tmz),
    );
    packCapsule(stripCap, s, lex, ley, lez, tmx, tmy, tmz, radius, chord, NEAR_CHORDS, 0);
  }
  stripExactStart[stripCount] = si;
  return {
    semi,
    semiCount: keep.length,
    seg,
    stripCount,
    stripExactStart,
    lumpedStart,
    stripCap,
  };
}

function compileSources(
  l: VortexLattice,
  core: number,
): Pick<CompiledLattice, 'src' | 'groupCount' | 'groupExactStart' | 'lumpedSrcStart' | 'groupCap'> {
  const { count, p0, p1, sigma } = l.sources;
  const meta = sourceMeta.get(l.sources);
  let groupStart: Int32Array;
  let groupChord: Float32Array | null = null;
  if (meta && meta.groupStart[meta.groupStart.length - 1] === count) {
    groupStart = meta.groupStart;
    groupChord = meta.groupChord;
  } else {
    // Greedy: consecutive sources whose midpoints stay within 2 segment lengths of the first.
    const starts: number[] = [];
    let first = -1;
    let reach = 0;
    for (let k = 0; k < count; k++) {
      const mx = 0.5 * (p0[3 * k]! + p1[3 * k]!);
      const my = 0.5 * (p0[3 * k + 1]! + p1[3 * k + 1]!);
      const mz = 0.5 * (p0[3 * k + 2]! + p1[3 * k + 2]!);
      if (first >= 0) {
        const fx = 0.5 * (p0[3 * first]! + p1[3 * first]!);
        const fy = 0.5 * (p0[3 * first + 1]! + p1[3 * first + 1]!);
        const fz = 0.5 * (p0[3 * first + 2]! + p1[3 * first + 2]!);
        if (Math.hypot(mx - fx, my - fy, mz - fz) <= reach) continue;
      }
      first = k;
      starts.push(k);
      reach =
        2 *
        Math.hypot(
          p1[3 * k]! - p0[3 * k]!,
          p1[3 * k + 1]! - p0[3 * k + 1]!,
          p1[3 * k + 2]! - p0[3 * k + 2]!,
        );
    }
    starts.push(count);
    groupStart = Int32Array.from(starts);
  }
  const groupCount = groupStart.length - 1;
  const src = new Float64Array(Math.max(1, count + 2 * groupCount) * SRC_STRIDE);
  const groupCap = new Float64Array(Math.max(1, groupCount) * CAP_STRIDE);
  for (let k = 0; k < count; k++) {
    const rc = meta && groupChord ? meta.coreRadius[k]! : core;
    packSource(
      src,
      k,
      p0[3 * k]!,
      p0[3 * k + 1]!,
      p0[3 * k + 2]!,
      p1[3 * k]!,
      p1[3 * k + 1]!,
      p1[3 * k + 2]!,
      sigma[k]!,
      Math.max(rc, core),
    );
  }
  const lumpedSrcStart = count;
  for (let gi = 0; gi < groupCount; gi++) {
    const s0 = groupStart[gi]!;
    const s1 = groupStart[gi + 1]!;
    // Centroid & radius of all endpoints.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = s0; k < s1; k++) {
      cx += p0[3 * k]! + p1[3 * k]!;
      cy += p0[3 * k + 1]! + p1[3 * k + 1]!;
      cz += p0[3 * k + 2]! + p1[3 * k + 2]!;
    }
    const inv = 1 / Math.max(1, 2 * (s1 - s0));
    cx *= inv;
    cy *= inv;
    cz *= inv;
    let radius = 0;
    let midSpread = 0;
    for (let k = s0; k < s1; k++) {
      for (const arr of [p0, p1]) {
        radius = Math.max(
          radius,
          Math.hypot(arr[3 * k]! - cx, arr[3 * k + 1]! - cy, arr[3 * k + 2]! - cz),
        );
      }
      midSpread = Math.max(
        midSpread,
        Math.hypot(
          0.5 * (p0[3 * k]! + p1[3 * k]!) - cx,
          0.5 * (p0[3 * k + 1]! + p1[3 * k + 1]!) - cy,
          0.5 * (p0[3 * k + 2]! + p1[3 * k + 2]!) - cz,
        ),
      );
    }
    const chord = groupChord ? groupChord[gi]! : Math.max(2 * midSpread, 1e-6);
    packCapsule(
      groupCap,
      gi,
      cx,
      cy,
      cz,
      cx,
      cy,
      cz,
      radius,
      chord,
      NEAR_CHORDS,
      SOURCE_CUTOFF_CHORDS,
    );

    // Lumped: one positive and one negative line with the same total strength and centroid.
    for (let sign = 1, slot = 0; slot < 2; sign = -1, slot++) {
      let wq = 0;
      let rcMax = core;
      const e0 = [0, 0, 0];
      const e1 = [0, 0, 0];
      for (let k = s0; k < s1; k++) {
        const len = Math.hypot(
          p1[3 * k]! - p0[3 * k]!,
          p1[3 * k + 1]! - p0[3 * k + 1]!,
          p1[3 * k + 2]! - p0[3 * k + 2]!,
        );
        const qk = sigma[k]! * len;
        if (sign * qk <= 0) continue;
        const w = Math.abs(qk);
        wq += w;
        for (let c = 0; c < 3; c++) {
          e0[c]! += w * p0[3 * k + c]!;
          e1[c]! += w * p1[3 * k + c]!;
        }
        if (meta && groupChord) rcMax = Math.max(rcMax, meta.coreRadius[k]!);
      }
      const idx = lumpedSrcStart + 2 * gi + slot;
      if (wq === 0) {
        packSource(src, idx, 0, 0, 0, 0, 0, 0, 0, core);
        continue;
      }
      for (let c = 0; c < 3; c++) {
        e0[c]! /= wq;
        e1[c]! /= wq;
      }
      const len = Math.hypot(e1[0]! - e0[0]!, e1[1]! - e0[1]!, e1[2]! - e0[2]!);
      packSource(
        src,
        idx,
        e0[0]!,
        e0[1]!,
        e0[2]!,
        e1[0]!,
        e1[1]!,
        e1[2]!,
        len > 1e-12 ? (sign * wq) / len : 0,
        rcMax,
      );
    }
  }
  return { src, groupCount, groupExactStart: groupStart, lumpedSrcStart, groupCap };
}

export function compileLattice(l: VortexLattice): CompiledLattice {
  const scale = latticeScale(l);
  const core = l.coreRadius > 0 ? l.coreRadius : 1e-3 * scale;
  const vort = compileVortices(l, core, 1e-6 * scale);
  const srcs = compileSources(l, core);
  return { source: l, core, core4: core * core * core * core, ...vort, ...srcs };
}

interface CacheEntry {
  compiled: CompiledLattice;
  gamma: Float32Array;
  a: Float32Array;
  sources: VortexLattice['sources'];
  sigma: Float32Array;
  count: number;
  core: number;
}
const cache = new WeakMap<VortexLattice, CacheEntry>();

/**
 * Compiled form of a lattice, memoised per lattice object. The lattice is treated as immutable
 * once evaluated; replacing any of its arrays (or `sources`) triggers a recompile.
 */
export function getCompiledLattice(l: VortexLattice): CompiledLattice {
  const e = cache.get(l);
  if (
    e &&
    e.gamma === l.gamma &&
    e.a === l.a &&
    e.sources === l.sources &&
    e.sigma === l.sources.sigma &&
    e.count === l.count &&
    e.core === l.coreRadius
  ) {
    return e.compiled;
  }
  const compiled = compileLattice(l);
  cache.set(l, {
    compiled,
    gamma: l.gamma,
    a: l.a,
    sources: l.sources,
    sigma: l.sources.sigma,
    count: l.count,
    core: l.coreRadius,
  });
  return compiled;
}

/* ------------------------------------------------------------------------------------------ */
/* Evaluation                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Adds the exact induced velocity (all panels, all sources) at P into acc. */
export function addInducedExact(
  c: CompiledLattice,
  px: number,
  py: number,
  pz: number,
  acc: Float64Array,
): void {
  addSemiInfinite(c.semi, 0, c.semiCount, c.core4, px, py, pz, acc);
  addSegments(c.seg, 0, c.lumpedStart, px, py, pz, acc);
  addSources(c.src, 0, c.lumpedSrcStart, px, py, pz, acc);
}

/** Adds the lumped far-field model everywhere (for tests of the lumping accuracy). */
export function addInducedLumped(
  c: CompiledLattice,
  px: number,
  py: number,
  pz: number,
  acc: Float64Array,
): void {
  addSemiInfinite(c.semi, 0, c.semiCount, c.core4, px, py, pz, acc);
  addSegments(c.seg, c.lumpedStart, c.lumpedStart + 3 * c.stripCount, px, py, pz, acc);
  addSources(c.src, c.lumpedSrcStart, c.lumpedSrcStart + 2 * c.groupCount, px, py, pz, acc);
}

/**
 * Adds the induced velocity using exact filaments near each strip and the lumped model further
 * than NEAR_CHORDS local chords away (error well under 3% of V_inf there).
 */
export function addInducedFast(
  c: CompiledLattice,
  px: number,
  py: number,
  pz: number,
  acc: Float64Array,
): void {
  addSemiInfinite(c.semi, 0, c.semiCount, c.core4, px, py, pz, acc);
  const cap = c.stripCap;
  const ls = c.lumpedStart;
  // Runs of consecutive lumped strips are evaluated in one call.
  let runStart = -1;
  for (let s = 0; s < c.stripCount; s++) {
    const near = capsuleDist2(cap, s, px, py, pz) < cap[s * CAP_STRIDE + 9]!;
    if (near) {
      if (runStart >= 0) {
        addSegments(c.seg, ls + 3 * runStart, ls + 3 * s, px, py, pz, acc);
        runStart = -1;
      }
      addSegments(c.seg, c.stripExactStart[s]!, c.stripExactStart[s + 1]!, px, py, pz, acc);
    } else if (runStart < 0) {
      runStart = s;
    }
  }
  if (runStart >= 0) addSegments(c.seg, ls + 3 * runStart, ls + 3 * c.stripCount, px, py, pz, acc);

  const gcap = c.groupCap;
  const lss = c.lumpedSrcStart;
  for (let g = 0; g < c.groupCount; g++) {
    const d2 = capsuleDist2(gcap, g, px, py, pz);
    const o = g * CAP_STRIDE;
    if (d2 < gcap[o + 9]!) {
      addSources(c.src, c.groupExactStart[g]!, c.groupExactStart[g + 1]!, px, py, pz, acc);
    } else if (d2 < gcap[o + 10]!) {
      addSources(c.src, lss + 2 * g, lss + 2 * g + 2, px, py, pz, acc);
    }
  }
}

/**
 * Approximate distance from P to the lifting surfaces (m, >= 0) and the chord of the nearest
 * strip, written into out[0], out[1]. Uses the strip capsules.
 */
export function distanceToWing(
  c: CompiledLattice,
  px: number,
  py: number,
  pz: number,
  out: Float64Array,
): void {
  const cap = c.stripCap;
  let best = Infinity;
  let chord = 0;
  for (let s = 0; s < c.stripCount; s++) {
    const d = Math.sqrt(capsuleDist2(cap, s, px, py, pz)) - cap[s * CAP_STRIDE + 7]!;
    if (d < best) {
      best = d;
      chord = cap[s * CAP_STRIDE + 8]!;
    }
  }
  out[0] = best > 0 ? best : 0;
  out[1] = chord;
}
