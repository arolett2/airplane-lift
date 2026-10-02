/**
 * Smoke-rake seeding and streamline integration through the vortex model.
 *
 * Integration is RK4 in arc length (direction field V/|V|), so lines never stall at a stagnation
 * point; physical time is accumulated separately as ds / |V|. The step grows from ~0.02 local
 * chords at the wing to ~0.03 semispans far away, and is halved where the direction turns
 * sharply (e.g. while winding round a tip vortex). If a step lands inside the wing the point is
 * pushed back out along the section normal, so lines slide over the surface instead of piercing.
 */
import type { Streamline3D, Vec3, VortexLattice, WingGeometry } from '../types';
import type { TunnelDomain } from '../domain';
import type { RakeConfig } from '../../state/params';
import { bodyDirToTunnel, bodyToTunnel } from '../math/frames';
import { addInducedFast, distanceToWing, getCompiledLattice } from './lattice';
import type { CompiledLattice } from './lattice';
import { getWingSolid } from './solid';
import type { WingSolid } from './solid';
import { withThicknessSources } from './sources';
import { interpolateSegment, maxChord, sectionPoint, semispan } from './wingFrames';

export interface StreamlineSeeds {
  /** Interleaved xyz seed points. */
  points: Float32Array;
  group: Streamline3D['group'];
}

/** Hard cap on points per streamline. */
export const MAX_STREAMLINE_POINTS = 1500;
/** Fine step near the wing, in local chords. */
const STEP_NEAR_CHORDS = 0.02;
/** Coarse step far from the wing, in semispans (or in chords, whichever is larger). */
const STEP_FAR_SEMISPANS = 0.03;
const STEP_FAR_CHORDS = 0.08;
/** Step growth with distance from the wing (m of step per m of distance). */
const STEP_GROWTH = 0.08;
/** Maximum direction change per step before the step is halved (cos 12 deg). */
const COS_MAX_TURN = Math.cos((12 * Math.PI) / 180);
/** Lines stuck against the wing for this many consecutive steps are ended. */
const MAX_CONSECUTIVE_PUSHES = 60;
/** Distance of the seed plane behind the inlet, as a fraction of the domain length. */
const INLET_OFFSET = 0.005;

/* ------------------------------------------------------------------------------------------ */
/* Seeding                                                                                     */
/* ------------------------------------------------------------------------------------------ */

interface Station {
  /** Leading edge, tunnel frame. */
  le: Vec3;
  chord: number;
}

/** Leading edge (tunnel frame) and chord of the base wing at spanwise position y. */
export function wingStationAt(geometry: WingGeometry, alpha: number, y: number): Station {
  const side = y < 0 ? 'left' : 'right';
  const surface =
    geometry.surfaces.find((s) => s.role === 'wing' && s.side === side) ??
    geometry.surfaces.find((s) => s.role === 'wing');
  if (!surface || surface.sections.length < 2) {
    return { le: [geometry.pivot[0], y, geometry.pivot[2]], chord: geometry.meanAeroChord };
  }
  const secs = surface.sections;
  const ay = Math.abs(y);
  let seg = secs.length - 2;
  let s = 1;
  for (let i = 0; i + 1 < secs.length; i++) {
    const y0 = Math.abs(secs[i]!.le[1]);
    const y1 = Math.abs(secs[i + 1]!.le[1]);
    if (ay <= y1 || i === secs.length - 2) {
      seg = i;
      s = y1 > y0 ? Math.min(1, Math.max(0, (ay - y0) / (y1 - y0))) : 0;
      break;
    }
  }
  const sec = interpolateSegment(surface, seg, s);
  const le = bodyToTunnel(sectionPoint(sec.axes, 0, 0), geometry.pivot, alpha);
  return { le, chord: sec.axes.chord };
}

interface TipFrame {
  /** Quarter-chord point of the tip section, tunnel frame. */
  qc: Vec3;
  /** Section "up" (suction side) and outboard span direction, tunnel frame. */
  normal: Vec3;
  span: Vec3;
}

