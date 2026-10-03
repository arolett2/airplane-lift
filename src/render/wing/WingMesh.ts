/**
 * The wing as a three.js mesh, in physics meters.
 *
 * `object` is a pivot group: its position is `geometry.pivot` and `rotation.y = alpha`, which is
 * exactly the nose-up pitch about +y through the pivot that `physics/math/frames.ts` defines
 * (three's R_y(a) maps x' = x cos a + z sin a, z' = -x sin a + z cos a). The lofted surfaces,
 * which are in the unpitched body frame, sit inside it offset by -pivot.
 */
import * as THREE from 'three';
import type { StripResult, WingGeometry } from '../../physics/types';
import { disposeObject3D } from '../util/disposal';
import { loftWing } from './loft';
import type { LoftedWing } from './loft';
import { bindStrips, colorizeWing } from './surfaceColors';
import type { StripBinding } from './surfaceColors';

/** Adds a diagonal hatch over separated (stalled) regions, driven by the `stall` attribute. */
function installStallHatch(material: THREE.MeshStandardMaterial, spacing: { value: number }): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHatchSpacing = spacing;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float stall;\nvarying float vStall;\nvarying vec2 vHatchPos;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvStall = stall;\nvHatchPos = position.xy;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uHatchSpacing;\nvarying float vStall;\nvarying vec2 vHatchPos;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float g = (vHatchPos.x + vHatchPos.y) / uHatchSpacing;
          float aa = max(fwidth(g), 1e-4);
          float stripe = smoothstep(0.25 - aa, 0.25 + aa, abs(fract(g) - 0.5));
          diffuseColor.rgb *= 1.0 - 0.5 * vStall * stripe;
        }`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        // Seen through the side / section cutaway, the inside of the skin is drawn flat slate
        // (unlit), so the cut reads as a solid airfoil section.
        if (!gl_FrontFacing) gl_FragColor.rgb = vec3(0.16, 0.19, 0.26);`,
      );
  };
  material.customProgramCacheKey = () => 'wing-stall-hatch-v3';
}

export class WingMesh {
  readonly object = new THREE.Group();

  private readonly body = new THREE.Group();
  private readonly pressureMaterial: THREE.MeshStandardMaterial;
  private readonly plainMaterial: THREE.MeshStandardMaterial;
  private readonly hatchSpacing = { value: 0.1 };

  private mesh: THREE.Mesh | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private lofted: LoftedWing | null = null;
  private strips: StripResult[] | null = null;
  private bindings: Array<StripBinding | null> | null = null;
  private pressureVisible = true;

  constructor() {
    this.object.name = 'WingMesh';
    this.object.add(this.body);

    this.pressureMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.48,
      metalness: 0.12,
      side: THREE.DoubleSide,
      envMapIntensity: 0.85,
    });
    installStallHatch(this.pressureMaterial, this.hatchSpacing);

    this.plainMaterial = new THREE.MeshStandardMaterial({
      color: 0xd7dde5,
      roughness: 0.26,
      metalness: 0.9,
      side: THREE.DoubleSide,
    });
  }

  /** Loft all surfaces from the body-frame geometry and (re)build the GPU buffers. */
  setGeometry(geometry: WingGeometry): void {
    const lofted = loftWing(geometry);
    this.lofted = lofted;
    this.object.position.set(geometry.pivot[0], geometry.pivot[1], geometry.pivot[2]);
    this.body.position.set(-geometry.pivot[0], -geometry.pivot[1], -geometry.pivot[2]);
    this.hatchSpacing.value = Math.max(0.01, 0.16 * geometry.meanAeroChord);
    this.uploadBuffers(lofted);
    this.bindings = bindStrips(lofted, this.strips);
    this.recolor();
  }

  /** Pitch nose-up by `alphaRad` about +y through the pivot (same as physics). */
  setAlpha(alphaRad: number): void {
    this.object.rotation.y = alphaRad;
  }

  /** Colour the surface from the strips' chordwise Cp (null = neutral). */
  setStrips(strips: StripResult[] | null): void {
    this.strips = strips;
    if (!this.lofted) return;
    this.bindings = bindStrips(this.lofted, strips);
    this.recolor();
  }

  /**
   * Extra clipping planes for the wing only (world space), e.g. the far side of the side-view
   * cutaway slab; null removes them.
   */
  setClipPlanes(planes: THREE.Plane[] | null): void {
    const list = planes ?? [];
    for (const m of [this.pressureMaterial, this.plainMaterial]) {
      const before = m.clippingPlanes?.length ?? 0;
      m.clippingPlanes = list.length ? list : null;
      if (before !== list.length) m.needsUpdate = true;
    }
  }

  /** false => plain light-grey metallic wing without pressure colours. */
  setPressureVisible(on: boolean): void {
    this.pressureVisible = on;
    if (this.mesh) this.mesh.material = on ? this.pressureMaterial : this.plainMaterial;
  }

  dispose(): void {
    disposeObject3D(this.object);
    this.pressureMaterial.dispose();
    this.plainMaterial.dispose();
    this.geometry = null;
    this.mesh = null;
    this.lofted = null;
    this.object.removeFromParent();
  }

  /* ---------------------------------------------------------------------------------------- */

  private uploadBuffers(lofted: LoftedWing): void {
    const geo = this.geometry;
    const reusable =
      geo !== null &&
      (geo.getAttribute('position') as THREE.BufferAttribute).array.length ===
        lofted.positions.length &&
      geo.index !== null &&
      geo.index.array.length === lofted.indices.length;

    if (reusable && geo) {
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
      (pos.array as Float32Array).set(lofted.positions);
      (nor.array as Float32Array).set(lofted.normals);
      (geo.index!.array as Uint32Array).set(lofted.indices);
      pos.needsUpdate = true;
      nor.needsUpdate = true;
      geo.index!.needsUpdate = true;
    } else {
      this.geometry?.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(lofted.positions.slice(), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(lofted.normals.slice(), 3));
      g.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(lofted.vertexCount * 3), 3),
      );
      g.setAttribute('stall', new THREE.BufferAttribute(new Float32Array(lofted.vertexCount), 1));
      g.setIndex(new THREE.BufferAttribute(lofted.indices.slice(), 1));
      this.geometry = g;
      if (!this.mesh) {
        this.mesh = new THREE.Mesh(
          g,
          this.pressureVisible ? this.pressureMaterial : this.plainMaterial,
        );
        this.mesh.name = 'Wing';
        this.mesh.frustumCulled = false;
        this.body.add(this.mesh);
      } else {
        this.mesh.geometry = g;
      }
    }
    this.geometry!.computeBoundingSphere();
    this.geometry!.computeBoundingBox();
  }

  private recolor(): void {
    if (!this.lofted || !this.geometry) return;
    const color = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const stall = this.geometry.getAttribute('stall') as THREE.BufferAttribute;
    colorizeWing(
      this.lofted,
      this.bindings,
      color.array as Float32Array,
      stall.array as Float32Array,
    );
    color.needsUpdate = true;
    stall.needsUpdate = true;
  }
}
