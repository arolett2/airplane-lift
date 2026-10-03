/**
 * Shared GPU plumbing for the flow visuals: a soft round point-sprite material (size attenuated
 * in perspective, sized in model metres so it scales with the tunnel) and a fading-line material
 * for particle trails. Contains the only GLSL of the flow module.
 *
 * Both honour the renderer's clipping planes (the side/section cutaway) and an optional
 * "light sheet": a slab |y - y0| < half (model metres) outside which they fade out, like smoke
 * lit by a laser sheet in a real wind tunnel.
 */
import {
  AdditiveBlending,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector4,
  type Object3D,
  type WebGLRenderer,
} from 'three';

export interface SpriteMaterialOptions {
  /** Sprite diameter in model metres (before the per-vertex size multiplier). */
  worldSize: number;
  /** Clamp of the on-screen diameter in CSS pixels. */
  minPx: number;
  maxPx: number;
  /** 0..1: how strongly the sprite centre is blown out to white (for bright timeline markers). */
  core: number;
  /** Global opacity multiplier. */
  opacity: number;
  additive: boolean;
}

/**
 * Light-sheet fade: the slab |n.p - offset| < half (model metres).
 * uSheetPlane = (n, offset), uSheetWidth = (half width, enabled).
 */
const SHEET_GLSL = /* glsl */ `
  uniform vec4 uSheetPlane;
  uniform vec2 uSheetWidth;
  float sheetFade(vec3 p) {
    if (uSheetWidth.y < 0.5) return 1.0;
    float dist = abs(dot(uSheetPlane.xyz, p) - uSheetPlane.w);
    return 1.0 - smoothstep(0.55 * uSheetWidth.x, uSheetWidth.x, dist);
  }
`;

const SPRITE_VERTEX = /* glsl */ `
  #include <clipping_planes_pars_vertex>
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aSize;
  uniform float uWorldSize;
  uniform float uPixelScale;
  uniform vec2 uPxRange;
  varying vec3 vColor;
  varying float vAlpha;
  ${SHEET_GLSL}
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // modelViewMatrix includes the uniform scale of the model root; world size is in model metres.
    float modelScale = length(modelViewMatrix[0].xyz);
    float px = uWorldSize * aSize * modelScale * projectionMatrix[1][1] * uPixelScale / max(-mvPosition.z, 1e-4);
    gl_PointSize = clamp(px, uPxRange.x, uPxRange.y);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
    vColor = aColor;
    vAlpha = aAlpha * sheetFade(position);
  }
`;

const SPRITE_FRAGMENT = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  uniform float uCore;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    #include <clipping_planes_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 >= 1.0 || vAlpha < 0.004) discard;
    float soft = 1.0 - r2;
    soft *= soft;
    float core = uCore * (1.0 - smoothstep(0.0, 0.5, r2));
    vec3 col = mix(vColor, vec3(1.0), core);
    gl_FragColor = vec4(col, clamp(soft * vAlpha * uOpacity + core * vAlpha * 0.6, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

const TRAIL_VERTEX = /* glsl */ `
  #include <clipping_planes_pars_vertex>
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  ${SHEET_GLSL}
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
    vColor = aColor;
    vAlpha = aAlpha * sheetFade(position);
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(vColor, vAlpha);
    #include <colorspace_fragment>
  }
`;

export function createSpriteMaterial(opts: SpriteMaterialOptions): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    uniforms: {
      uWorldSize: { value: opts.worldSize },
      uPixelScale: { value: 400 },
      uPxRange: { value: new Vector2(opts.minPx, opts.maxPx) },
      uCore: { value: opts.core },
      uOpacity: { value: opts.opacity },
      uSheetPlane: { value: new Vector4(0, 1, 0, 0) },
      uSheetWidth: { value: new Vector2(1, 0) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    clipping: true,
    blending: opts.additive ? AdditiveBlending : NormalBlending,
  });
}

export function createTrailMaterial(additive: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: TRAIL_VERTEX,
    fragmentShader: TRAIL_FRAGMENT,
    uniforms: {
      uSheetPlane: { value: new Vector4(0, 1, 0, 0) },
      uSheetWidth: { value: new Vector2(1, 0) },
    },
    clipping: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? AdditiveBlending : NormalBlending,
  });
}

/** A slab |normal . p - offset| < halfWidth (model metres; `normal` is a unit vector). */
export interface LightSheet {
  normal: readonly [number, number, number];
  offset: number;
  halfWidth: number;
}

/** Restrict a flow material to a light sheet, or show everything again with null. */
export function setLightSheet(material: ShaderMaterial, sheet: LightSheet | null): void {
  const plane = material.uniforms['uSheetPlane'];
  const width = material.uniforms['uSheetWidth'];
  if (!plane || !width) return;
  if (sheet) {
    const [x, y, z] = sheet.normal;
    (plane.value as Vector4).set(x, y, z, sheet.offset);
    (width.value as Vector2).set(Math.max(1e-6, sheet.halfWidth), 1);
  } else {
    (width.value as Vector2).set(1, 0);
  }
}

const _size = new Vector2();

/**
 * Keep a sprite material's pixel scale and pixel clamps in sync with the renderer right before
 * the object draws (viewport height and device pixel ratio can change at any time).
 */
export function bindSpriteViewport(
  object: Object3D,
  material: ShaderMaterial,
  minCssPx: number,
  maxCssPx: number,
): void {
  object.onBeforeRender = (renderer: WebGLRenderer) => {
    renderer.getDrawingBufferSize(_size);
    const pr = renderer.getPixelRatio();
    const u = material.uniforms;
    u['uPixelScale']!.value = _size.y * 0.5;
    (u['uPxRange']!.value as Vector2).set(minCssPx * pr, maxCssPx * pr);
  };
}