/** The outermost tip section on one side (a winglet's top when there is one). */
function tipFrame(geometry: WingGeometry, alpha: number, side: 'right' | 'left'): TipFrame {
  let best: TipFrame | null = null;
  let bestY = -Infinity;
  let bestZ = -Infinity;
  for (const surface of geometry.surfaces) {
    if (surface.side !== side || surface.sections.length < 2) continue;
    const n = surface.sections.length;
    const { axes } = interpolateSegment(surface, n - 2, 1);
    const qc = bodyToTunnel(sectionPoint(axes, 0.25, 0), geometry.pivot, alpha);
    const ay = Math.abs(qc[1]);
    const dz = Math.abs(qc[2] - geometry.pivot[2]);
    if (ay > bestY + 1e-6 || (Math.abs(ay - bestY) <= 1e-6 && dz > bestZ)) {
      bestY = ay;
      bestZ = dz;
      best = {
        qc,
        normal: bodyDirToTunnel(axes.normalDir, alpha),
        span: bodyDirToTunnel(axes.spanDir, alpha),
      };
    }
  }
  const S = semispan(geometry);
  return (
    best ?? {
      qc: [0, side === 'left' ? -S : S, 0],
      normal: [0, 0, 1],
      span: [0, side === 'left' ? -1 : 1, 0],
    }
  );
}

/** Splits n items over weights (largest remainder). */
function allocate(n: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (n * w) / total);
  const out = raw.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]![1]]!++;
  return out;
}

function clampToDomain(domain: TunnelDomain, pts: number[]): Float32Array {
  const out = Float32Array.from(pts);
  for (let i = 0; i < out.length; i++) {
    const c = i % 3;
    const lo = domain.min[c]!;
    const hi = domain.max[c]!;
    const pad = 1e-4 * (hi - lo);
    out[i] = Math.min(hi - pad, Math.max(lo + pad, out[i]!));
  }
  return out;
}

export function seedStreamlines(
  geometry: WingGeometry,
  alpha: number,
  rake: RakeConfig,
  domain: TunnelDomain,
): StreamlineSeeds[] {
  const S = semispan(geometry);
  const n = Math.max(1, Math.round(rake.count));
  const x0 = domain.min[0] + INLET_OFFSET * (domain.max[0] - domain.min[0]);
  const pts: number[] = [];

  if (rake.mode === 'vertical') {
    const y = Math.max(-1, Math.min(1, rake.eta)) * S;
    const st = wingStationAt(geometry, alpha, y);
    // The dividing streamline arrives slightly below the leading edge.
    const zc = st.le[2] - 0.02 * st.chord + rake.height * S;
    const half = 0.25 * S;
    for (let i = 0; i < n; i++) {
      const u = -1 + (2 * (i + 0.5)) / n;
      // Denser near the wing's height.
      pts.push(x0, y, zc + half * Math.sign(u) * Math.abs(u) ** 1.6);
    }
    return [{ points: clampToDomain(domain, pts), group: 'rake' }];
  }

  if (rake.mode === 'horizontal') {
    for (let i = 0; i < n; i++) {
      const y = (-1.15 + (2.3 * (i + 0.5)) / n) * S;
      const st = wingStationAt(geometry, alpha, Math.max(-S, Math.min(S, y)));
      pts.push(x0, y, st.le[2] + rake.height * S + 0.05 * st.chord);
    }
    return [{ points: clampToDomain(domain, pts), group: 'sheet' }];
  }

  // Tip vortex: rings round each tip's upstream projection plus a few over the outer upper wing.
  // The rings are centred a little inboard of the tip and on its pressure side: those lines pass
  // round the tip edge and get wound up most by the trailing vortex.
  const perSide = Math.max(4, Math.floor(n / 2));
  const nInboard = Math.max(1, Math.round(0.2 * perSide));
  const radii = [0.025, 0.05, 0.09, 0.15];
  const ringCounts = allocate(perSide - nInboard, [0.35, 0.3, 0.2, 0.15]);
  for (const side of ['right', 'left'] as const) {
    const tip = tipFrame(geometry, alpha, side);
    const cy = tip.qc[1] - (0.03 * tip.normal[1] + 0.025 * tip.span[1]) * S;
    const cz = tip.qc[2] - (0.03 * tip.normal[2] + 0.025 * tip.span[2]) * S;
    radii.forEach((r, ri) => {
      const count = ringCounts[ri]!;
      for (let k = 0; k < count; k++) {
        const th = (2 * Math.PI * (k + 0.5 * (ri % 2))) / count;
        pts.push(x0, cy + r * S * Math.cos(th), cz + r * S * Math.sin(th));
      }
    });
    const sgn = side === 'right' ? 1 : -1;
    const yTip = Math.min(Math.abs(tip.qc[1]), S);
    for (let k = 0; k < nInboard; k++) {
      const y = sgn * (yTip - (0.04 + (0.12 * k) / nInboard) * S);
      const st = wingStationAt(geometry, alpha, y);
      pts.push(x0, y, st.le[2] + 0.04 * st.chord);
    }
  }
  return [{ points: clampToDomain(domain, pts), group: 'tip-vortex' }];
}

