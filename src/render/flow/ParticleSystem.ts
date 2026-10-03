/**
 * Wind-tunnel smoke: a few thousand particles released as a thin sheet at wing height and round
 * the tips (see spawn.ts), carried through the 3D velocity field and drawn as small soft sprites
 * with fading motion trails, so the split over and under the wing, the downwash behind it and the
 * curl of the tip vortices read clearly. Undisturbed smoke is dim; smoke the wing has sped up or
 * slowed down is bright. Simulation lives in ParticleSim (pure CPU, typed arrays); this class only
 * owns the three.js objects and copies/flags the attributes each frame without allocating.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  LineSegments,
  Points,
  type ShaderMaterial,
} from 'three';
import type { TunnelDomain } from '../../physics/domain';
import type { FlowFieldGrid, WingGeometry } from '../../physics/types';
import type { ColorBy } from '../../state/params';
import { MAX_PARTICLES, ParticleSim, TRAIL_POINTS, particleCountFor } from './particleSim';
import { makeSmokeSources, makeSpawnRegion, type SpawnRegion } from './spawn';
import {
  bindSpriteViewport,
  createSpriteMaterial,
  createTrailMaterial,
  setLightSheet,
  type LightSheet,
} from './sprites';

/** Particle sprite diameter relative to the tunnel length. */
const SPRITE_SIZE_FRACTION = 0.0032;
const SPRITE_MIN_PX = 1.5;
const SPRITE_MAX_PX = 5;
/** Opacity of the trail at the head end (the tail end is transparent). */
const TRAIL_HEAD_ALPHA = 0.75;
/**
 * Trails are drawn as seen from a frame drifting downstream at this fraction of the freestream
 * speed: a particle in undisturbed air leaves a short straight streak, while the ways the wing
 * deflects the air (upwash ahead, downwash behind, the swirl round each tip) show up as
 * clearly bent, curling trails instead of being lost in the fast through-flow. 0 = true paths.
 */
export const TRAIL_DRIFT = 0.8;
/** Trail vertices per particle: head + history samples, as TRAIL_POINTS segments. */
const TRAIL_VERTS = 2 * TRAIL_POINTS;

export interface ParticleSystemOptions {
  /** Additive blending (suits dark backgrounds); default normal blending. */
  additive?: boolean;
  /** Seed for the particle random generator (deterministic spawns). */
  seed?: number;
}

export class ParticleSystem {
  readonly object = new Group();

  private readonly sim: ParticleSim;
  private readonly material: ShaderMaterial;
  private readonly trailMaterial: ShaderMaterial;
  private readonly points: Points;
  private readonly trails: LineSegments;
  private readonly pointGeometry = new BufferGeometry();
  private readonly trailGeometry = new BufferGeometry();
  private readonly trailPos: Float32Array;
  private readonly trailColor: Float32Array;
  private readonly trailAlpha: Float32Array;

  private visible = true;
  private trailsOn = true;
  private trailDrift = TRAIL_DRIFT;
  private domain: TunnelDomain | null = null;
  private geometry: WingGeometry | null = null;
  private alpha = 0;
  private density = 1;
  private hasField = false;
  /** GPU attributes need a refresh even though the simulation did not advance. */
  private buffersStale = true;

