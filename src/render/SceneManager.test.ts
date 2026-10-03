// @vitest-environment happy-dom
/**
 * SceneManager needs WebGL, which is unavailable here, so the renderer and PMREM generator are
 * replaced by small fakes. Everything else (camera, controls, tween, lights, label overlay,
 * frame loop, domain scaling) is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { tunnelDomain } from '../physics/domain';
import { computeShot, extentsFromDomain } from './util/shots';
import { setFrameTick } from './util/frameTick';

interface FakeRendererApi {
  loop: ((t: number) => void) | null;
  renders: number;
  disposed: boolean;
  contextLost: boolean;
  sizes: Array<[number, number]>;
}

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof THREE>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    toneMapping = 0;
    toneMappingExposure = 1;
    clippingPlanes: unknown[] = [];
    localClippingEnabled = false;
    outputColorSpace = '';
    loop: ((t: number) => void) | null = null;
    renders = 0;
    disposed = false;
    contextLost = false;
    sizes: Array<[number, number]> = [];
    setPixelRatio() {}
    setSize(w: number, h: number) {
      this.sizes.push([w, h]);
    }
    render() {
      this.renders++;
    }
    setAnimationLoop(cb: ((t: number) => void) | null) {
      this.loop = cb;
    }
    dispose() {
      this.disposed = true;
    }
    forceContextLoss() {
      this.contextLost = true;
    }
  }
  class FakePMREM {
    fromScene() {
      const target = {
        texture: new actual.Texture(),
        disposed: false,
        dispose() {
          target.disposed = true;
        },
      };
      return target;
    }
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer, PMREMGenerator: FakePMREM };
});

// Imported after the mock is registered (vi.mock is hoisted above imports).
import { SceneManager } from './SceneManager';

let now = 0;
function fakeRenderer(sm: SceneManager): FakeRendererApi {
  return sm.renderer as unknown as FakeRendererApi;
}
/** Advance the fake clock by `ms` and run one animation frame. */
function frame(sm: SceneManager, ms: number): void {
  now += ms;
  fakeRenderer(sm).loop!(now);
}

function makeContainer(w = 800, h = 500): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  document.body.appendChild(el);
  return el;
}

