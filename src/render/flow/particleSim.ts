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
import type { ColorLut } from './flowColors';
import { FlowSampler, SAMPLE_SOLID } from './gridSampler';
import {
  KIND_AMBIENT,
  KIND_TIP,
  makeRng,
  makeSpawnRegion,
  spawnAnywhere,
  spawnOnInlet,
} from './spawn';
import type { SpawnRegion } from './spawn';

/** Particle budget at density 1 (smoke is released where it tells the story, so few suffice). */
export const BASE_PARTICLES = 7000;
/** Hard cap (density 2 would otherwise exceed it). */
export const MAX_PARTICLES = 14000;

/** Number of particles for a density multiplier (0.25 .. 2). */
export function particleCountFor(density: number): number {
  if (!(density > 0)) return 0;
  return Math.min(MAX_PARTICLES, Math.round(BASE_PARTICLES * density));
}

/**
 * Opacity of smoke in undisturbed air, relative to strongly disturbed air: the freestream
 * recedes and the flow the wing changes stands out.
 */
export const FREESTREAM_ALPHA = 0.36;
/** Extra opacity factor for the ambient dust (the sheet and tip smoke are the story). */
export const AMBIENT_ALPHA = 0.45;
/**
 * Velocity perturbation |V - Vinf| / Vinf at which a particle is fully emphasised. Unlike the
 * pressure (speed) emphasis this also catches cross-flow: the swirl of a tip vortex and the
 * downwash barely change the air's speed, but they are what the wing does to it.
 */
export const PERTURBATION_FULL = 0.12;
/** Tip smoke is always drawn at least this emphasised (it marks the vortex). */
const TIP_MIN_EMPHASIS = 0.3;

/** Particle lifetime as a multiple of the freestream transit time (min, max). */
const LIFE_MIN = 1.6;
const LIFE_MAX = 3.0;
/** Fade-in after birth, fade-out before death, as a fraction of the transit time. */
const FADE_IN = 0.035;
const FADE_OUT = 0.12;
/** Fade out over this fraction of the tunnel length before the outlet. */
const OUTLET_FADE = 0.07;
/**
 * Motion trails are short polylines through each particle's recent positions: TRAIL_POINTS
 * samples spread over TRAIL_TRANSIT_FRACTION of the freestream transit time. Curved paths
 * (the downwash, the swirl round a tip vortex) therefore read as curves, not straight dashes.
 */