  constructor(options: ParticleSystemOptions = {}) {
    const additive = options.additive ?? false;
    this.object.name = 'ParticleSystem';
    this.sim = new ParticleSim(MAX_PARTICLES, options.seed);

    this.material = createSpriteMaterial({
      worldSize: 0.3,
      minPx: SPRITE_MIN_PX,
      maxPx: SPRITE_MAX_PX,
      core: 0,
      opacity: 0.9,
      additive,
    });
    this.trailMaterial = createTrailMaterial(additive);

    // Points share the simulation's arrays directly: no per-frame copy.
    this.pointGeometry.setAttribute(
      'position',
      new BufferAttribute(this.sim.pos, 3).setUsage(DynamicDrawUsage),
    );
    this.pointGeometry.setAttribute(
      'aColor',
      new BufferAttribute(this.sim.color, 3).setUsage(DynamicDrawUsage),
    );
    this.pointGeometry.setAttribute(
      'aAlpha',
      new BufferAttribute(this.sim.alpha, 1).setUsage(DynamicDrawUsage),
    );
    this.pointGeometry.setAttribute(
      'aSize',
      new BufferAttribute(new Float32Array(MAX_PARTICLES).fill(1), 1),
    );
    this.pointGeometry.setDrawRange(0, 0);
    this.points = new Points(this.pointGeometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    bindSpriteViewport(this.points, this.material, SPRITE_MIN_PX, SPRITE_MAX_PX);

    // Trails: a polyline per particle, head -> newest sample -> ... -> oldest sample, drawn as
    // TRAIL_POINTS line segments (two vertices each) fading toward the oldest end.
    this.trailPos = new Float32Array(MAX_PARTICLES * TRAIL_VERTS * 3);
    this.trailColor = new Float32Array(MAX_PARTICLES * TRAIL_VERTS * 3);
    this.trailAlpha = new Float32Array(MAX_PARTICLES * TRAIL_VERTS);
    this.trailGeometry.setAttribute(
      'position',
      new BufferAttribute(this.trailPos, 3).setUsage(DynamicDrawUsage),
    );
    this.trailGeometry.setAttribute(
      'aColor',
      new BufferAttribute(this.trailColor, 3).setUsage(DynamicDrawUsage),
    );
    this.trailGeometry.setAttribute(
      'aAlpha',
      new BufferAttribute(this.trailAlpha, 1).setUsage(DynamicDrawUsage),
    );
    this.trailGeometry.setDrawRange(0, 0);
    this.trails = new LineSegments(this.trailGeometry, this.trailMaterial);
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 2;

    this.object.add(this.trails);
    this.object.add(this.points);

    this.sim.setCount(particleCountFor(this.density));
    this.applyVisibility();
  }

  /** The current spawn region (null before a field or domain has been set). */
  get spawnRegion(): SpawnRegion | null {
    return this.sim.spawnRegion;
  }

  /** Number of live particles. */
  get count(): number {
    return this.sim.count;
  }

  /** Install a new velocity field (null hides the particles). Particles keep their positions. */
  setField(grid: FlowFieldGrid | null): void {
    this.hasField = grid !== null;
    this.sim.setField(grid);
    this.applyVisibility();
  }

  /**
   * Set the spawn region: smoke sources on the tunnel inlet plane, shaped to the wing (a sheet at
   * leading-edge height across the span plus disks round the tips).
   */
  setDomain(domain: TunnelDomain, geometry: WingGeometry | null): void {
    this.domain = domain;
    this.geometry = geometry;
    this.updateSpawnRegion();
    const lengthMeters = domain.max[0] - domain.min[0];
    this.material.uniforms['uWorldSize']!.value = SPRITE_SIZE_FRACTION * lengthMeters;
  }

  /** The wing's pitch (rad): the smoke sheet follows its leading-edge height. */
  setAlpha(alphaRad: number): void {
    const a = Number.isFinite(alphaRad) ? alphaRad : 0;
    if (Math.abs(a - this.alpha) < 1e-4) return;
    this.alpha = a;
    if (this.domain) this.updateSpawnRegion();
  }

  /** Particle budget multiplier (0.25 .. 2); base budget is ~14000, capped at 30000. */
  setDensity(multiplier: number): void {
    this.density = Math.min(2, Math.max(0.25, Number.isFinite(multiplier) ? multiplier : 1));
    this.sim.setCount(particleCountFor(this.density));
    this.pointGeometry.setDrawRange(0, this.sim.count);
  }

  setColorBy(mode: ColorBy): void {
    this.sim.setColorMode(mode);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.applyVisibility();
  }

  /**
   * Show only the smoke within a slab (physics metres), like smoke lit by a laser light sheet;
   * null shows all of it. Used by the cutaway shots.
   */
  setLightSheet(sheet: LightSheet | null): void {
    setLightSheet(this.material, sheet);
    setLightSheet(this.trailMaterial, sheet);
  }

  /** Trail length as a fraction of the freestream transit time (null = the default). */
  setTrailLength(transitFraction: number | null): void {
    this.sim.setTrailLength(transitFraction);
  }

  /** Fraction of the freestream the trail frame drifts with (0 = true particle paths). */
  setTrailDrift(fraction: number): void {
    this.trailDrift = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    this.buffersStale = true;
  }

  /** Turn the motion trails off (cheaper) or on. */
  setTrails(on: boolean): void {
    this.trailsOn = on;
    this.trails.visible = on;
    this.buffersStale = true;
  }

  /** Advance the particles by dtSim physical seconds (0 while paused) and refresh attributes. */
  update(dtSim: number): void {
    if (!this.visible || !this.hasField) return;
    const changed = this.sim.update(dtSim);
    if (changed || this.buffersStale) this.refreshBuffers();
  }

  dispose(): void {
    this.pointGeometry.dispose();
    this.trailGeometry.dispose();
    this.material.dispose();
    this.trailMaterial.dispose();
    this.object.clear();
  }

  /* ---------------------------------------------------------------------------------------- */

  private updateSpawnRegion(): void {
    const domain = this.domain;
    if (!domain) return;
    const geometry = this.geometry;
    const halfWidth = 0.5 * (domain.max[1] - domain.min[1]);
    // tunnelDomain() sizes the half-width as 1.5 semispans, which is the fallback without geometry.
    const semispan = geometry ? 0.5 * geometry.overallSpan : halfWidth / 1.5;
    const centerZ = geometry ? geometry.pivot[2] : 0;
    const smoke = geometry?.surfaces ? makeSmokeSources(geometry, this.alpha) : null;
    this.sim.setSpawnRegion(makeSpawnRegion(domain, semispan, centerZ, undefined, smoke));
  }

  private applyVisibility(): void {
    this.object.visible = this.visible && this.hasField;
    this.trails.visible = this.trailsOn;
    this.buffersStale = true;
  }

  /** Mirror the simulation state into GPU attributes (cheap: copies and flags only). */
  private refreshBuffers(): void {
    this.buffersStale = false;
    const n = this.sim.count;
    this.pointGeometry.setDrawRange(0, n);
    flag(this.pointGeometry, ['position', 'aColor', 'aAlpha']);

    if (!this.trailsOn) return;
    const pos = this.sim.pos;
    const hist = this.sim.history;
    const head = this.sim.historyHead;
    const histTime = this.sim.historyTime;
    const valid = this.sim.historyCount;
    const now = this.sim.time;
    const drift = this.trailDrift * this.sim.freestreamSpeed;
    const color = this.sim.color;
    const alpha = this.sim.alpha;
    const tp = this.trailPos;
    const tc = this.trailColor;
    const ta = this.trailAlpha;
    const K = TRAIL_POINTS;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3;
      const r = color[o3]!;
      const g = color[o3 + 1]!;
      const b = color[o3 + 2]!;
      const a0 = alpha[i]! * TRAIL_HEAD_ALPHA;
      const base = i * K * 3;
      let v = i * TRAIL_VERTS;
      // Segment start = previous point (the head first), end = next older history sample.
      let px = pos[o3]!;
      let py = pos[o3 + 1]!;
      let pz = pos[o3 + 2]!;
      const nValid = valid[i]!;
      for (let k = 0; k < K; k++) {
        const slot = (head - k + K) % K;
        const h = base + slot * 3;
        let qx = px;
        let qy = py;
        let qz = pz;
        if (k < nValid) {
          qx = hist[h]! + drift * (now - histTime[slot]!);
          qy = hist[h + 1]!;
          qz = hist[h + 2]!;
        }
        const p3 = v * 3;
        tp[p3] = px;
        tp[p3 + 1] = py;
        tp[p3 + 2] = pz;
        tp[p3 + 3] = qx;
        tp[p3 + 4] = qy;
        tp[p3 + 5] = qz;
        tc[p3] = r;
        tc[p3 + 1] = g;
        tc[p3 + 2] = b;
        tc[p3 + 3] = r;
        tc[p3 + 4] = g;
        tc[p3 + 5] = b;
        ta[v] = a0 * (1 - k / K);
        ta[v + 1] = a0 * (1 - (k + 1) / K);
        px = qx;
        py = qy;
        pz = qz;
        v += 2;
      }
    }
    this.trailGeometry.setDrawRange(0, n * TRAIL_VERTS);
    flag(this.trailGeometry, ['position', 'aColor', 'aAlpha']);
  }
}

function flag(geometry: BufferGeometry, names: string[]): void {
  for (const name of names) {
    const attr = geometry.getAttribute(name);
    if (attr) attr.needsUpdate = true;
  }
}
