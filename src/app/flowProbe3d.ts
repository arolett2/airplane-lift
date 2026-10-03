/**
 * The 3D flow probe: wiring between the pointer / keyboard, the physics worker (which evaluates
 * the exact vortex-lattice flow at the probe point) and the ProbeMarker in the scene.
 *
 *  - The probe moves in a vertical slice of the tunnel (constant y), starting at the 2D
 *    cross-section's station, so the 3D probe and the cross-section tell the same story.
 *  - Drag the marker to move it; click anywhere else in the scene to drop it there (a drag that
 *    starts away from the marker still orbits the camera).
 *  - Keyboard (the 3D view takes focus while probing): arrows move it along the flow and up or
 *    down, Page Up / Page Down toward the tip or the body, Shift for big steps, Escape stops.
 *  - Requests are coalesced: at most one probe is in flight; the latest point wins.
 *
 * The pure helpers at the top are unit-tested; the class only glues them to the DOM and three.js.
 */
import * as THREE from 'three';
import type { TunnelDomain } from '../physics/domain';
import type { AeroResult, Vec3, WingGeometry } from '../physics/types';
import type { ProbeMarker, ProbeReadout, ProbeSlice } from '../render/probe/ProbeMarker';
import type { SceneManager } from '../render/SceneManager';
import { probeText } from '../shared/everydayFormat';
import type { UnitSystem } from '../shared/units';
import type { AppState } from '../state/params';
import type { ResultsState } from '../state/results';
import type { Store } from '../state/store';
import type { FlowProbeSample } from '../worker/protocol';

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Where the probe starts: a little above the right wing's strip nearest the given station. */
export function defaultProbePoint(aero: AeroResult, geometry: WingGeometry, eta: number): Vec3 {
  const semispan = geometry.referenceSpan / 2;
  const y = Math.max(0, Math.min(1, eta)) * semispan;
  let best: AeroResult['strips'][number] | null = null;
  for (const s of aero.strips) {
    if (s.side !== 'right' || s.eta > 1) continue;
    if (!best || Math.abs(s.center[1] - y) < Math.abs(best.center[1] - y)) best = s;
  }
  if (!best) return [geometry.pivot[0], y, geometry.pivot[2] + 0.3 * geometry.meanAeroChord];
  const d = 0.14 * best.chord;
  return [
    best.center[0] + best.normal[0] * d + 0.1 * best.chord,
    best.center[1],
    best.center[2] + best.normal[2] * d,
  ];
}

/** The slice the probe moves in: the tunnel's x / z extent at the probe's y. */
export function probeSlice(domain: TunnelDomain, y: number): ProbeSlice {
  return { y, xMin: domain.min[0], xMax: domain.max[0], zMin: domain.min[2], zMax: domain.max[2] };
}

/** Keep a point inside the tunnel. */
export function clampToDomain(p: Vec3, domain: TunnelDomain): Vec3 {
  return [0, 1, 2].map((i) => Math.min(domain.max[i]!, Math.max(domain.min[i]!, p[i]!))) as Vec3;
}

/**
 * The probe point after a key press, or null if the key does nothing. `step` is the small step
 * (m); Shift multiplies it by ten. Left / Right move against / with the flow, Up / Down move up
 * and down, Page Up / Page Down move toward the right tip / the body.
 */
export function nudgeProbe(
  p: Vec3,
  key: string,
  shift: boolean,
  step: number,
  domain: TunnelDomain,
): Vec3 | null {
  const d = step * (shift ? 10 : 1);
  const moves: Record<string, Vec3> = {
    ArrowLeft: [-d, 0, 0],
    ArrowRight: [d, 0, 0],
    ArrowUp: [0, 0, d],
    ArrowDown: [0, 0, -d],
    PageUp: [0, d, 0],
    PageDown: [0, -d, 0],
  };
  const m = moves[key];
  if (!m) return null;
  return clampToDomain([p[0] + m[0], p[1] + m[1], p[2] + m[2]], domain);
}

/** Flow angles relative to the wind: up (rad, + up) and sideways (rad, + toward the near tip). */
export function flowAngles(v: Vec3, y: number): { up: number; side: number } {
  const along = Math.max(1e-9, Math.abs(v[0])) * Math.sign(v[0] || 1);
  const outward = y >= 0 ? v[1] : -v[1];
  return { up: Math.atan2(v[2], along), side: Math.atan2(outward, along) };
}

