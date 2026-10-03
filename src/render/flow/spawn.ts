/**
 * Where particles are born. Pure (no three.js).
 *
 * Like smoke in a real wind tunnel, particles are released on the inlet plane where they tell the
 * story rather than filling the whole tunnel:
 *
 *  - a thin SHEET at wing height across the span (it splits over and under the wing, bends down
 *    behind it and rolls up into the tip vortices),
 *  - extra seeding in a disk round each TIP (it winds up into the tip vortex),
 *  - a little AMBIENT dust spread across the section for context (drawn dimmer).
 *
 * Without a wing (`smoke === null`) the older band layout is used: ~60% of spawns in a band
 * around the wing (|y| < 1.15 semispan, |z| < 0.2 semispan), the rest across the inlet.
 */
import type { TunnelDomain } from '../../physics/domain';
import type { Vec3, WingGeometry } from '../../physics/types';

/** Small, fast, seedable PRNG (mulberry32). Returns a function giving floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a particle was released as (drives how strongly it is drawn). */
export const KIND_SHEET = 0;
export const KIND_TIP = 1;
export const KIND_AMBIENT = 2;
export type SpawnKind = typeof KIND_SHEET | typeof KIND_TIP | typeof KIND_AMBIENT;

/** Smoke sources around a wing, in the tunnel frame (m). */
export interface SmokeSources {
  /** The sheet covers |y| <= halfSpan; `z` and `thickness` are sampled uniformly over it. */
  halfSpan: number;
  /** Sheet centre height at SHEET_SAMPLES stations from -halfSpan to +halfSpan. */
  z: Float32Array;
  /** Sheet half-thickness at the same stations. */
  thickness: Float32Array;
  /** Tip seeding disks: [y, z, radius] for the right then the left tip. */
  tips: Float32Array;
  sheetFraction: number;
  tipFraction: number;
}

export interface SpawnRegion {
  /** Domain bounds, shrunk by a small margin so spawned particles are strictly inside. */
  min: Vec3;
  max: Vec3;
  /** Half-extent of the concentrated band around the wing (y and z), clamped to the domain. */
  bandHalfY: number;
  bandHalfZ: number;
  /** Band centre in z (the wing's height in the tunnel). */
  bandCenterZ: number;
  /** Fraction of spawns that go into the band. */
  bandFraction: number;
  /** Smoke sources round the wing; null falls back to the band. */
  smoke: SmokeSources | null;
}

export const BAND_Y_FACTOR = 1.15;
export const BAND_Z_FACTOR = 0.2;
export const BAND_FRACTION = 0.6;

/** Stations sampled across the sheet. */
export const SHEET_SAMPLES = 41;
/** Share of releases in the sheet and at the tips; the rest is ambient dust. */
export const SHEET_FRACTION = 0.72;
export const TIP_FRACTION = 0.18;
/** The sheet reaches this far past the outermost tip (fraction of the semispan). */
const SHEET_OVERHANG = 0.06;

/**
 * Build the spawn region.
 * @param semispan overall semispan of the wing (m); used to size the concentrated band
 * @param centerZ  height of the wing in the tunnel (m), default 0
 */
export function makeSpawnRegion(
  domain: TunnelDomain,
  semispan: number,
  centerZ = 0,
  bandFraction = BAND_FRACTION,
  smoke: SmokeSources | null = null,
): SpawnRegion {
  const margin = 1e-4;
  const lx = domain.max[0] - domain.min[0];
  const ly = domain.max[1] - domain.min[1];
  const lz = domain.max[2] - domain.min[2];
  const min: Vec3 = [
    domain.min[0] + margin * lx,
    domain.min[1] + margin * ly,
    domain.min[2] + margin * lz,
  ];
  const max: Vec3 = [
    domain.max[0] - margin * lx,
    domain.max[1] - margin * ly,
    domain.max[2] - margin * lz,
  ];
  const halfY = Math.min(BAND_Y_FACTOR * semispan, 0.5 * (max[1] - min[1]));
  const halfZ = Math.min(BAND_Z_FACTOR * semispan, 0.5 * (max[2] - min[2]));
  // Keep the band inside the domain even if the wing is off-centre.
  const cz = Math.min(Math.max(centerZ, min[2] + halfZ), max[2] - halfZ);
  return {
    min,
    max,
    bandHalfY: halfY,
    bandHalfZ: halfZ,
    bandCenterZ: cz,
    bandFraction,
    smoke,
  };
}

interface Station {
  y: number;
  x: number;
  z: number;
  chord: number;
}

/**
 * Smoke sources for a wing pitched by `alpha` (rad) about its pivot: the sheet follows the
 * leading-edge height across the span (sweep and dihedral included), the tip disks sit round the
 * outermost tips.
 */