/* ------------------------------------------------------------------------------------------ */
/* Tracing                                                                                     */
/* ------------------------------------------------------------------------------------------ */

// Scratch buffers (module-level: no allocation per step).
const bufP = new Float64Array(3 * MAX_STREAMLINE_POINTS);
const bufSpeed = new Float64Array(MAX_STREAMLINE_POINTS);
const bufTime = new Float64Array(MAX_STREAMLINE_POINTS);
const vel = new Float64Array(3);
const velNext = new Float64Array(3);
const k1 = new Float64Array(3);
const k2 = new Float64Array(3);
const k3 = new Float64Array(3);
const k4 = new Float64Array(3);
const pos = new Float64Array(3);
const next = new Float64Array(3);
const dist = new Float64Array(2);

function velocity(
  c: CompiledLattice,
  vInf: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  out[0] = vInf;
  out[1] = 0;
  out[2] = 0;
  addInducedFast(c, x, y, z, out);
}

/** Unit direction of the flow at (x, y, z) into k; returns the speed. */
function direction(
  c: CompiledLattice,
  vInf: number,
  x: number,
  y: number,
  z: number,
  k: Float64Array,
): number {
  velocity(c, vInf, x, y, z, k);
  const s = Math.hypot(k[0]!, k[1]!, k[2]!);
  if (s < 1e-9 * vInf) {
    k[0] = 1;
    k[1] = 0;
    k[2] = 0;
  } else {
    k[0]! /= s;
    k[1]! /= s;
    k[2]! /= s;
  }
  return s;
}

function inDomain(d: TunnelDomain, x: number, y: number, z: number): boolean {
  return (
    x >= d.min[0] &&
    x <= d.max[0] &&
    y >= d.min[1] &&
    y <= d.max[1] &&
    z >= d.min[2] &&
    z <= d.max[2]
  );
}

/** Fraction t in [0,1] of the step a -> b at which it leaves the domain box. */
function exitFraction(d: TunnelDomain, a: Float64Array, b: Float64Array): number {
  let t = 1;
  for (let c = 0; c < 3; c++) {
    const da = b[c]! - a[c]!;
    if (b[c]! > d.max[c]! && da > 0) t = Math.min(t, (d.max[c]! - a[c]!) / da);
    if (b[c]! < d.min[c]! && da < 0) t = Math.min(t, (d.min[c]! - a[c]!) / da);
  }
  return Math.max(0, t);
}