/** The marker's readout card and a sentence for screen readers. */
export function probeReadout(
  sample: FlowProbeSample,
  system: UnitSystem,
): { readout: ProbeReadout; summary: string } {
  const angles = sample.inside
    ? { up: NaN, side: NaN }
    : flowAngles(sample.velocity, sample.point[1]);
  const text = probeText(
    {
      inside: sample.inside,
      speedRatio: sample.speedRatio,
      vInf: sample.vInf,
      deltaPressure: sample.deltaPressure,
      pressureFraction: sample.pressureFraction,
      angleUp: angles.up,
      angleSide: angles.side,
    },
    system,
  );
  if (sample.inside) {
    return {
      readout: { title: 'Probe', lines: [text.speed, text.speedCompare], tone: 'inside' },
      summary: text.summary,
    };
  }
  const f = sample.pressureFraction;
  return {
    readout: {
      title: 'Probe',
      lines: [
        `${text.speed} · ${text.speedCompare}`,
        `Pressure ${text.pressure} (${text.pressureValue})`,
        `Heading ${text.direction}`,
      ],
      tone: Math.abs(f) < 5e-5 ? 'none' : f < 0 ? 'low' : 'high',
    },
    summary: text.summary,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Controller                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** Screen distance (CSS px) within which a press grabs the marker. */
const GRAB_PX = 26;
/** A press that moves less than this (CSS px) is a click, which drops the probe there. */
const CLICK_PX = 5;

export interface FlowProbeDeps {
  scene: SceneManager;
  marker: ProbeMarker;
  store: Store<AppState>;
  results: Store<ResultsState>;
  probe(point: Vec3): Promise<FlowProbeSample | null>;
  domainOf(geometry: WingGeometry): TunnelDomain;
  /** Called when the probe switches on or off (e.g. to sync a toolbar button). */
  onActiveChange?(on: boolean): void;
}

export class FlowProbe3D {
  private active = false;
  private point: Vec3 | null = null;
  private inFlight = false;
  private queued = false;
  private dragging: number | null = null;
  private down: { x: number; y: number; id: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly live: HTMLElement;
  private readonly unsubscribe: (() => void)[] = [];
  private lastSample: FlowProbeSample | null = null;

  constructor(private readonly deps: FlowProbeDeps) {
    const container = this.container;
    this.live = container.ownerDocument.createElement('div');
    this.live.className = 'sr-only';
    this.live.setAttribute('aria-live', 'polite');
    container.append(this.live);
    container.addEventListener('pointerdown', this.onPointerDown, true);
    container.addEventListener('pointermove', this.onPointerMove, true);
    container.addEventListener('pointerup', this.onPointerUp, true);
    container.addEventListener('pointercancel', this.onPointerUp, true);
    this.canvas.addEventListener('keydown', this.onKey);
    this.unsubscribe.push(
      deps.results.select(
        (r) => r.aero,
        () => this.onWingChanged(),
      ),
      deps.store.select(
        (s) => s.view.units,
        () => this.render(),
      ),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    const canvas = this.canvas;
    if (on) {
      canvas.tabIndex = 0;
      canvas.setAttribute(
        'aria-label',
        '3D wind tunnel with a flow probe. Arrow keys move the probe along the flow and up or down, Page Up and Page Down toward the tip or the body, Shift for bigger steps, Escape to stop.',
      );
      if (!this.point) this.point = this.initialPoint();
      canvas.focus({ preventScroll: true });
    } else {
      canvas.removeAttribute('tabindex');
      canvas.removeAttribute('aria-label');
      this.endDrag();
      this.live.textContent = '';
    }
    this.deps.marker.setVisible(on && this.point !== null);
    this.syncMarker();
    if (on) this.request();
    this.deps.onActiveChange?.(on);
  }

  dispose(): void {
    const container = this.container;
    container.removeEventListener('pointerdown', this.onPointerDown, true);
    container.removeEventListener('pointermove', this.onPointerMove, true);
    container.removeEventListener('pointerup', this.onPointerUp, true);
    container.removeEventListener('pointercancel', this.onPointerUp, true);
    this.canvas.removeEventListener('keydown', this.onKey);
    for (const off of this.unsubscribe) off();
    this.live.remove();
  }

  /* -------------------------------------------------------------------------------------- */

  private get canvas(): HTMLCanvasElement {
    return this.deps.scene.renderer.domElement;
  }

  private get container(): HTMLElement {
    return this.canvas.parentElement ?? this.canvas;
  }

  private domain(): TunnelDomain | null {
    const g = this.deps.results.get().geometry;
    return g ? this.deps.domainOf(g) : null;
  }

  private initialPoint(): Vec3 | null {
    const { aero, geometry } = this.deps.results.get();
    if (!aero || !geometry) return null;
    return defaultProbePoint(aero, geometry, this.deps.store.get().view.sectionEta);
  }

  private onWingChanged(): void {
    if (!this.active) return;
    const domain = this.domain();
    if (!this.point) this.point = this.initialPoint();
    else if (domain) {
      // A new aircraft: keep the probe if it is still in the tunnel, else start over.
      const c = clampToDomain(this.point, domain);
      if (c.some((v, i) => Math.abs(v - this.point![i]!) > 1e-9)) this.point = this.initialPoint();
    }
    this.deps.marker.setVisible(this.point !== null);
    this.syncMarker();
    this.request();
  }

  private moveTo(p: Vec3): void {
    const domain = this.domain();
    this.point = domain ? clampToDomain(p, domain) : p;
    this.deps.marker.setVisible(true);
    this.syncMarker();
    this.request();
  }

  private syncMarker(): void {
    const { marker } = this.deps;
    const g = this.deps.results.get().geometry;
    const domain = this.domain();
    if (!this.point || !g || !domain) return;
    const size = 0.012 * g.overallSpan;
    marker.setSize(size);
    marker.setPoint(this.point);
    marker.setSlice(probeSlice(domain, this.point[1]));
  }

  /** Ask the worker for the flow at the probe; coalesces while a request is in flight. */
  private request(): void {
    if (!this.active || !this.point) return;
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    this.queued = false;
    const asked = this.point;
    this.deps
      .probe(asked)
      .then((sample) => {
        if (sample && this.active) {
          this.lastSample = sample;
          this.render();
        }
      })
      .catch((err: unknown) => console.warn('flow probe:', err))
      .finally(() => {
        this.inFlight = false;
        if (this.queued) this.request();
      });
  }

  private render(): void {
    const sample = this.lastSample;
    if (!this.active || !sample) return;
    const g = this.deps.results.get().geometry;
    const { readout, summary } = probeReadout(sample, this.deps.store.get().view.units);
    this.deps.marker.setReadout(readout);
    this.deps.marker.setFlow(
      sample.inside ? null : sample.velocity,
      sample.vInf,
      g ? 0.08 * g.overallSpan : 1,
    );
    // Announce only keyboard-driven changes and the first reading, not every drag step.
    if (this.dragging === null) this.live.textContent = summary;
  }

  /* -------------------------------------------------------------------------------------- */
  /* Pointer and keyboard                                                                     */
  /* -------------------------------------------------------------------------------------- */

  private ndc(e: PointerEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
  }

  /** Screen position (CSS px, canvas-relative) of the marker, or null. */
  private markerScreen(): THREE.Vector2 | null {
    if (!this.point) return null;
    const { scene } = this.deps;
    const v = new THREE.Vector3(...this.point).applyMatrix4(scene.modelRoot.matrixWorld);
    v.project(scene.camera);
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height);
  }

  /**
   * The tunnel-frame point under the pointer on the probe's slice (y = const). When the camera
   * looks along the slice, a plane facing the camera through the probe is used instead.
   */
  private pick(e: PointerEvent): Vec3 | null {
    const { scene } = this.deps;
    const root = scene.modelRoot;
    root.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc(e), scene.camera);
    const y = this.point ? this.point[1] : 0;
    const local = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const world = local.clone().applyMatrix4(root.matrixWorld);
    let plane = world;
    if (Math.abs(this.raycaster.ray.direction.dot(world.normal)) < 0.2 && this.point) {
      const through = new THREE.Vector3(...this.point).applyMatrix4(root.matrixWorld);
      const facing = scene.camera.getWorldDirection(new THREE.Vector3()).negate();
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, through);
    }
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    root.worldToLocal(hit);
    return [hit.x, plane === world ? y : hit.y, hit.z];
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.active || e.button !== 0) return;
    if (e.target !== this.canvas) return; // panels, labels and buttons keep their clicks
    const at = this.markerScreen();
    const rect = this.canvas.getBoundingClientRect();
    const near =
      at !== null &&
      Math.hypot(e.clientX - rect.left - at.x, e.clientY - rect.top - at.y) < GRAB_PX;
    if (near) {
      // Grab the marker: the camera must not orbit meanwhile.
      e.stopPropagation();
      e.preventDefault();
      this.dragging = e.pointerId;
      this.deps.scene.controls.enabled = false;
      try {
        this.container.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported */
      }
      this.canvas.focus({ preventScroll: true });
    } else {
      this.down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.dragging === null || e.pointerId !== this.dragging) return;
    e.stopPropagation();
    const p = this.pick(e);
    if (p) this.moveTo(p);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.dragging !== null && e.pointerId === this.dragging) {
      e.stopPropagation();
      this.endDrag();
      this.render();
      return;
    }
    const down = this.down;
    this.down = null;
    if (!this.active || !down || down.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) return; // an orbit
    const p = this.pick(e);
    if (p) this.moveTo(p);
  };

  private endDrag(): void {
    if (this.dragging !== null) {
      try {
        this.container.releasePointerCapture(this.dragging);
      } catch {
        /* already released */
      }
    }
    this.dragging = null;
    this.deps.scene.controls.enabled = true;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.setActive(false);
      return;
    }
    const domain = this.domain();
    const g = this.deps.results.get().geometry;
    if (!this.point || !domain || !g) return;
    const next = nudgeProbe(this.point, e.key, e.shiftKey, 0.04 * g.meanAeroChord, domain);
    if (!next) return;
    e.preventDefault();
    this.moveTo(next);
  };
}
