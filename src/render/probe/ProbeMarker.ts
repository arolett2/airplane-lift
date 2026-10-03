/**
 * The 3D flow probe's marker: a small glowing ball where the probe sits, an arrow along the local
 * flow (longer when the air is faster), a faint outline of the slice the probe moves in, and a
 * CSS2D readout card. Lives under SceneManager.modelRoot (tunnel frame, meters).
 *
 * Purely visual: the app decides where the probe is and what the readout says.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Vec3 } from '../../physics/types';
import { disposeObject3D } from '../util/disposal';

/** Lines of the readout card (already worded and formatted by the caller). */
export interface ProbeReadout {
  title: string;
  lines: string[];
  /** Colour cue for the pressure line: low (blue), high (red), or none. */
  tone: 'low' | 'high' | 'none' | 'inside';
}

/** The slice the probe moves in: the vertical plane y = const, over this x/z range (m). */
export interface ProbeSlice {
  y: number;
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
}

const BALL = 0xffffff;
const INSIDE = 0xffb454;
const LOW = '#76c0ff';
const HIGH = '#ff8064';

export class ProbeMarker {
  readonly object = new THREE.Group();
  private readonly ball: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly shaft: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly arrow = new THREE.Group();
  private readonly ballMaterial: THREE.MeshBasicMaterial;
  private readonly slice: THREE.LineLoop;
  private readonly label: CSS2DObject | null;
  private readonly title: HTMLElement | null = null;
  private readonly body: HTMLElement | null = null;
  private size = 0.2;

  constructor() {
    this.object.name = 'FlowProbe';
    this.object.visible = false;
    this.ballMaterial = new THREE.MeshBasicMaterial({
      color: BALL,
      depthTest: false,
      transparent: true,
      toneMapped: false,
    });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.ballMaterial);
    this.ring = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0x3dd6c8,
        transparent: true,
        opacity: 0.22,
        depthTest: false,
        toneMapped: false,
      }),
    );
    const arrowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    });
    // Unit arrow along +x: shaft from 0 to 0.78, head to 1.
    const shaftGeom = new THREE.CylinderGeometry(0.035, 0.035, 0.78, 10);
    shaftGeom.rotateZ(-Math.PI / 2);
    shaftGeom.translate(0.39, 0, 0);
    const headGeom = new THREE.ConeGeometry(0.1, 0.22, 14);
    headGeom.rotateZ(-Math.PI / 2);
    headGeom.translate(0.89, 0, 0);
    this.shaft = new THREE.Mesh(shaftGeom, arrowMaterial);
    this.head = new THREE.Mesh(headGeom, arrowMaterial);
    this.arrow.add(this.shaft, this.head);
    for (const m of [this.ball, this.ring, this.shaft, this.head]) {
      m.renderOrder = 20;
      m.frustumCulled = false;
    }

    const sliceGeom = new THREE.BufferGeometry();
    sliceGeom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    this.slice = new THREE.LineLoop(
      sliceGeom,
      new THREE.LineBasicMaterial({ color: 0x3dd6c8, transparent: true, opacity: 0.35 }),
    );
    this.slice.frustumCulled = false;

    this.label = this.createLabel();
    if (this.label) {
      this.title = this.label.element.querySelector('.al-probe__title');
      this.body = this.label.element.querySelector('.al-probe__body');
    }
    this.object.add(this.slice, this.ball, this.ring, this.arrow);
    if (this.label) this.object.add(this.label);
  }

  setVisible(on: boolean): void {
    this.object.visible = on;
    if (this.label) this.label.visible = on;
  }

  /** Marker radius (m); the arrow and label offsets scale with it. */
  setSize(radius: number): void {
    this.size = Math.max(1e-3, radius);
    this.ball.scale.setScalar(this.size);
    this.ring.scale.setScalar(this.size * 1.9);
  }

  setPoint(p: Vec3): void {
    this.ball.position.set(...p);
    this.ring.position.set(...p);
    this.arrow.position.set(...p);
    this.label?.position.set(p[0], p[1], p[2] + this.size * 2.2);
  }

  /**
   * Orient the flow arrow along `velocity` (m/s), with a length of `lengthPerVInf` meters at the
   * freestream speed. Null hides it (inside the wing).
   */
  setFlow(velocity: Vec3 | null, vInf: number, lengthPerVInf: number): void {
    const inside = velocity === null;
    this.ballMaterial.color.setHex(inside ? INSIDE : BALL);
    if (inside || !(vInf > 0)) {
      this.arrow.visible = false;
      return;
    }
    const v = new THREE.Vector3(...velocity);
    const speed = v.length();
    if (speed < 1e-6) {
      this.arrow.visible = false;
      return;
    }
    this.arrow.visible = true;
    this.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), v.normalize());
    const len = lengthPerVInf * Math.min(2.2, speed / vInf);
    this.arrow.scale.set(len, len * 0.6, len * 0.6);
  }

  setSlice(slice: ProbeSlice | null): void {
    this.slice.visible = slice !== null;
    if (!slice) return;
    const pos = this.slice.geometry.getAttribute('position') as THREE.BufferAttribute;
    const { y, xMin, xMax, zMin, zMax } = slice;
    pos.setXYZ(0, xMin, y, zMin);
    pos.setXYZ(1, xMax, y, zMin);
    pos.setXYZ(2, xMax, y, zMax);
    pos.setXYZ(3, xMin, y, zMax);
    pos.needsUpdate = true;
  }

  setReadout(r: ProbeReadout): void {
    if (!this.label || !this.title || !this.body) return;
    this.title.textContent = r.title;
    const doc = this.body.ownerDocument;
    this.body.replaceChildren(
      ...r.lines.map((text, i) => {
        const line = doc.createElement('div');
        line.textContent = text;
        if (i === 1 && (r.tone === 'low' || r.tone === 'high')) {
          line.style.color = r.tone === 'low' ? LOW : HIGH;
          line.style.fontWeight = '700';
        }
        return line;
      }),
    );
    this.label.element.style.borderColor =
      r.tone === 'inside' ? '#ffb454' : 'rgba(61, 214, 200, 0.6)';
  }

  dispose(): void {
    this.label?.element.remove();
    disposeObject3D(this.object);
  }

  private createLabel(): CSS2DObject | null {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'al-probe';
    el.setAttribute('aria-hidden', 'true'); // the app announces the readout in a live region
    const s = el.style;
    s.pointerEvents = 'none';
    s.font = '500 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif';
    s.color = '#e8f0fb';
    s.padding = '6px 9px 7px';
    s.borderRadius = '8px';
    s.border = '1px solid rgba(61, 214, 200, 0.6)';
    s.background = 'rgba(8, 14, 24, 0.86)';
    s.boxShadow = '0 6px 18px rgba(0, 0, 0, 0.35)';
    s.whiteSpace = 'nowrap';
    const title = document.createElement('div');
    title.className = 'al-probe__title';
    Object.assign(title.style, {
      font: '700 10.5px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: '#3dd6c8',
      marginBottom: '2px',
    });
    const body = document.createElement('div');
    body.className = 'al-probe__body';
    el.append(title, body);
    const label = new CSS2DObject(el);
    label.center.set(0.5, 1.08);
    return label;
  }
}
