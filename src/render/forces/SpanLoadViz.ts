/**
 * The "lift curtain": a thin bar standing on every strip along the strip normal, its height
 * proportional to the lift per unit span there, coloured green -> amber -> red by how close the
 * section is to stall (cl / clMax). A dashed ellipse with the SAME total lift is drawn as the
 * efficient reference, so the gap between bars and ellipse shows what a better planform buys.
 *
 * Strips carry tunnel-frame centres and normals already, so this lives directly in physics
 * meters under `modelRoot`. Works for tip devices too (their bars lie along their own normals).
 */
import * as THREE from 'three';
import type { AeroResult, StripResult, Vec3, WingGeometry } from '../../physics/types';
import type { RGB } from '../../shared/colormaps';
import { disposeObject3D } from '../util/disposal';
import { nextPow2 } from '../util/math';
import { curtainBasis, curtainScale, ellipticalLoad, stallMarginColor } from './curtainMath';

/** Tallest bar, in semispans. */
const MAX_HEIGHT_SEMISPANS = 0.4;
/** Bar thickness along the chord, in semispans. */
const THICKNESS_SEMISPANS = 0.012;
/** Samples along the elliptical reference curve (even; every other segment is drawn). */
const ELLIPSE_SAMPLES = 120;

const _c: Vec3 = [1, 0, 0];
const _t: Vec3 = [0, 1, 0];
const _n: Vec3 = [0, 0, 1];
const _rgb: RGB = [0, 0, 0];

export class SpanLoadViz {
  readonly object = new THREE.Group();

  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly barMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  private readonly outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xf2f7ff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly ellipseMaterial = new THREE.LineBasicMaterial({
    color: 0xcfe6ff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false,
  });

  private bars: THREE.InstancedMesh;
  private outline: THREE.LineSegments;
  private capacity = 128;
  private readonly ellipse: THREE.LineSegments;
  private readonly ellipseAttr: THREE.BufferAttribute;

  private wantVisible = true;
  private hasData = false;

  // Scratch objects (no per-update allocation beyond sorting).
  private readonly m = new THREE.Matrix4();
  private readonly vx = new THREE.Vector3();
  private readonly vy = new THREE.Vector3();
  private readonly vz = new THREE.Vector3();
  private readonly col = new THREE.Color();

  constructor() {
    this.object.name = 'SpanLoadViz';
    this.bars = this.makeBars(128);
    this.outline = this.makeOutline(128);

    const ellipseGeo = new THREE.BufferGeometry();
    this.ellipseAttr = new THREE.BufferAttribute(new Float32Array(ELLIPSE_SAMPLES * 3), 3);
    this.ellipseAttr.setUsage(THREE.DynamicDrawUsage);
    ellipseGeo.setAttribute('position', this.ellipseAttr);
    // Dashes: segment i joins samples (2i, 2i+1) of a consecutive polyline.
    const idx: number[] = [];
    for (let i = 0; i + 1 < ELLIPSE_SAMPLES; i += 2) idx.push(i, i + 1);
    ellipseGeo.setIndex(idx);
    this.ellipse = new THREE.LineSegments(ellipseGeo, this.ellipseMaterial);
    this.ellipse.name = 'EllipticalReference';
    this.ellipse.frustumCulled = false;
    this.ellipse.renderOrder = 2;

    this.object.add(this.bars, this.outline, this.ellipse);
    this.applyVisibility();
  }

  update(aero: AeroResult | null, geometry: WingGeometry | null): void {
    if (!aero || !geometry || aero.strips.length === 0) {
      this.hasData = false;
      this.applyVisibility();
      return;
    }
    this.hasData = true;
    const strips = aero.strips;
    const semispan = Math.max(1e-3, 0.5 * geometry.referenceSpan);
    this.ensureCapacity(strips.length);

    // Common height scale: the bars and the elliptical reference share it.
    let maxLoad = 0;
    for (const s of strips) {
      if (Number.isFinite(s.liftPerSpan)) maxLoad = Math.max(maxLoad, Math.abs(s.liftPerSpan));
    }
    const ellipsePeak = (4 * Math.max(0, aero.lift)) / (Math.PI * geometry.referenceSpan);
    const k = curtainScale(maxLoad, ellipsePeak, MAX_HEIGHT_SEMISPANS * semispan);
    const thick = THICKNESS_SEMISPANS * semispan;

    this.writeBars(strips, k, thick);
    this.writeOutline(strips, k);
    this.writeEllipse(aero, geometry, k);
    this.applyVisibility();
  }

  setVisible(on: boolean): void {
    this.wantVisible = on;
    this.applyVisibility();
  }

  dispose(): void {
    this.bars.dispose();
    disposeObject3D(this.object);
    this.boxGeometry.dispose();
    this.barMaterial.dispose();
    this.outlineMaterial.dispose();
    this.ellipseMaterial.dispose();
    this.object.removeFromParent();
  }

  /* ---------------------------------------------------------------------------------------- */

  private applyVisibility(): void {
    this.object.visible = this.wantVisible && this.hasData;
  }

