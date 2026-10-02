/**
 * CPU particle simulation for the wind-tunnel "dust": particles are advected through the
 * FlowFieldGrid with a midpoint (RK2) scheme and respawned when they leave the domain, enter the
 * wing body or get too old. Pure (no three.js); the ParticleSystem wraps the typed arrays below
 * directly as GPU attributes.
 *
 * Nothing here allocates per frame.
 */
import type { FlowFieldGrid, Vec3 } from '../../physics/types';
import type { ColorBy } from '../../state/params';
import { getColorLut, lutIndex } from './flowColors';
import { FlowSampler, SAMPLE_OK } from './gridSampler';
import { makeRng, makeSpawnRegion, spawnAnywhere, spawnOnInlet } from './spawn';
import type { SpawnRegion } from './spawn';

/** Particle budget at density 1. */
export const BASE_PARTICLES = 14000;
/** Hard cap (density 2 would otherwise exceed it). */
export const MAX_PARTICLES = 30000;

/** Number of particles for a density multiplier (0.25 .. 2). */
export function particleCountFor(density: number): number {
  if (!(density > 0)) return 0;
  return Math.min(MAX_PARTICLES, Math.round(BASE_PARTICLES * density));
}

/** Particle lifetime as a multiple of the freestream transit time (min, max). */
const LIFE_MIN = 1.6;
const LIFE_MAX = 3.0;
/** Fade-in after birth, fade-out before death, as a fraction of the transit time. */
const FADE_IN = 0.035;
const FADE_OUT = 0.12;
/** Fade out over this fraction of the tunnel length before the outlet. */
const OUTLET_FADE = 0.07;
/** Motion-trail length: how far behind (in sim time) the tail point lags, as a fraction of transit time. */
export const TRAIL_TRANSIT_FRACTION = 0.028;
/** Never move a particle further than this fraction of a grid cell per sub-step... */
const MAX_STEP_CELLS = 0.9;
/** ...using at most this many sub-steps per update (longer frames just run slow). */
const MAX_SUBSTEPS = 4;
/** Fastest local speed we plan the step size for, in freestream units. */
const PLAN_SPEED_RATIO = 2.2;

export class ParticleSim {
  readonly capacity: number;
  /** xyz per particle (tunnel frame, m). */
  readonly pos: Float32Array;
  /** Lagging point behind each particle, for the motion trail. */
  readonly tail: Float32Array;
  readonly age: Float32Array;
  readonly maxAge: Float32Array;
  /** Per-particle RGB from the colour LUT (updated by update()). */
  readonly color: Float32Array;
  /** Per-particle opacity 0..1 including fades (updated by update()). */
  readonly alpha: Float32Array;
  /** Number of active particles. */
  count = 0;

  private readonly sampler = new FlowSampler();
  private readonly rng: () => number;
  private grid: FlowFieldGrid | null = null;
  private region: SpawnRegion | null = null;
  private explicitRegion = false;
  private lut: Float32Array = getColorLut('pressure').rgb;
  private transit = 1; // freestream transit time (s)
  private invVInf = 0;
  private dtMax = 0;
  /** True when attributes need a refresh even though no time passes (e.g. after a field swap). */
  private dirty = true;