function traceOne(
  c: CompiledLattice,
  solid: WingSolid,
  vInf: number,
  domain: TunnelDomain,
  hFar: number,
  sx: number,
  sy: number,
  sz: number,
  group: Streamline3D['group'],
): Streamline3D | null {
  pos[0] = sx;
  pos[1] = sy;
  pos[2] = sz;
  if (!inDomain(domain, sx, sy, sz)) return null;
  if (solid.contains(sx, sy, sz) && !solid.pushOut(pos)) return null;
  velocity(c, vInf, pos[0]!, pos[1]!, pos[2]!, vel);
  let speed = Math.hypot(vel[0]!, vel[1]!, vel[2]!);
  bufP[0] = pos[0]!;
  bufP[1] = pos[1]!;
  bufP[2] = pos[2]!;
  bufSpeed[0] = speed / vInf;
  bufTime[0] = 0;
  let n = 1;
  let time = 0;
  let pushes = 0;
  const minSpeed = 0.02 * vInf;

  while (n < MAX_STREAMLINE_POINTS) {
    const px: number = pos[0]!;
    const py: number = pos[1]!;
    const pz: number = pos[2]!;
    distanceToWing(c, px, py, pz, dist);
    const hNear = dist[1]! > 0 ? STEP_NEAR_CHORDS * dist[1]! : hFar;
    let h = Math.min(hFar, hNear + STEP_GROWTH * dist[0]!);
    const hMin = Math.min(0.25 * hNear, 0.25 * h);

    // k1 from the current velocity.
    const s1 = speed > 1e-9 * vInf ? speed : 1;
    k1[0] = speed > 1e-9 * vInf ? vel[0]! / s1 : 1;
    k1[1] = speed > 1e-9 * vInf ? vel[1]! / s1 : 0;
    k1[2] = speed > 1e-9 * vInf ? vel[2]! / s1 : 0;
    for (let attempt = 0; ; attempt++) {
      const hh = 0.5 * h;
      direction(c, vInf, px + hh * k1[0]!, py + hh * k1[1]!, pz + hh * k1[2]!, k2);
      direction(c, vInf, px + hh * k2[0]!, py + hh * k2[1]!, pz + hh * k2[2]!, k3);
      direction(c, vInf, px + h * k3[0]!, py + h * k3[1]!, pz + h * k3[2]!, k4);
      const turn = k1[0]! * k4[0]! + k1[1]! * k4[1]! + k1[2]! * k4[2]!;
      if (turn >= COS_MAX_TURN || h <= hMin || attempt >= 5) break;
      h *= 0.5;
    }
    const f = h / 6;
    next[0] = px + f * (k1[0]! + 2 * k2[0]! + 2 * k3[0]! + k4[0]!);
    next[1] = py + f * (k1[1]! + 2 * k2[1]! + 2 * k3[1]! + k4[1]!);
    next[2] = pz + f * (k1[2]! + 2 * k2[2]! + 2 * k3[2]! + k4[2]!);

    if (solid.contains(next[0]!, next[1]!, next[2]!)) {
      if (!solid.pushOut(next)) break;
      if (++pushes > MAX_CONSECUTIVE_PUSHES) break;
    } else {
      pushes = 0;
    }

    let leaving = false;
    if (!inDomain(domain, next[0]!, next[1]!, next[2]!)) {
      const t = exitFraction(domain, pos, next);
      next[0] = px + t * (next[0]! - px);
      next[1] = py + t * (next[1]! - py);
      next[2] = pz + t * (next[2]! - pz);
      leaving = true;
    }

    velocity(c, vInf, next[0]!, next[1]!, next[2]!, velNext);
    const speedNext = Math.hypot(velNext[0]!, velNext[1]!, velNext[2]!);
    const ds = Math.hypot(next[0]! - px, next[1]! - py, next[2]! - pz);
    time += ds / Math.max(0.5 * (speed + speedNext), minSpeed);

    const o = 3 * n;
    bufP[o] = next[0]!;
    bufP[o + 1] = next[1]!;
    bufP[o + 2] = next[2]!;
    bufSpeed[n] = speedNext / vInf;
    bufTime[n] = time;
    n++;

    pos[0] = next[0]!;
    pos[1] = next[1]!;
    pos[2] = next[2]!;
    vel[0] = velNext[0]!;
    vel[1] = velNext[1]!;
    vel[2] = velNext[2]!;
    speed = speedNext;
    if (leaving) break;
  }

  if (n < 2) return null;
  return {
    points: Float32Array.from(bufP.subarray(0, 3 * n)),
    speed: Float32Array.from(bufSpeed.subarray(0, n)),
    time: Float32Array.from(bufTime.subarray(0, n)),
    group,
  };
}

export function traceStreamlines(
  lattice: VortexLattice,
  vInf: number,
  seeds: StreamlineSeeds[],
  domain: TunnelDomain,
  geometry: WingGeometry,
  alpha: number,
): Streamline3D[] {
  const compiled = getCompiledLattice(withThicknessSources(lattice, geometry, alpha, vInf));
  const solid = getWingSolid(geometry, alpha);
  // Short-span, long-chord wings (e.g. a fighter) need the chord to set the far step too.
  const hFar = Math.max(
    STEP_FAR_SEMISPANS * semispan(geometry),
    STEP_FAR_CHORDS * maxChord(geometry),
  );
  const lines: Streamline3D[] = [];
  for (const set of seeds) {
    const p = set.points;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const line = traceOne(
        compiled,
        solid,
        vInf,
        domain,
        hFar,
        p[i]!,
        p[i + 1]!,
        p[i + 2]!,
        set.group,
      );
      if (line) lines.push(line);
    }
  }
  return lines;
}
