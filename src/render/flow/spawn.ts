/**
 * Where particles are born. Pure (no three.js).
 *
 * Particles are released on the inlet plane. About 60% are concentrated in a band around the
 * wing (|y| < 1.15 semispan, |z| < 0.2 semispan) where the interesting flow lives, the rest
 * are spread across the whole inlet section so the far field is not empty.
 */
import type { TunnelDomain } from '../../physics/domain';
import type { Vec3 } from '../../physics/types';

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
}

export const BAND_Y_FACTOR = 1.15;
export const BAND_Z_FACTOR = 0.2;
export const BAND_FRACTION = 0.6;

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
  };
}

/** Pick (y, z) for a new particle: in the wing band with probability bandFraction. */
export function pickCrossSection(
  region: SpawnRegion,
  rng: () => number,
  out: Float32Array,
  offset: number,
): void {
  if (rng() < region.bandFraction) {
    out[offset + 1] = (rng() * 2 - 1) * region.bandHalfY;
    out[offset + 2] = region.bandCenterZ + (rng() * 2 - 1) * region.bandHalfZ;
  } else {
    out[offset + 1] = region.min[1] + rng() * (region.max[1] - region.min[1]);
    out[offset + 2] = region.min[2] + rng() * (region.max[2] - region.min[2]);
  }
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
): void {
  const span = region.max[0] - region.min[0];
  out[offset] = region.min[0] + Math.min(rng() * jitterX, 0.5 * span);
  pickCrossSection(region, rng, out, offset);
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
): void {
  out[offset] = region.min[0] + rng() * (region.max[0] - region.min[0]);
  pickCrossSection(region, rng, out, offset);
}
