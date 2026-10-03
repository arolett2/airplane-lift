/**
 * Lift (up, green), drag (downstream, orange, drawn x5) and optional weight (down, grey) arrows.
 *
 * Lengths follow `0.6 * semispan * F / max(lift, weight)`, so the lift and weight arrows share a
 * scale (equal arrows = level flight). Lift and drag start at the centre of pressure; changes in
 * length are smoothed over a fraction of a second via the per-frame hook (see util/frameTick.ts),
 * and kN labels (CSS2D) ride at the arrow tips.
 */
import * as THREE from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AeroResult, Vec3, WingGeometry } from '../../physics/types';
import { disposeObject3D } from '../util/disposal';
import { setFrameTick } from '../util/frameTick';
import { createLabel, formatKilonewtons, setLabelText } from '../util/labels';
import { smoothingFactor } from '../util/math';
import { DRAG_VISUAL_SCALE, arrowLengths, arrowShape } from './arrowMath';

const SMOOTHING_TAU = 0.14;
/** Below this length (as a fraction of the semispan) an arrow is hidden. */
const HIDE_FRACTION = 2e-3;

interface ArrowSpec {
  name: string;
  color: number;
  cssColor: string;
  /** Unit direction of the arrow in the tunnel frame. */
  dir: Vec3;
  /** Label anchor (CSS2DObject.center): which point of the label sits on the arrow tip. */
  labelCenter: [number, number];
}

// Lift's label sits above its tip, weight's below its tip, and drag's (a short arrow lying on
// the wing) beside its tip so it does not cover the wing root and the lift arrow.
const LIFT: ArrowSpec = {
  name: 'Lift',
  color: 0x3be57f,
  cssColor: '#7dffb0',
  dir: [0, 0, 1],
  labelCenter: [0.5, 1.15],
};
const DRAG: ArrowSpec = {
  name: 'Drag',
  color: 0xff9638,
  cssColor: '#ffbd7a',
  dir: [1, 0, 0],
  labelCenter: [-0.08, -0.25],
};
const WEIGHT: ArrowSpec = {
  name: 'Weight',
  color: 0x9aa4b4,
  cssColor: '#c8d0dc',
  dir: [0, 0, -1],
  labelCenter: [0.5, -0.2],
};

/** One arrow: unit shaft + head meshes scaled per frame, plus a label at the tip. */
class Arrow {
  readonly group = new THREE.Group();
  readonly label: CSS2DObject | null;
  private readonly shaft: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  /** Smoothed and target lengths (meters). */
  current = 0;
  target = 0;

  constructor(
    spec: ArrowSpec,
    shaftGeometry: THREE.BufferGeometry,
    headGeometry: THREE.BufferGeometry,
  ) {
    this.group.name = `${spec.name}Arrow`;
    this.material = new THREE.MeshBasicMaterial({ color: spec.color, toneMapped: false });
    this.shaft = new THREE.Mesh(shaftGeometry, this.material);
    this.head = new THREE.Mesh(headGeometry, this.material);
    this.shaft.frustumCulled = false;
    this.head.frustumCulled = false;
    this.group.add(this.shaft, this.head);
    // Rotate +z onto the arrow direction (explicit axis for the exactly-opposite case).
    const from = new THREE.Vector3(0, 0, 1);
    const to = new THREE.Vector3(spec.dir[0], spec.dir[1], spec.dir[2]);
    if (from.dot(to) < -0.999)
      this.group.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    else this.group.quaternion.setFromUnitVectors(from, to);
    this.label = createLabel(spec.name, { color: spec.cssColor, className: 'al-label--force' });
    if (this.label) {
      this.label.center.set(spec.labelCenter[0], spec.labelCenter[1]);
      this.group.add(this.label);
    }
    this.group.visible = false;
  }

  /** Apply the current length: scale the unit meshes and move the label to the tip. */
  apply(semispan: number): void {
    const hide = this.current < HIDE_FRACTION * semispan;
    this.group.visible = !hide;
    if (hide) return;
    const s = arrowShape(this.current, semispan);
    this.shaft.scale.set(s.shaftRadius, s.shaftRadius, s.shaftLength);
    this.head.position.z = s.shaftLength;
    this.head.scale.set(s.headRadius, s.headRadius, s.headLength);
    this.label?.position.set(0, 0, this.current + 0.05 * semispan);
  }