export const TRAIL_POINTS = 5;
export const TRAIL_TRANSIT_FRACTION = 0.13;
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
  /**
   * Trail history: TRAIL_POINTS past positions per particle, xyz each, laid out
   * [particle][sample][xyz]. Sample `historyHead` is the newest, the one before it (cyclically)
   * the next older, and so on.
   */
  readonly history: Float32Array;
  /** Index (0 .. TRAIL_POINTS-1) of the newest history sample. */
  historyHead = 0;
  /** Simulation time at which each history sample was taken. */
  readonly historyTime = new Float64Array(TRAIL_POINTS);
  /** How many of each particle's history samples are valid (0 right after a (re)spawn). */
  readonly historyCount: Uint8Array;
  /** Simulation time advanced so far (s). */
  time = 0;
  readonly age: Float32Array;
  readonly maxAge: Float32Array;
  /** Per-particle RGB from the colour LUT (updated by update()). */
  readonly color: Float32Array;
  /** Per-particle opacity 0..1 including fades (updated by update()). */
  readonly alpha: Float32Array;
  /** What each particle was released as (spawn.ts KIND_*). */
  readonly kind: Uint8Array;
  /** Number of active particles. */
  count = 0;

  private readonly sampler = new FlowSampler();
  private readonly rng: () => number;
  private grid: FlowFieldGrid | null = null;
  private region: SpawnRegion | null = null;
  private explicitRegion = false;
  private lut: ColorLut = getColorLut('pressure');
  private transit = 1; // freestream transit time (s)
  private invVInf = 0;
  private dtMax = 0;
  /** Sim time since the last history sample. */
  private historyClock = 0;
  /** Trail length as a fraction of the transit time. */
  private trailFraction = TRAIL_TRANSIT_FRACTION;
  /** True when attributes need a refresh even though no time passes (e.g. after a field swap). */
  private dirty = true;

  constructor(capacity = MAX_PARTICLES, seed = 0x5eed) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.history = new Float32Array(capacity * TRAIL_POINTS * 3);
    this.historyCount = new Uint8Array(capacity);
    this.age = new Float32Array(capacity);
    this.maxAge = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
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

  /** Freestream speed of the current field (m/s), 0 without one. */
  get freestreamSpeed(): number {
    return this.grid?.vInf ?? 0;
  }

  /** Trail length as a fraction of the freestream transit time (null = the default). */
  setTrailLength(transitFraction: number | null): void {
    const f =
      transitFraction !== null && Number.isFinite(transitFraction) && transitFraction > 0
        ? Math.min(1, transitFraction)
        : TRAIL_TRANSIT_FRACTION;
    this.trailFraction = f;
  }

  setColorMode(mode: ColorBy): void {
    this.lut = getColorLut(mode);
    this.dirty = true;
  }

  /**
   * Install the spawn region (null = derive one from the grid). A large change (a different
   * aircraft, hence a different tunnel) re-places every particle; small changes while a slider
   * is dragged keep them flowing, and any that fall outside simply respawn.
   */
  setSpawnRegion(region: SpawnRegion | null): void {
    const previous = this.region;
    this.explicitRegion = region !== null;
    this.region = region;
    this.refreshDerived();
    if (!previous || !this.region || regionsDiffer(previous, this.region)) {
      this.reseed(0, this.count);
    }
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
      this.kind[i] = spawnAnywhere(region, rng, pos, o);
      this.resetHistory(i);
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
   * Advance every particle by dtSim physical seconds and refresh colour/alpha/trail history.
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
    const ageArr = this.age;
    const maxAgeArr = this.maxAge;
    const color = this.color;
    const alpha = this.alpha;
    const kind = this.kind;
    const lut = this.lut.rgb;
    const emphasis = this.lut.emphasis;
    const invVInf = this.invVInf;
    const vInf = grid.vInf;
    const transit = this.transit;
    const [xMin, yMin, zMin] = region.min;
    const [xMax, yMax, zMax] = region.max;
    const lx = xMax - xMin;
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
      let perturb = 0;

      if (alive) {
        for (let s = 0; s < nSub; s++) {
          // Points the grid does not cover are carried by the freestream (the sampler writes it)
          // until they leave the spawn region; only wing-interior nodes kill a particle.
          if (sampler.sample(x, y, z) === SAMPLE_SOLID) {
            alive = false;
            break;
          }
          let ux = sampler.vx;
          let uy = sampler.vy;
          let uz = sampler.vz;
          // Midpoint (RK2): re-sample half a step ahead; fall back to Euler inside the wing.
          if (sampler.sample(x + hHalf * ux, y + hHalf * uy, z + hHalf * uz) !== SAMPLE_SOLID) {
            ux = sampler.vx;
            uy = sampler.vy;
            uz = sampler.vz;
          }
          x += h * ux;
          y += h * uy;
          z += h * uz;
          speed = Math.sqrt(ux * ux + uy * uy + uz * uz) * invVInf;
          const du = ux - vInf;
          perturb = Math.sqrt(du * du + uy * uy + uz * uz) * invVInf;
          if (!(x >= xMin && x <= xMax && y >= yMin && y <= yMax && z >= zMin && z <= zMax)) {
            alive = false;
            break;
          }
        }
      }

      if (!alive) {
        kind[i] = spawnOnInlet(region, rng, jitterX, pos, o);
        this.resetHistory(i);
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

      const li = lutIndex(speed);
      const c = li * 3;
      color[o] = lut[c]!;
      color[o + 1] = lut[c + 1]!;
      color[o + 2] = lut[c + 2]!;

      let a = age * fadeInInv;
      const fo = (maxAgeArr[i]! - age) * fadeOutInv;
      if (fo < a) a = fo;
      const fx = (xMax - x) * outletInv;
      if (fx < a) a = fx;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      // Undisturbed air recedes; ambient dust stays in the background.
      let e = perturb >= PERTURBATION_FULL ? 1 : Math.pow(perturb / PERTURBATION_FULL, 0.75);
      if (emphasis[li]! > e) e = emphasis[li]!;
      const k = kind[i];
      if (k === KIND_TIP && e < TIP_MIN_EMPHASIS) e = TIP_MIN_EMPHASIS;
      a *= FREESTREAM_ALPHA + (1 - FREESTREAM_ALPHA) * e;
      if (k === KIND_AMBIENT) a *= AMBIENT_ALPHA;
      alpha[i] = a;
    }
    if (dt > 0) {
      this.time += dt;
      this.sampleHistory(dt);
    }
    return true;
  }

  /** Record a new trail sample for every particle once per sample interval. */
  private sampleHistory(dt: number): void {
    const interval = (this.trailFraction * this.transit) / TRAIL_POINTS;
    this.historyClock += dt;
    if (this.historyClock < interval) return;
    this.historyClock = this.historyClock >= 2 * interval ? 0 : this.historyClock - interval;
    const head = (this.historyHead + 1) % TRAIL_POINTS;
    this.historyHead = head;
    this.historyTime[head] = this.time;
    const pos = this.pos;
    const hist = this.history;
    const valid = this.historyCount;
    for (let i = 0, n = this.count; i < n; i++) {
      const o = i * 3;
      const h = (i * TRAIL_POINTS + head) * 3;
      hist[h] = pos[o]!;
      hist[h + 1] = pos[o + 1]!;
      hist[h + 2] = pos[o + 2]!;
      if (valid[i]! < TRAIL_POINTS) valid[i] = valid[i]! + 1;
    }
  }

  /** Collapse particle i's trail onto its current position (after a (re)spawn). */
  private resetHistory(i: number): void {
    const o = i * 3;
    const x = this.pos[o]!;
    const y = this.pos[o + 1]!;
    const z = this.pos[o + 2]!;
    const hist = this.history;
    this.historyCount[i] = 0;
    for (let k = 0, h = i * TRAIL_POINTS * 3; k < TRAIL_POINTS; k++, h += 3) {
      hist[h] = x;
      hist[h + 1] = y;
      hist[h + 2] = z;
    }
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
    this.dtMax = Math.max(
      1e-6,
      (MAX_STEP_CELLS * minCell) / (PLAN_SPEED_RATIO * Math.max(grid.vInf, 1e-3)),
    );
  }
}

/** True when the tunnel bounds moved by more than `tolerance` of their extent on any axis. */
export function regionsDiffer(a: SpawnRegion, b: SpawnRegion, tolerance = 0.2): boolean {
  for (let k = 0; k < 3; k++) {
    const extent = Math.max(a.max[k]! - a.min[k]!, 1e-9);
    if (
      Math.abs(a.min[k]! - b.min[k]!) > tolerance * extent ||
      Math.abs(a.max[k]! - b.max[k]!) > tolerance * extent
    ) {
      return true;
    }
  }
  return false;
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