  constructor(capacity = MAX_PARTICLES, seed = 0x5eed) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.tail = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.maxAge = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);
    this.rng = makeRng(seed);
  }

  /** True when a field is loaded and particles are being simulated. */
  get active(): boolean {
    return this.grid !== null;
  }

  get spawnRegion(): SpawnRegion | null {
    return this.region;
  }

  get freestreamTransit(): number {
    return this.transit;
  }

  setColorMode(mode: ColorBy): void {
    this.lut = getColorLut(mode).rgb;
    this.dirty = true;
  }

  /**
   * Install the spawn region (null = derive one from the grid). Re-places every particle
   * because the old positions no longer match the region.
   */
  setSpawnRegion(region: SpawnRegion | null): void {
    this.explicitRegion = region !== null;
    this.region = region;
    this.refreshDerived();
    this.reseed(0, this.count);
  }

  /** Swap the velocity field. Particles keep their positions and simply follow the new field. */
  setField(grid: FlowFieldGrid | null): void {
    const first = this.grid === null;
    this.grid = grid;
    this.sampler.setGrid(grid);
    this.refreshDerived();
    if (grid && first) this.reseed(0, this.count);
    this.dirty = true;
  }

  /** Change the number of live particles; new ones are scattered through the tunnel. */
  setCount(n: number): void {
    const target = Math.max(0, Math.min(this.capacity, Math.floor(n)));
    const old = this.count;
    this.count = target;
    if (target > old) this.reseed(old, target);
    this.dirty = true;
  }

  /** Scatter particles [from, to) through the whole tunnel with ages matching their position. */
  reseed(from: number, to: number): void {
    if (!this.grid || !this.region) return;
    const region = this.region;
    const rng = this.rng;
    const lx = region.max[0] - region.min[0];
    const pos = this.pos;
    for (let i = from; i < to; i++) {
      const o = i * 3;
      spawnAnywhere(region, rng, pos, o);
      this.tail[o] = pos[o]!;
      this.tail[o + 1] = pos[o + 1]!;
      this.tail[o + 2] = pos[o + 2]!;
      const life = (LIFE_MIN + (LIFE_MAX - LIFE_MIN) * rng()) * this.transit;
      this.maxAge[i] = life;
      // Age consistent with distance travelled so lifetimes are staggered like in steady state.
      const travelled = ((pos[o]! - region.min[0]) / lx) * this.transit * (0.7 + 0.6 * rng());
      this.age[i] = Math.min(travelled, 0.9 * life);
      this.alpha[i] = 0;
    }
    this.dirty = true;
  }

  /**
   * Advance every particle by dtSim physical seconds and refresh colour/alpha/tail.
   * Returns false when nothing changed (paused, no field), so callers can skip GPU uploads.
   */
  update(dtSim: number): boolean {
    const n = this.count;
    const grid = this.grid;
    const region = this.region;
    if (n === 0 || !grid || !region) return false;
    if (!(dtSim > 0) && !this.dirty) return false;
    this.dirty = false;

    let dt = dtSim > 0 ? dtSim : 0;
    const maxDt = this.dtMax * MAX_SUBSTEPS;
    if (dt > maxDt) dt = maxDt;
    const nSub = dt > 0 ? Math.max(1, Math.ceil(dt / this.dtMax)) : 1;
    const h = dt / nSub;
    const hHalf = 0.5 * h;

    const sampler = this.sampler;
    const rng = this.rng;
    const pos = this.pos;
    const tail = this.tail;
    const ageArr = this.age;
    const maxAgeArr = this.maxAge;
    const color = this.color;
    const alpha = this.alpha;
    const lut = this.lut;
    const invVInf = this.invVInf;
    const transit = this.transit;
    const [xMin, yMin, zMin] = region.min;
    const [xMax, yMax, zMax] = region.max;
    const lx = xMax - xMin;
    const tailK = dt > 0 ? 1 - Math.exp(-dt / (TRAIL_TRANSIT_FRACTION * transit)) : 0;
    const fadeInInv = 1 / (FADE_IN * transit);
    const fadeOutInv = 1 / (FADE_OUT * transit);
    const outletInv = 1 / (OUTLET_FADE * lx);
    const jitterX = grid.vInf * dt;

    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let x = pos[o]!;
      let y = pos[o + 1]!;
      let z = pos[o + 2]!;
      const age = ageArr[i]! + dt;
      let alive = age <= maxAgeArr[i]!;
      let speed = 1;

      if (alive) {
        for (let s = 0; s < nSub; s++) {
          if (sampler.sample(x, y, z) !== SAMPLE_OK) {
            alive = false;
            break;
          }
          let ux = sampler.vx;
          let uy = sampler.vy;
          let uz = sampler.vz;
          // Midpoint (RK2): re-sample half a step ahead; fall back to Euler if that point is unusable.
          if (sampler.sample(x + hHalf * ux, y + hHalf * uy, z + hHalf * uz) === SAMPLE_OK) {
            ux = sampler.vx;
            uy = sampler.vy;
            uz = sampler.vz;
          }
          x += h * ux;
          y += h * uy;
          z += h * uz;
          speed = Math.sqrt(ux * ux + uy * uy + uz * uz) * invVInf;
          if (!(x >= xMin && x <= xMax && y >= yMin && y <= yMax && z >= zMin && z <= zMax)) {
            alive = false;
            break;
          }
        }
      }

      if (!alive) {
        spawnOnInlet(region, rng, jitterX, pos, o);
        x = pos[o]!;
        y = pos[o + 1]!;
        z = pos[o + 2]!;
        tail[o] = x;
        tail[o + 1] = y;
        tail[o + 2] = z;
        ageArr[i] = 0;
        maxAgeArr[i] = (LIFE_MIN + (LIFE_MAX - LIFE_MIN) * rng()) * transit;
        alpha[i] = 0;
        const c = lutIndex(1) * 3;
        color[o] = lut[c]!;
        color[o + 1] = lut[c + 1]!;
        color[o + 2] = lut[c + 2]!;
        continue;
      }

      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      ageArr[i] = age;
      tail[o] = tail[o]! + (x - tail[o]!) * tailK;
      tail[o + 1] = tail[o + 1]! + (y - tail[o + 1]!) * tailK;
      tail[o + 2] = tail[o + 2]! + (z - tail[o + 2]!) * tailK;

      const c = lutIndex(speed) * 3;
      color[o] = lut[c]!;
      color[o + 1] = lut[c + 1]!;
      color[o + 2] = lut[c + 2]!;

      let a = age * fadeInInv;
      const fo = (maxAgeArr[i]! - age) * fadeOutInv;
      if (fo < a) a = fo;
      const fx = (xMax - x) * outletInv;
      if (fx < a) a = fx;
      alpha[i] = a < 0 ? 0 : a > 1 ? 1 : a;
    }
    return true;
  }

  /** Recompute transit time, step limits and (when not given) the spawn region from the grid. */
  private refreshDerived(): void {
    const grid = this.grid;
    if (!grid) return;
    if (!this.explicitRegion) this.region = regionFromGrid(grid);
    const region = this.region;
    if (!region) return;
    this.invVInf = grid.vInf > 0 ? 1 / grid.vInf : 0;
    this.transit = (region.max[0] - region.min[0]) / Math.max(grid.vInf, 1e-3);
    const minCell = Math.min(grid.spacing[0], grid.spacing[1], grid.spacing[2]);
    this.dtMax = (MAX_STEP_CELLS * minCell) / (PLAN_SPEED_RATIO * Math.max(grid.vInf, 1e-3));
  }
}

/** Fallback spawn region covering the whole grid, sized assuming the standard tunnel proportions. */
export function regionFromGrid(grid: FlowFieldGrid): SpawnRegion {
  const min: Vec3 = [grid.origin[0], grid.origin[1], grid.origin[2]];
  const max: Vec3 = [
    grid.origin[0] + (grid.dims[0] - 1) * grid.spacing[0],
    grid.origin[1] + (grid.dims[1] - 1) * grid.spacing[1],
    grid.origin[2] + (grid.dims[2] - 1) * grid.spacing[2],
  ];
  // tunnelDomain() makes the half-width 0.75 * span, i.e. 1.5 semispans.
  const semispan = (0.5 * (max[1] - min[1])) / 1.5;
  return makeSpawnRegion({ min, max }, semispan, 0.5 * (min[2] + max[2]));
}