  private makeBars(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.boxGeometry, this.barMaterial, capacity);
    mesh.name = 'LiftCurtainBars';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.count = 0;
    return mesh;
  }

  private makeOutline(capacity: number): THREE.LineSegments {
    const g = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array(capacity * 2 * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attr);
    g.setDrawRange(0, 0);
    const ls = new THREE.LineSegments(g, this.outlineMaterial);
    ls.name = 'LiftCurtainOutline';
    ls.frustumCulled = false;
    ls.renderOrder = 2;
    return ls;
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    const cap = nextPow2(Math.max(n, 128));
    this.object.remove(this.bars, this.outline);
    this.bars.dispose();
    this.outline.geometry.dispose();
    this.bars = this.makeBars(cap);
    this.outline = this.makeOutline(cap);
    this.object.add(this.bars, this.outline);
    this.capacity = cap;
  }

  private writeBars(strips: StripResult[], k: number, thick: number): void {
    const colors = this.bars.instanceColor!;
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i]!;
      curtainBasis(s.normal, _c, _t, _n);
      // Negative load stands the bar on the other side; keep the basis right-handed.
      const load = Number.isFinite(s.liftPerSpan) ? s.liftPerSpan : 0;
      const sign = load < 0 ? -1 : 1;
      const h = Math.abs(load) * k;
      const w = Math.max(s.width * 0.92, 1e-4);
      this.vx.set(_c[0], _c[1], _c[2]).multiplyScalar(thick);
      this.vy.set(_t[0], _t[1], _t[2]).multiplyScalar(sign * w);
      this.vz.set(_n[0], _n[1], _n[2]).multiplyScalar(sign * Math.max(h, 1e-5));
      this.m.makeBasis(this.vx, this.vy, this.vz);
      // The unit box is centred: lift it by half its height so it stands on the strip centre.
      this.m.setPosition(
        s.center[0] + this.vz.x * 0.5,
        s.center[1] + this.vz.y * 0.5,
        s.center[2] + this.vz.z * 0.5,
      );
      this.bars.setMatrixAt(i, this.m);
      stallMarginColor(s.cl, s.clMax, _rgb, s.stalled);
      this.col.setRGB(_rgb[0], _rgb[1], _rgb[2]);
      colors.setXYZ(i, this.col.r, this.col.g, this.col.b);
    }
    this.bars.count = strips.length;
    this.bars.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
  }

  /** A polyline over the bar tops, one per surface (strips grouped, sorted root to tip). */
  private writeOutline(strips: StripResult[], k: number): void {
    const attr = this.outline.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    // Group consecutive strips of the same surface; order by eta within each.
    const order = strips.map((_, i) => i);
    order.sort((a, b) => {
      const sa = strips[a]!;
      const sb = strips[b]!;
      if (sa.surfaceId !== sb.surfaceId) return sa.surfaceId < sb.surfaceId ? -1 : 1;
      return sa.eta - sb.eta;
    });
    let o = 0;
    for (let q = 0; q + 1 < order.length; q++) {
      const a = strips[order[q]!]!;
      const b = strips[order[q + 1]!]!;
      if (a.surfaceId !== b.surfaceId) continue;
      curtainBasis(a.normal, _c, _t, _n);
      const ha = (Number.isFinite(a.liftPerSpan) ? a.liftPerSpan : 0) * k;
      arr[o++] = a.center[0] + _n[0] * ha;
      arr[o++] = a.center[1] + _n[1] * ha;
      arr[o++] = a.center[2] + _n[2] * ha;
      curtainBasis(b.normal, _c, _t, _n);
      const hb = (Number.isFinite(b.liftPerSpan) ? b.liftPerSpan : 0) * k;
      arr[o++] = b.center[0] + _n[0] * hb;
      arr[o++] = b.center[1] + _n[1] * hb;
      arr[o++] = b.center[2] + _n[2] * hb;
    }
    attr.needsUpdate = true;
    this.outline.geometry.setDrawRange(0, o / 3);
  }

  /**
   * Dashed ellipse with the same total lift, standing on the base wing's quarter-chord line.
   * The base line (position + normal) is interpolated along y from the base-wing strips.
   */
  private writeEllipse(aero: AeroResult, geometry: WingGeometry, k: number): void {
    const wingIds = new Set(geometry.surfaces.filter((s) => s.role === 'wing').map((s) => s.id));
    const base = aero.strips.filter((s) => wingIds.has(s.surfaceId));
    const attr = this.ellipseAttr;
    const arr = attr.array as Float32Array;
    if (base.length === 0 || aero.lift <= 0) {
      this.ellipse.visible = false;
      return;
    }
    this.ellipse.visible = true;
    base.sort((a, b) => a.center[1] - b.center[1]);
    const span = geometry.referenceSpan;
    let j = 0;
    for (let i = 0; i < ELLIPSE_SAMPLES; i++) {
      const y = -0.5 * span + (span * i) / (ELLIPSE_SAMPLES - 1);
      while (j + 1 < base.length - 1 && base[j + 1]!.center[1] < y) j++;
      const a = base[j]!;
      const b = base[Math.min(j + 1, base.length - 1)]!;
      const dy = b.center[1] - a.center[1];
      const f = dy > 1e-9 ? Math.min(1, Math.max(0, (y - a.center[1]) / dy)) : 0;
      const px = a.center[0] + (b.center[0] - a.center[0]) * f;
      const pz = a.center[2] + (b.center[2] - a.center[2]) * f;
      let nx = a.normal[0] + (b.normal[0] - a.normal[0]) * f;
      let ny = a.normal[1] + (b.normal[1] - a.normal[1]) * f;
      let nz = a.normal[2] + (b.normal[2] - a.normal[2]) * f;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const h = ellipticalLoad(y, span, aero.lift) * k;
      arr[3 * i] = px + nx * h;
      arr[3 * i + 1] = y + ny * h;
      arr[3 * i + 2] = pz + nz * h;
    }
    attr.needsUpdate = true;
    this.ellipse.geometry.computeBoundingSphere();
  }
}
