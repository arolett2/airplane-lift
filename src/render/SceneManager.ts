/**
 * Owns the three.js renderer, Z-UP camera + OrbitControls, lights, render loop, resize, and the
 * `modelRoot` group. Everything in physics meters (wing, flow, forces, tunnel) is added to
 * `modelRoot`, which is uniformly scaled so the wing always fills the view.
 * OWNER: render-scene agent. CONTRACT — keep the public members.
 *
 * Conventions offered to other render classes:
 *  - `CSS2DObject` labels added anywhere under `scene` are drawn by an overlay renderer.
 *  - Any visible object may define `userData.onFrame(dt, elapsed)` (see util/frameTick.ts) to be
 *    animated once per rendered frame.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CameraShot } from '../state/params';
import type { TunnelDomain } from '../physics/domain';
import { tunnelDomain } from '../physics/domain';
import { CameraTween, DEFAULT_TWEEN_SECONDS } from './util/cameraTween';
import { FpsMeter } from './util/fpsMeter';
import { getFrameTick } from './util/frameTick';
import { disposeObject3D } from './util/disposal';
import { computeShot, extentsFromDomain } from './util/shots';
import type { SceneExtents } from './util/shots';

// The whole app uses the physics frame as the world frame: Z is up. Must happen before any
// Object3D (camera included) is constructed so their `up` vectors pick it up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type FrameCallback = (dtSeconds: number, elapsedSeconds: number) => void;

export interface SceneManagerApi {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Physics-meter space. Scaled so the tunnel domain maps to a fixed display size. */
  readonly modelRoot: THREE.Group;
  /** Rescale modelRoot for a new tunnel domain and keep the camera framing sensible. */
  setDomain(domain: TunnelDomain): void;
  /** Smoothly fly the camera to a named shot (framed on the current domain). */
  flyTo(shot: CameraShot): void;
  /** Register a per-frame callback; returns an unsubscribe function. */
  onFrame(cb: FrameCallback): () => void;
  /** Average frames per second over the last second (for adaptive quality). */
  readonly fps: number;
  dispose(): void;
}

/** Longest frame step handed to animation code (a background tab must not cause a huge jump). */
const MAX_DT = 0.1;
const CAMERA_FOV_DEG = 40;