export function makeSmokeSources(geometry: WingGeometry, alpha: number): SmokeSources | null {
  const wing = geometry.surfaces.find((s) => s.side === 'right' && s.role === 'wing');
  if (!wing || wing.sections.length < 2) return null;
  const [px, , pz] = geometry.pivot;
  const sa = Math.sin(Number.isFinite(alpha) ? alpha : 0);
  const ca = Math.cos(Number.isFinite(alpha) ? alpha : 0);
  const pitchZ = (x: number, z: number) => pz - (x - px) * sa + (z - pz) * ca;
  const stations: Station[] = wing.sections.map((s) => ({
    y: s.le[1],
    x: s.le[0],
    z: pitchZ(s.le[0], s.le[2]),
    chord: s.chord,
  }));
  const base = stations[stations.length - 1]!;
  // Outermost right-side point (a winglet top or raked tip), where the vortex is shed.
  let outer = base;
  for (const surface of geometry.surfaces) {
    if (surface.side !== 'right') continue;
    for (const s of surface.sections) {
      if (s.le[1] > outer.y)
        outer = { y: s.le[1], x: s.le[0], z: pitchZ(s.le[0], s.le[2]), chord: s.chord };
    }
  }
  const semispan = Math.max(outer.y, 1e-6);
  const halfSpan = (1 + SHEET_OVERHANG) * semispan;
  const z = new Float32Array(SHEET_SAMPLES);
  const thickness = new Float32Array(SHEET_SAMPLES);
  for (let i = 0; i < SHEET_SAMPLES; i++) {
    const y = Math.abs(-halfSpan + (2 * halfSpan * i) / (SHEET_SAMPLES - 1));
    let k = 0;
    while (k < stations.length - 2 && stations[k + 1]!.y < y) k++;
    const a = stations[k]!;
    const b = stations[k + 1]!;
    const f = b.y > a.y ? Math.min(1, Math.max(0, (y - a.y) / (b.y - a.y))) : 1;
    const chord = a.chord + (b.chord - a.chord) * f;
    // The dividing streamline arrives a little below the leading edge.
    z[i] = a.z + (b.z - a.z) * f - 0.03 * chord;
    thickness[i] = Math.max(0.3 * chord, 0.018 * semispan);
  }
  const tipZ = 0.5 * (base.z + outer.z);
  const tipR = Math.max(0.07 * semispan, 1.1 * base.chord);
  const tipY = 0.5 * (base.y + outer.y) - 0.25 * tipR;
  return {
    halfSpan,
    z,
    thickness,
    tips: Float32Array.from([tipY, tipZ, tipR, -tipY, tipZ, tipR]),
    sheetFraction: SHEET_FRACTION,
    tipFraction: TIP_FRACTION,
  };
}

function clampInto(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pick (y, z) for a new particle and return what it was released as.
 * With smoke sources: sheet, tip disk or ambient dust; otherwise band (as "sheet") or ambient.
 */
export function pickCrossSection(
  region: SpawnRegion,
  rng: () => number,
  out: Float32Array,
  offset: number,
): SpawnKind {
  const smoke = region.smoke;
  const [, y0, z0] = region.min;
  const [, y1, z1] = region.max;
  if (!smoke) {
    if (rng() < region.bandFraction) {
      out[offset + 1] = (rng() * 2 - 1) * region.bandHalfY;
      out[offset + 2] = region.bandCenterZ + (rng() * 2 - 1) * region.bandHalfZ;
      return KIND_SHEET;
    }
    out[offset + 1] = y0 + rng() * (y1 - y0);
    out[offset + 2] = z0 + rng() * (z1 - z0);
    return KIND_AMBIENT;
  }
  const r = rng();
  if (r < smoke.sheetFraction) {
    const u = rng();
    const y = (u * 2 - 1) * smoke.halfSpan;
    const f = u * (SHEET_SAMPLES - 1);
    const i = Math.min(SHEET_SAMPLES - 2, Math.floor(f));
    const w = f - i;
    const zc = smoke.z[i]! + (smoke.z[i + 1]! - smoke.z[i]!) * w;
    const th = smoke.thickness[i]! + (smoke.thickness[i + 1]! - smoke.thickness[i]!) * w;
    // Triangular profile: densest at the centre of the sheet.
    const v = rng() - rng();
    out[offset + 1] = clampInto(y, y0, y1);
    out[offset + 2] = clampInto(zc + th * v, z0, z1);
    return KIND_SHEET;
  }
  if (r < smoke.sheetFraction + smoke.tipFraction) {
    const t = rng() < 0.5 ? 0 : 3;
    const radius = smoke.tips[t + 2]! * Math.sqrt(rng());
    const th = 2 * Math.PI * rng();
    out[offset + 1] = clampInto(smoke.tips[t]! + radius * Math.cos(th), y0, y1);
    out[offset + 2] = clampInto(smoke.tips[t + 1]! + radius * Math.sin(th), z0, z1);
    return KIND_TIP;
  }
  out[offset + 1] = y0 + rng() * (y1 - y0);
  out[offset + 2] = z0 + rng() * (z1 - z0);
  return KIND_AMBIENT;
}

/**
 * Respawn on the inlet plane. `jitterX` (>= 0, m) spreads releases over the distance the air
 * covers in one frame, so respawned particles form a continuous stream rather than frame-sized waves.
 * Writes x,y,z to out[offset..offset+2].
 */
export function spawnOnInlet(
  region: SpawnRegion,
  rng: () => number,
  jitterX: number,
  out: Float32Array,
  offset: number,
): SpawnKind {
  const span = region.max[0] - region.min[0];
  out[offset] = region.min[0] + Math.min(rng() * jitterX, 0.5 * span);
  return pickCrossSection(region, rng, out, offset);
}

/**
 * Initial placement: anywhere along the tunnel (so it is not empty at start), same cross-section
 * distribution as inlet spawns.
 */
export function spawnAnywhere(
  region: SpawnRegion,
  rng: () => number,
  out: Float32Array,
  offset: number,
): SpawnKind {
  out[offset] = region.min[0] + rng() * (region.max[0] - region.min[0]);
  return pickCrossSection(region, rng, out, offset);
}
