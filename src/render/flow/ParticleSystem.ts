/**
 * Wind-tunnel "dust": tens of thousands of tiny particles carried through the 3D velocity field,
 * drawn as soft round sprites plus short fading motion trails (so the swirl of the tip vortex
 * reads clearly). Simulation lives in ParticleSim (pure CPU, typed arrays); this class only owns
 * the three.js objects and copies/flags the attributes each frame without allocating.
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
import { MAX_PARTICLES, ParticleSim, particleCountFor } from './particleSim';
import { makeSpawnRegion, type SpawnRegion } from './spawn';
import { bindSpriteViewport, createSpriteMaterial, createTrailMaterial } from './sprites';

/** Particle sprite diameter relative to the tunnel length. */
const SPRITE_SIZE_FRACTION = 0.005;
const SPRITE_MIN_PX = 1.8;
const SPRITE_MAX_PX = 7;
/** Opacity of the trail at the head end (the tail end is transparent). */
const TRAIL_HEAD_ALPHA = 0.55;

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
      opacity: 0.75,
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

    // Trails: two vertices (head, lagging tail) per particle.
    this.trailPos = new Float32Array(MAX_PARTICLES * 6);
    this.trailColor = new Float32Array(MAX_PARTICLES * 6);
    this.trailAlpha = new Float32Array(MAX_PARTICLES * 2);
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

  /** Set the spawn region: the tunnel inlet plane, concentrated around the wing's footprint. */
  setDomain(domain: TunnelDomain, geometry: WingGeometry | null): void {
    const halfWidth = 0.5 * (domain.max[1] - domain.min[1]);
    // tunnelDomain() sizes the half-width as 1.5 semispans, which is the fallback without geometry.
    const semispan = geometry ? 0.5 * geometry.overallSpan : halfWidth / 1.5;
    const centerZ = geometry ? geometry.pivot[2] : 0;
    this.sim.setSpawnRegion(makeSpawnRegion(domain, semispan, centerZ));
    const lengthMeters = domain.max[0] - domain.min[0];
    this.material.uniforms['uWorldSize']!.value = SPRITE_SIZE_FRACTION * lengthMeters;
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
    const tail = this.sim.tail;
    const color = this.sim.color;
    const alpha = this.sim.alpha;
    const tp = this.trailPos;
    const tc = this.trailColor;
    const ta = this.trailAlpha;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3;
      const o6 = i * 6;
      tp[o6] = pos[o3]!;
      tp[o6 + 1] = pos[o3 + 1]!;
      tp[o6 + 2] = pos[o3 + 2]!;
      tp[o6 + 3] = tail[o3]!;
      tp[o6 + 4] = tail[o3 + 1]!;
      tp[o6 + 5] = tail[o3 + 2]!;
      const r = color[o3]!;
      const g = color[o3 + 1]!;
      const b = color[o3 + 2]!;
      tc[o6] = r;
      tc[o6 + 1] = g;
      tc[o6 + 2] = b;
      tc[o6 + 3] = r;
      tc[o6 + 4] = g;
      tc[o6 + 5] = b;
      ta[i * 2] = alpha[i]! * TRAIL_HEAD_ALPHA;
      ta[i * 2 + 1] = 0;
    }
    this.trailGeometry.setDrawRange(0, n * 2);
    flag(this.trailGeometry, ['position', 'aColor', 'aAlpha']);
  }
}

function flag(geometry: BufferGeometry, names: string[]): void {
  for (const name of names) {
    const attr = geometry.getAttribute(name);
    if (attr) attr.needsUpdate = true;
  }
}