describe('SceneManager', () => {
  let container: HTMLElement;
  let sm: SceneManager;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    container = makeContainer();
    sm = new SceneManager(container);
  });

  afterEach(() => {
    sm.dispose();
    container.remove();
    vi.restoreAllMocks();
  });

  it('uses a Z-up world and mounts canvas and label overlay in the container', () => {
    expect(THREE.Object3D.DEFAULT_UP.toArray()).toEqual([0, 0, 1]);
    expect(sm.camera.up.toArray()).toEqual([0, 0, 1]);
    expect(sm.scene.children).toContain(sm.modelRoot);
    expect(container.contains(sm.renderer.domElement)).toBe(true);
    expect(container.contains(sm.labelRenderer.domElement)).toBe(true);
    expect(sm.labelRenderer.domElement.style.pointerEvents).toBe('none');
    expect(fakeRenderer(sm).sizes.at(-1)).toEqual([800, 500]);
    expect(sm.camera.aspect).toBeCloseTo(1.6, 9);
  });

  it('scales modelRoot so the domain is 12 display units long and centred on the origin', () => {
    const domain = tunnelDomain(64, 8);
    sm.setDomain(domain);
    const lx = domain.max[0] - domain.min[0];
    expect(sm.modelRoot.scale.x).toBeCloseTo(12 / lx, 12);
    expect(sm.modelRoot.scale.y).toBeCloseTo(12 / lx, 12);
    expect(sm.modelRoot.scale.z).toBeCloseTo(12 / lx, 12);
    sm.modelRoot.updateMatrixWorld(true);
    const centre = new THREE.Vector3(
      0.5 * (domain.min[0] + domain.max[0]),
      0.5 * (domain.min[1] + domain.max[1]),
      0.5 * (domain.min[2] + domain.max[2]),
    );
    sm.modelRoot.localToWorld(centre);
    expect(centre.length()).toBeLessThan(1e-9);
    const front = new THREE.Vector3(domain.min[0], 0, 0);
    const back = new THREE.Vector3(domain.max[0], 0, 0);
    sm.modelRoot.localToWorld(front);
    sm.modelRoot.localToWorld(back);
    expect(back.x - front.x).toBeCloseTo(12, 9);
  });

  it('renders each frame, passes a clamped dt to callbacks and supports unsubscribe', () => {
    const calls: Array<[number, number]> = [];
    const off = sm.onFrame((dt, t) => calls.push([dt, t]));
    frame(sm, 16);
    frame(sm, 5000); // a long stall (background tab) must not explode animations
    expect(fakeRenderer(sm).renders).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBeCloseTo(0.016, 6);
    expect(calls[1]![0]).toBe(0.1);
    expect(calls[1]![1]).toBeCloseTo(0.116, 6);
    off();
    frame(sm, 16);
    expect(calls).toHaveLength(2);
  });

  it('survives a throwing callback and keeps rendering', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ok = 0;
    sm.onFrame(() => {
      throw new Error('boom');
    });
    sm.onFrame(() => ok++);
    frame(sm, 16);
    frame(sm, 16);
    expect(ok).toBe(2);
    expect(err).toHaveBeenCalledTimes(1); // reported once, not every frame
    expect(fakeRenderer(sm).renders).toBe(2);
  });

  it('skips rendering while the page is hidden', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    try {
      const cb = vi.fn();
      sm.onFrame(cb);
      frame(sm, 16);
      expect(fakeRenderer(sm).renders).toBe(0);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    }
    frame(sm, 16);
    expect(fakeRenderer(sm).renders).toBe(1);
  });

  it('measures fps from frame times', () => {
    for (let i = 0; i < 200; i++) frame(sm, 1000 / 50);
    expect(sm.fps).toBeCloseTo(50, 0);
  });

  it('calls the userData.onFrame hook of visible objects only', () => {
    const shown = new THREE.Group();
    const hidden = new THREE.Group();
    const a = vi.fn();
    const b = vi.fn();
    setFrameTick(shown, a);
    setFrameTick(hidden, b);
    hidden.visible = false;
    sm.modelRoot.add(shown, hidden);
    frame(sm, 16);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]![0]).toBeCloseTo(0.016, 6);
    expect(b).not.toHaveBeenCalled();
  });

  it('flyTo eases the camera to the shot over about 0.9 s and lands exactly on it', () => {
    sm.setDomain(tunnelDomain(30, 3));
    for (let i = 0; i < 80; i++) frame(sm, 16); // finish the re-framing tween
    sm.flyTo('side');
    frame(sm, 16);
    const early = sm.camera.position.clone();
    for (let i = 0; i < 60; i++) frame(sm, 16);
    const ext = extentsFromDomain(tunnelDomain(30, 3));
    const pose = computeShot('side', ext, sm.camera.fov, sm.camera.aspect);
    expect(sm.camera.position.x).toBeCloseTo(pose.position[0], 3);
    expect(sm.camera.position.y).toBeCloseTo(pose.position[1], 3);
    expect(sm.camera.position.z).toBeCloseTo(pose.position[2], 3);
    // OrbitControls re-normalises the target (clampLength), which can cost an ulp.
    sm.controls.target.toArray().forEach((v, i) => expect(v).toBeCloseTo(pose.target[i]!, 9));
    expect(early.distanceTo(sm.camera.position)).toBeGreaterThan(1);
    // Side view: the camera looks along +y with +x to the screen's right.
    const dir = new THREE.Vector3();
    sm.camera.getWorldDirection(dir);
    expect(dir.y).toBeGreaterThan(0.99);
  });

  it('jumps instead of tweening when the user prefers reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: q.includes('reduced-motion'), media: q }) as MediaQueryList,
    );
    sm.setDomain(tunnelDomain(30, 3));
    sm.flyTo('top');
    const ext = extentsFromDomain(tunnelDomain(30, 3));
    const pose = computeShot('top', ext, sm.camera.fov, sm.camera.aspect);
    expect(sm.camera.position.z).toBeCloseTo(pose.position[2], 6);
    expect(sm.controls.target.toArray()).toEqual(pose.target);
  });

  it('re-frames the current shot on a new domain until the user takes over the camera', () => {
    sm.setDomain(tunnelDomain(30, 3));
    sm.flyTo('section');
    for (let i = 0; i < 80; i++) frame(sm, 16);
    const before = sm.camera.position.clone();
    // A stubby wing: the span is a much smaller share of the (chord-sized) tunnel.
    sm.setDomain(tunnelDomain(10, 4));
    for (let i = 0; i < 80; i++) frame(sm, 16);
    const reframed = sm.camera.position.clone();
    const pose = computeShot(
      'section',
      extentsFromDomain(tunnelDomain(10, 4)),
      sm.camera.fov,
      sm.camera.aspect,
    );
    expect(reframed.x).toBeCloseTo(pose.position[0], 3);
    expect(reframed.y).toBeCloseTo(pose.position[1], 3);
    expect(reframed.distanceTo(before)).toBeGreaterThan(0.01);

    // The user orbits: later domain changes must not yank the camera.
    sm.controls.dispatchEvent({ type: 'start' } as never);
    const held = sm.camera.position.clone();
    sm.setDomain(tunnelDomain(60, 3));
    for (let i = 0; i < 80; i++) frame(sm, 16);
    expect(sm.camera.position.distanceTo(held)).toBeLessThan(1e-6);
  });

  it('setFocus moves the wing-centred shots to the given pivot and span', () => {
    const domain = tunnelDomain(40, 4);
    sm.setDomain(domain);
    sm.flyTo('tip');
    for (let i = 0; i < 80; i++) frame(sm, 16);
    const defaultPose = sm.camera.position.clone();
    sm.setFocus([1, 0, 0], 16); // a shorter semispan than the 20 m the domain implies
    for (let i = 0; i < 80; i++) frame(sm, 16);
    const ext = extentsFromDomain(domain, [1, 0, 0], undefined, 16);
    const pose = computeShot('tip', ext, sm.camera.fov, sm.camera.aspect);
    expect(sm.camera.position.x).toBeCloseTo(pose.position[0], 3);
    expect(sm.camera.position.y).toBeCloseTo(pose.position[1], 3);
    expect(sm.camera.position.distanceTo(defaultPose)).toBeGreaterThan(0.05);
  });

  it('centres the projection in the region the floating panels leave uncovered', () => {
    sm.setDomain(tunnelDomain(30, 3));
    sm.setViewInsets({ left: 200, right: 100, top: 50 });
    const view = sm.camera.view!;
    expect(view.enabled).toBe(true);
    // Shift the frustum so the optical centre lands mid-gap: (200 - 100) / 2 px left of centre.
    expect(view.offsetX).toBeCloseTo(-50, 6);
    expect(view.offsetY).toBeCloseTo(-25, 6);
    expect(sm.visibleRegion).toEqual({ x: 200, y: 50, width: 500, height: 450 });
    sm.setViewInsets({});
    expect(sm.camera.view?.enabled ?? false).toBe(false);
  });

  it('never lets panels squeeze the visible region below a minimum', () => {
    sm.setViewInsets({ left: 600, right: 600 });
    const r = sm.visibleRegion;
    expect(r.width).toBeGreaterThan(0.3 * 800);
    expect(r.x).toBeCloseTo(0.5 * (800 - r.width), 6);
  });

  it('cuts the scene open for side shots and the wake for the behind shot', () => {
    sm.setDomain(tunnelDomain(30, 3));
    const seen: string[] = [];
    const off = sm.onCutawayChange((k) => seen.push(k));
    sm.flyTo('side');
    for (let i = 0; i < 80; i++) frame(sm, 16);
    expect(sm.cutaway).toBe('span');
    const planes = sm.renderer.clippingPlanes;
    expect(planes).toHaveLength(1);
    expect(planes[0]!.normal.y).toBe(1);
    sm.flyTo('behind');
    for (let i = 0; i < 80; i++) frame(sm, 16);
    expect(sm.cutaway).toBe('cross');
    expect(sm.renderer.clippingPlanes[0]!.normal.x).toBe(-1);
    sm.flyTo('overview');
    for (let i = 0; i < 80; i++) frame(sm, 16);
    expect(sm.cutawayActive).toBe(false);
    expect(sm.renderer.clippingPlanes).toHaveLength(0);
    // While the camera swings between the two shots neither cut applies.
    expect(seen).toEqual(['span', 'none', 'cross', 'none']);
    off();
  });

  it('uses a longer lens for the side shot, eased in with the move', () => {
    sm.setDomain(tunnelDomain(30, 3));
    for (let i = 0; i < 80; i++) frame(sm, 16);
    const wide = sm.camera.fov;
    sm.flyTo('side');
    frame(sm, 16);
    expect(sm.camera.fov).toBeLessThan(wide);
    expect(sm.camera.fov).toBeGreaterThan(26);
    for (let i = 0; i < 80; i++) frame(sm, 16);
    expect(sm.camera.fov).toBe(26);
  });

  it('renders the reflection map again when a lost WebGL context is restored', () => {
    const before = sm.scene.environment;
    expect(before).not.toBeNull();
    const oldTarget = (sm as unknown as { envTarget: { disposed: boolean } }).envTarget;
    sm.renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
    expect(sm.scene.environment).not.toBeNull();
    expect(sm.scene.environment).not.toBe(before);
    expect(oldTarget.disposed).toBe(true);
  });

  it('dispose stops the loop, releases GL and removes its DOM; it is idempotent', () => {
    const r = fakeRenderer(sm);
    sm.dispose();
    expect(r.loop).toBeNull();
    expect(r.disposed).toBe(true);
    expect(r.contextLost).toBe(true);
    expect(container.children).toHaveLength(0);
    expect(() => sm.dispose()).not.toThrow();
  });
});
