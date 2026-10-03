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
import type { Vec3 } from '../physics/types';
import { CameraTween, DEFAULT_TWEEN_SECONDS } from './util/cameraTween';
import { FpsMeter } from './util/fpsMeter';
import { getFrameTick } from './util/frameTick';
import { disposeObject3D } from './util/disposal';
import { crossCutX } from './util/framing';
import type { WingFraming } from './util/framing';
import { computeShot, extentsFromDomain } from './util/shots';
import type { CameraPose, SceneExtents } from './util/shots';

// The whole app uses the physics frame as the world frame: Z is up. Must happen before any
// Object3D (camera included) is constructed so their `up` vectors pick it up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type FrameCallback = (dtSeconds: number, elapsedSeconds: number) => void;

/** CSS pixels of the canvas covered by floating UI on each side (see setViewInsets). */
export interface ViewInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const NO_INSETS: ViewInsets = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * Cutaways (renderer clipping planes) that open the scene up for particular shots:
 *  - 'span'  (side, section): everything between the camera and the smoke-rake station is cut
 *    away, so the airfoil section and the smoke bending round it are seen unobstructed (the
 *    wing's inside reads as the cut face).
 *  - 'cross' (behind, tip): the wake is cut across the flow a little behind the wing, so the
 *    smoke ends on a plane facing the camera, like a laser light sheet across a real tunnel,
 *    instead of fanning out toward the camera in perspective.
 * A cutaway stays on while the view direction is within ~45 degrees of the shot's.
 */
export type CutawayKind = 'none' | 'span' | 'cross';
const CUTAWAY_FOR_SHOT: Partial<Record<CameraShot, Exclude<CutawayKind, 'none'>>> = {
  side: 'span',
  section: 'span',
  behind: 'cross',
  tip: 'cross',
};
const CUTAWAY_MIN_ALIGNMENT = 0.7;
/** The cut sits this many station chords in front of the station (toward the camera). */
const CUTAWAY_OFFSET_CHORDS = 0.45;
/**
 * Depth of wing kept behind the station, in station chords: the wing is shown as a slab, like a
 * 2D wind-tunnel model, instead of a long receding wing that converges in perspective.
 */
const CUTAWAY_DEPTH_CHORDS: Partial<Record<CameraShot, number>> = { side: 3.5, section: 1.6 };
/** The visible region never shrinks below this fraction of the canvas on either axis. */
const MIN_VISIBLE_FRACTION = 0.35;

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
/**
 * Side-on and end-on shots use a longer lens: the camera backs off, so the receding wing (side)
 * or wake (behind, tip) no longer fans out in perspective and the flow reads like a diagram.
 */
const SHOT_FOV_DEG: Partial<Record<CameraShot, number>> = {
  side: 26,
  section: 26,
  behind: 22,
  tip: 24,
};

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
  private envTarget: THREE.WebGLRenderTarget;
  private readonly keyLight: THREE.DirectionalLight;

  private frameCallbacks: FrameCallback[] = [];
  private cutawayListeners: Array<(kind: CutawayKind) => void> = [];
  private readonly cutPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly cutPlanes = [this.cutPlane];
  /**
   * Far side of the cutaway slab (keeps y <= station + depth). Not applied globally: the app
   * gives it to the wing material only, so the tunnel and smoke behind stay whole.
   */
  readonly cutawayFarPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private readonly scratchDir = new THREE.Vector3();
  private cutKind: CutawayKind = 'none';
  private extents: SceneExtents;
  private domain: TunnelDomain = tunnelDomain(10, 1.5);
  private focus: { pivot: Vec3; semispan: number; framing?: WingFraming } | null = null;
  private insets: ViewInsets = NO_INSETS;
  private currentShot: CameraShot = 'overview';
  /** True once the user orbited/zoomed since the last programmatic camera move. */
  private userMoved = false;
  private hasPlacedCamera = false;
  private disposed = false;
  private lastTime = 0;
  private elapsed = 0;
  private lastCallbackError = '';
  /** Field of view the current shot wants (deg) and how fast to ease toward it (deg/s). */
  private targetFov = CAMERA_FOV_DEG;
  private fovRate = 0;
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
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Per-material clipping (the wing's side-view slab) needs local clipping.
    this.renderer.localClippingEnabled = true;
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
    this.envTarget = this.renderEnvironment();
    this.scene.environment = this.envTarget.texture;
    // A restored WebGL context comes back without render-target contents (three.js re-uploads
    // only textures that keep their image), so the reflections must be rendered again.
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
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
    this.extents = extentsFromDomain(this.domain);
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
    this.domain = domain;
    this.refreshExtents();
  }

  /**
   * Optional: tell the camera shots where the wing is. Without it the pivot is assumed to be the
   * physics origin and the semispan is inferred from the domain width (tunnelDomain() makes the
   * width 1.5 x the span). Both are physics meters.
   */
  setFocus(pivot: Vec3, semispan: number, framing?: WingFraming): void {
    this.focus = { pivot: [pivot[0], pivot[1], pivot[2]], semispan, framing };
    this.refreshExtents();
  }

  /**
   * Tell the camera how much of the canvas floating panels cover (CSS px). The projection centre
   * moves to the middle of the uncovered region and shots are framed to fit inside it, so the
   * wing is never hidden behind a panel. Re-frames the current shot unless the user took over.
   */
  setViewInsets(insets: Partial<ViewInsets>): void {
    const next: ViewInsets = {
      left: Math.max(0, insets.left ?? 0),
      right: Math.max(0, insets.right ?? 0),
      top: Math.max(0, insets.top ?? 0),
      bottom: Math.max(0, insets.bottom ?? 0),
    };
    const prev = this.insets;
    if (
      Math.abs(prev.left - next.left) < 0.5 &&
      Math.abs(prev.right - next.right) < 0.5 &&
      Math.abs(prev.top - next.top) < 0.5 &&
      Math.abs(prev.bottom - next.bottom) < 0.5
    ) {
      return;
    }
    this.insets = next;
    this.applyViewOffset();
    if (!this.userMoved) this.placeCamera(false);
  }

  /** The visible (uncovered) region of the canvas in CSS px, after clamping the insets. */
  get visibleRegion(): { x: number; y: number; width: number; height: number } {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const { left, right, top, bottom } = this.clampedInsets(w, h);
    return { x: left, y: top, width: w - left - right, height: h - top - bottom };
  }

  flyTo(shot: CameraShot): void {
    this.currentShot = shot;
    this.userMoved = false;
    this.placeCamera(true);
  }

  /** True while a cutaway clips the scene (see CutawayKind). */
  get cutawayActive(): boolean {
    return this.cutKind !== 'none';
  }

  /** Which cutaway is clipping the scene right now. */
  get cutaway(): CutawayKind {
    return this.cutKind;
  }

  /** Called whenever the cutaway changes kind; returns an unsubscribe function. */
  onCutawayChange(cb: (kind: CutawayKind) => void): () => void {
    this.cutawayListeners = [...this.cutawayListeners, cb];
    return () => {
      this.cutawayListeners = this.cutawayListeners.filter((f) => f !== cb);
    };
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
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.controls.removeEventListener('start', this.onControlStart);
    this.controls.dispose();
    this.frameCallbacks = [];
    this.cutawayListeners = [];
    // modelRoot's children belong to their own classes (the app disposes those).
    this.scene.remove(this.modelRoot);
    disposeObject3D(this.scene);
    this.envTarget.dispose();
    this.background?.dispose();
    this.scene.environment = null;
    this.scene.background = null;
    this.labelRenderer.domElement.remove();
    this.renderer.dispose();
    // Release the GL context now rather than waiting for GC (browsers cap live contexts).
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  /** Recompute display extents and re-frame the current shot unless the user took over. */
  private refreshExtents(): void {
    this.extents = extentsFromDomain(
      this.domain,
      this.focus?.pivot ?? [0, 0, 0],
      undefined,
      this.focus?.semispan,
      this.focus?.framing,
    );
    this.applyExtents();
    if (!this.userMoved) this.placeCamera(this.hasPlacedCamera);
  }

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
    this.targetFov = SHOT_FOV_DEG[this.currentShot] ?? CAMERA_FOV_DEG;
    const pose = this.shotPose();
    const toPos = new THREE.Vector3(...pose.position);
    const toTarget = new THREE.Vector3(...pose.target);
    if (animate && !prefersReducedMotion() && this.hasPlacedCamera) {
      // Ease the lens over the same time as the move (it lands exactly when the move does).
      this.fovRate = Math.abs(this.targetFov - this.camera.fov) / DEFAULT_TWEEN_SECONDS;
      this.tween.start(
        this.camera.position,
        this.controls.target,
        toPos,
        toTarget,
        DEFAULT_TWEEN_SECONDS,
      );
    } else {
      this.tween.cancel();
      this.setFov(this.targetFov);
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
    this.applyViewOffset();
    // The very first real size arrives after construction: re-frame so shots fit the aspect.
    if (changed && !this.userMoved && !this.tween.isActive) {
      const pose = this.shotPose();
      this.camera.position.set(...pose.position);
      this.controls.target.set(...pose.target);
    }
  }

  private clampedInsets(w: number, h: number): ViewInsets {
    const { left, right, top, bottom } = this.insets;
    const fit = (a: number, b: number, size: number): [number, number] => {
      const room = (1 - MIN_VISIBLE_FRACTION) * size;
      const k = a + b > room ? room / (a + b) : 1;
      return [a * k, b * k];
    };
    const [l, r] = fit(left, right, w);
    const [t, b] = fit(top, bottom, h);
    return { left: l, right: r, top: t, bottom: b };
  }

  /** Shift the projection centre to the middle of the visible region (no-op without insets). */
  private applyViewOffset(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < 2 || h < 2) {
      this.camera.updateProjectionMatrix();
      return;
    }
    const { left, right, top, bottom } = this.clampedInsets(w, h);
    const ox = -0.5 * (left - right);
    const oy = -0.5 * (top - bottom);
    if (Math.abs(ox) < 0.5 && Math.abs(oy) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, ox, oy, w, h);
    this.camera.updateProjectionMatrix();
  }

  private setFov(fov: number): void {
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** Move the field of view toward the shot's lens at the eased rate. */
  private easeFov(dt: number): void {
    const diff = this.targetFov - this.camera.fov;
    if (diff === 0) return;
    const step = this.fovRate * dt;
    this.setFov(
      Math.abs(diff) <= step || step <= 0
        ? this.targetFov
        : this.camera.fov + Math.sign(diff) * step,
    );
  }

  /** Render the studio environment map used for reflections (PMREM, cube-UV render target). */
  private renderEnvironment(): THREE.WebGLRenderTarget {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    return target;
  }

  private readonly onContextRestored = (): void => {
    if (this.disposed) return;
    const old = this.envTarget;
    this.envTarget = this.renderEnvironment();
    this.scene.environment = this.envTarget.texture;
    old.dispose();
  };

  /** The current shot framed for the visible region (vertical fov and aspect of that region). */
  private shotPose(): CameraPose {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    let fov = this.targetFov;
    let aspect = this.camera.aspect;
    if (w >= 2 && h >= 2) {
      const { left, right, top, bottom } = this.clampedInsets(w, h);
      const visW = w - left - right;
      const visH = h - top - bottom;
      if (visH < h - 0.5) {
        const tanV = Math.tan((fov * Math.PI) / 360) * (visH / h);
        fov = (360 / Math.PI) * Math.atan(tanV);
      }
      aspect = visW / visH;
    }
    return computeShot(this.currentShot, this.extents, fov, aspect);
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
    this.easeFov(dt);
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

    this.updateCutaway();

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  /** Switch the shot's cutaway on while the camera still looks roughly the shot's way. */
  private updateCutaway(): void {
    let kind: CutawayKind = CUTAWAY_FOR_SHOT[this.currentShot] ?? 'none';
    if (kind !== 'none') {
      this.camera.getWorldDirection(this.scratchDir);
      const along = kind === 'span' ? this.scratchDir.y : -this.scratchDir.x;
      if (along <= CUTAWAY_MIN_ALIGNMENT) kind = 'none';
    }
    // World = display units; a plane keeps the points with n.p + c >= 0.
    if (kind === 'span') {
      const st = this.extents.wing.station;
      this.cutPlane.normal.set(0, 1, 0);
      this.cutPlane.constant = -(st.le[1] - CUTAWAY_OFFSET_CHORDS * st.chord);
      const depth = CUTAWAY_DEPTH_CHORDS[this.currentShot] ?? 1e3;
      this.cutawayFarPlane.constant = st.le[1] + depth * st.chord;
    } else if (kind === 'cross') {
      this.cutPlane.normal.set(-1, 0, 0);
      this.cutPlane.constant = crossCutX(this.extents.wing.max[0], this.extents.semispan);
    }
    if (kind === this.cutKind) return;
    this.cutKind = kind;
    this.renderer.clippingPlanes = kind === 'none' ? [] : this.cutPlanes;
    for (const cb of this.cutawayListeners) {
      try {
        cb(kind);
      } catch (err) {
        this.reportCallbackError(err);
      }
    }
  }

  /** Log a failing per-frame callback once per distinct message (not 60 times a second). */
  private reportCallbackError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === this.lastCallbackError) return;
    this.lastCallbackError = msg;
    console.error('SceneManager frame callback failed:', err);
  }
}