  dispose(): void {
    this.material.dispose();
    this.label?.removeFromParent();
    this.group.removeFromParent();
  }
}

export class ForceArrows {
  readonly object = new THREE.Group();

  private readonly shaftGeometry: THREE.CylinderGeometry;
  private readonly headGeometry: THREE.ConeGeometry;
  private readonly lift: Arrow;
  private readonly drag: Arrow;
  private readonly weight: Arrow;
  private semispan = 1;
  private wantVisible = true;

  constructor() {
    this.object.name = 'ForceArrows';
    // Unit geometries along +z with the base at z = 0: shaft length 1, head length 1.
    this.shaftGeometry = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false);
    this.shaftGeometry.rotateX(Math.PI / 2);
    this.shaftGeometry.translate(0, 0, 0.5);
    this.headGeometry = new THREE.ConeGeometry(1, 1, 22, 1, false);
    this.headGeometry.rotateX(Math.PI / 2);
    this.headGeometry.translate(0, 0, 0.5);

    this.lift = new Arrow(LIFT, this.shaftGeometry, this.headGeometry);
    this.drag = new Arrow(DRAG, this.shaftGeometry, this.headGeometry);
    this.weight = new Arrow(WEIGHT, this.shaftGeometry, this.headGeometry);
    this.object.add(this.lift.group, this.drag.group, this.weight.group);
    setFrameTick(this.object, (dt) => this.tick(dt));
  }

  /**
   * @param weightN aircraft weight to draw as a downward arrow for comparison, or null.
   * Targets update immediately; the drawn lengths ease toward them in `tick`.
   */
  update(aero: AeroResult | null, geometry: WingGeometry | null, weightN: number | null): void {
    if (!aero || !geometry) {
      this.lift.target = this.drag.target = this.weight.target = 0;
      return;
    }
    this.semispan = Math.max(1e-3, 0.5 * geometry.referenceSpan);
    const w = weightN !== null && weightN > 0 ? weightN : null;
    const len = arrowLengths(this.semispan, aero.lift, aero.drag, w);
    this.lift.target = len.lift;
    this.drag.target = len.drag;
    this.weight.target = len.weight;

    // Origin: the centre of pressure (falls back to the pivot if it is not a usable point).
    const cp = aero.centerOfPressure;
    const origin: Vec3 = cp.every(Number.isFinite) ? cp : geometry.pivot;
    for (const arrow of [this.lift, this.drag, this.weight]) {
      arrow.group.position.set(origin[0], origin[1], origin[2]);
    }
    if (this.lift.label) setLabelText(this.lift.label, `Lift ${formatKilonewtons(aero.lift)}`);
    if (this.drag.label) {
      setLabelText(
        this.drag.label,
        `Drag ${formatKilonewtons(aero.drag)} (arrow ×${DRAG_VISUAL_SCALE})`,
      );
    }
    if (this.weight.label && w !== null) {
      setLabelText(this.weight.label, `Weight ${formatKilonewtons(w)}`);
    }
  }

  /** Ease the drawn lengths toward their targets. Called every frame by SceneManager. */
  tick(dtSeconds: number): void {
    const k = smoothingFactor(dtSeconds, SMOOTHING_TAU);
    for (const arrow of [this.lift, this.drag, this.weight]) {
      const d = arrow.target - arrow.current;
      arrow.current = Math.abs(d) < 1e-6 * this.semispan ? arrow.target : arrow.current + d * k;
      arrow.apply(this.semispan);
    }
  }

  setVisible(on: boolean): void {
    this.wantVisible = on;
    this.object.visible = on;
  }

  get visible(): boolean {
    return this.wantVisible;
  }

  /** Snap the drawn lengths to their targets (no easing). Useful for tests and first layout. */
  snap(): void {
    for (const arrow of [this.lift, this.drag, this.weight]) {
      arrow.current = arrow.target;
      arrow.apply(this.semispan);
    }
  }

  dispose(): void {
    this.lift.dispose();
    this.drag.dispose();
    this.weight.dispose();
    this.shaftGeometry.dispose();
    this.headGeometry.dispose();
    disposeObject3D(this.object);
    setFrameTick(this.object, null);
    this.object.removeFromParent();
  }
}