/** A deep navy -> charcoal vertical gradient; the flow lines pop against it. */
function createBackgroundTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#0b1730');
  g.addColorStop(0.55, '#0a1020');
  g.addColorStop(1, '#07090f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export class SceneManager implements SceneManagerApi {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly modelRoot = new THREE.Group();
  readonly controls: OrbitControls;
  readonly labelRenderer: CSS2DRenderer;

  private readonly container: HTMLElement;
  private readonly fpsMeter = new FpsMeter(60);
  private readonly tween = new CameraTween();
  private readonly resizeObserver: ResizeObserver | null;
  private readonly background: THREE.CanvasTexture | null;
  private readonly envTarget: THREE.WebGLRenderTarget;
  private readonly keyLight: THREE.DirectionalLight;

  private frameCallbacks: FrameCallback[] = [];
  private extents: SceneExtents;
  private currentShot: CameraShot = 'overview';
  /** True once the user orbited/zoomed since the last programmatic camera move. */
  private userMoved = false;
  private hasPlacedCamera = false;
  private disposed = false;
  private lastTime = 0;
  private elapsed = 0;
  private lastCallbackError = '';
  private readonly tickVisitor: (obj: THREE.Object3D) => void;
  private visitDt = 0;
  private readonly onControlStart: () => void;

  constructor(container: HTMLElement) {
    this.container = container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    // Renderer.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    // Label overlay (CSS2D), never intercepts the pointer.
    this.labelRenderer = new CSS2DRenderer();
    const overlay = this.labelRenderer.domElement;
    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.pointerEvents = 'none';
    container.appendChild(overlay);

    // Camera (Z-up).
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.05, 400);
    this.camera.up.set(0, 0, 1);

    // Background and lighting.
    this.background = createBackgroundTexture();
    if (this.background) this.scene.background = this.background;
    else this.scene.background = new THREE.Color(0x0a1020);

    this.scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x141a28, 0.55));
    this.keyLight = new THREE.DirectionalLight(0xfff1de, 2.4);
    this.keyLight.position.set(-6, -9, 11);
    this.scene.add(this.keyLight);
    const rim = new THREE.DirectionalLight(0x7fa8ff, 0.6);
    rim.position.set(9, 7, 4);
    this.scene.add(rim);

    // Soft studio reflections so the metallic wing has something to reflect. RoomEnvironment is
    // authored Y-up; rotate it so its "ceiling" is our +Z.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.6;
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);

    this.scene.add(this.modelRoot);

    // Controls.
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.75;
    this.controls.zoomSpeed = 0.85;
    this.controls.screenSpacePanning = true;
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = Math.PI - 0.02;
    this.onControlStart = () => {
      this.tween.cancel();
      this.userMoved = true;
    };
    this.controls.addEventListener('start', this.onControlStart);

    // Domain defaults to a plain teaching wing until the app calls setDomain().
    this.extents = extentsFromDomain(tunnelDomain(10, 1.5));
    this.applyExtents();

    // Resize handling.
    this.resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(container);
    this.resize();

    // Per-frame animation visitor, allocated once.
    this.tickVisitor = (obj) => {
      const fn = getFrameTick(obj);
      if (fn) fn(this.visitDt, this.elapsed);
    };

    this.placeCamera(false);
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(this.tick);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Public API                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  get fps(): number {
    return this.fpsMeter.fps;
  }

  setDomain(domain: TunnelDomain): void {
    this.extents = extentsFromDomain(domain);
    this.applyExtents();
    // Re-frame the current shot unless the user has taken over the camera.
    if (!this.userMoved) this.placeCamera(this.hasPlacedCamera);
  }

  flyTo(shot: CameraShot): void {
    this.currentShot = shot;
    this.userMoved = false;
    this.placeCamera(true);
  }

  onFrame(cb: FrameCallback): () => void {
    this.frameCallbacks = [...this.frameCallbacks, cb];
    return () => {
      // Replace rather than mutate so an in-flight frame loop keeps iterating a stable array.
      this.frameCallbacks = this.frameCallbacks.filter((f) => f !== cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.controls.removeEventListener('start', this.onControlStart);
    this.controls.dispose();
    this.frameCallbacks = [];
    // modelRoot's children belong to their own classes (the app disposes those).
    this.scene.remove(this.modelRoot);
    disposeObject3D(this.scene);
    this.envTarget.dispose();
    this.background?.dispose();
    this.scene.environment = null;
    this.scene.background = null;
    this.labelRenderer.domElement.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  /** Scale and centre `modelRoot` so the domain length maps to the fixed display length. */
  private applyExtents(): void {
    const { scale, centerPhysics, size } = this.extents;
    this.modelRoot.scale.setScalar(scale);
    this.modelRoot.position.set(
      -centerPhysics[0] * scale,
      -centerPhysics[1] * scale,
      -centerPhysics[2] * scale,
    );
    const diag = Math.hypot(size[0], size[1], size[2]);
    this.controls.minDistance = Math.max(0.3, 0.02 * diag);
    this.controls.maxDistance = 4 * diag;
  }

  /** Move the camera to the current shot, with a tween when `animate` and motion is allowed. */
  private placeCamera(animate: boolean): void {
    const pose = computeShot(this.currentShot, this.extents, this.camera.fov, this.camera.aspect);
    const toPos = new THREE.Vector3(...pose.position);
    const toTarget = new THREE.Vector3(...pose.target);
    if (animate && !prefersReducedMotion() && this.hasPlacedCamera) {
      this.tween.start(
        this.camera.position,
        this.controls.target,
        toPos,
        toTarget,
        DEFAULT_TWEEN_SECONDS,
      );
    } else {
      this.tween.cancel();
      this.camera.position.copy(toPos);
      this.controls.target.copy(toTarget);
      this.camera.lookAt(toTarget);
      this.controls.update();
    }
    this.hasPlacedCamera = true;
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < 2 || h < 2) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    const changed = Math.abs(this.camera.aspect - w / h) > 1e-6;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // The very first real size arrives after construction: re-frame so shots fit the aspect.
    if (changed && !this.userMoved && !this.tween.isActive) {
      const pose = computeShot(this.currentShot, this.extents, this.camera.fov, this.camera.aspect);
      this.camera.position.set(...pose.position);
      this.controls.target.set(...pose.target);
    }
  }

  private readonly tick = (): void => {
    const now = performance.now();
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (typeof document !== 'undefined' && document.hidden) return; // skip rendering in the background
    this.fpsMeter.tick(rawDt);
    const dt = Math.min(Math.max(rawDt, 0), MAX_DT);
    this.elapsed += dt;

    // The tween writes camera position and target; controls.update() re-derives the orientation.
    this.tween.update(dt, this.camera.position, this.controls.target);
    this.controls.update();

    const callbacks = this.frameCallbacks;
    for (let i = 0; i < callbacks.length; i++) {
      try {
        callbacks[i]!(dt, this.elapsed);
      } catch (err) {
        this.reportCallbackError(err);
      }
    }

    this.visitDt = dt;
    try {
      this.scene.traverseVisible(this.tickVisitor);
    } catch (err) {
      this.reportCallbackError(err);
    }

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  /** Log a failing per-frame callback once per distinct message (not 60 times a second). */
  private reportCallbackError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === this.lastCallbackError) return;
    this.lastCallbackError = msg;
    console.error('SceneManager frame callback failed:', err);
  }
}
