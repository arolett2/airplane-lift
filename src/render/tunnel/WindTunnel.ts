/**
 * The wind-tunnel test section, drawn as quiet context so it frames the wing and flow without
 * competing with them: faint glass walls and ceiling with edge lines and frame ribs, a fading
 * floor grid, a faint honeycomb flow straightener at the inlet, a small dim outlet fan, an
 * "AIRFLOW" floor marking and a slim mounting sting up to the wing pivot. Inlet and outlet
 * hardware fade away when the camera looks in through them. Everything is in physics meters
 * (tunnel frame, Z up) and sized from the `TunnelDomain`.
 */
import * as THREE from 'three';
import type { TunnelDomain } from '../../physics/domain';
import type { Vec3 } from '../../physics/types';
import { clearGroup, disposeObject3D } from '../util/disposal';
import { setFrameTick } from '../util/frameTick';
import {
  boxEdges,
  floorGrid,
  honeycombSegments,
  honeycombVertices,
  niceStep,
  tunnelDims,
  wallRibs,
} from './tunnelLayout';

const GLASS_COLOR = 0x9cc4ff;
const EDGE_COLOR = 0x78a9dc;
const GRID_COLOR: readonly [number, number, number] = [0.12, 0.26, 0.4];
const FAN_SPIN_RAD_PER_S = 0.8;
/** Outlet fan radius as a fraction of the smaller cross-section dimension. */
const FAN_RADIUS_FRACTION = 0.3;

const _camera = new THREE.Vector3();

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Line segments from a flat xyz array. */
function lineSegments(
  positions: Float32Array,
  material: THREE.LineBasicMaterial,
  name: string,
): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const ls = new THREE.LineSegments(g, material);
  ls.name = name;
  ls.frustumCulled = false;
  return ls;
}

/** A translucent quad from four corners (counter-clockwise order not required: double sided). */
function quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, material: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(Float32Array.from([...p0, ...p1, ...p2, ...p0, ...p2, ...p3]), 3),
  );
  const m = new THREE.Mesh(g, material);
  m.frustumCulled = false;
  return m;
}

/** "AIRFLOW  ----->" painted on a transparent canvas, or null without a 2D canvas (tests). */
function createAirflowTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1024, 128);
  ctx.fillStyle = 'rgba(165, 215, 255, 0.9)';
  ctx.strokeStyle = 'rgba(165, 215, 255, 0.9)';
  ctx.font = '700 70px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  let x = 24;
  for (const ch of 'AIRFLOW') {
    ctx.fillText(ch, x, 66);
    x += ctx.measureText(ch).width + 16;
  }
  // Arrow: shaft and head.
  const y = 64;
  const x0 = x + 28;
  const x1 = 990;
  ctx.lineWidth = 10;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1 - 40, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x1 - 58, y - 34);
  ctx.lineTo(x1 - 58, y + 34);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class WindTunnel {
  readonly object = new THREE.Group();

  private readonly shell = new THREE.Group();
  private readonly sting = new THREE.Group();
  private readonly stingMaterial = new THREE.MeshStandardMaterial({
    color: 0x5d6b82,
    metalness: 0.7,
    roughness: 0.38,
  });
  private stingStrut: THREE.Mesh | null = null;
  private stingBase: THREE.Mesh | null = null;
  private readonly strutGeometry: THREE.CylinderGeometry;
  private readonly baseGeometry: THREE.CylinderGeometry;

  /** Painted once and reused across rebuilds (the shell is rebuilt on every domain change). */
  private airflowTexture: THREE.CanvasTexture | null = null;
  private airflowMaterial: THREE.MeshBasicMaterial | null = null;

  private domain: TunnelDomain | null = null;
  private mount: Vec3 = [0, 0, 0];
  private readonly reducedMotion = prefersReducedMotion();

  constructor() {
    this.object.name = 'WindTunnel';
    this.object.add(this.shell, this.sting);

    // Unit strut: elliptical section (radius 1), axis +z from 0 to 1.
    this.strutGeometry = new THREE.CylinderGeometry(1, 1, 1, 20, 1, false);
    this.strutGeometry.rotateX(Math.PI / 2);
    this.strutGeometry.translate(0, 0, 0.5);
    this.baseGeometry = new THREE.CylinderGeometry(1, 1, 1, 28, 1, false);
    this.baseGeometry.rotateX(Math.PI / 2);
    this.baseGeometry.translate(0, 0, 0.5);
  }

  /** Rebuild the test section for a new domain. */
  setDomain(domain: TunnelDomain): void {
    this.domain = domain;
    this.buildShell(domain);
    this.updateSting();
  }

  /** The sting reaches the wing pivot (tunnel frame). */
  setMountPoint(pivot: Vec3): void {
    this.mount = [pivot[0], pivot[1], pivot[2]];
    this.updateSting();
  }

  dispose(): void {
    this.detachAirflowTexture();
    clearGroup(this.shell);
    this.airflowTexture?.dispose();
    this.airflowTexture = null;
    this.strutGeometry.dispose();
    this.baseGeometry.dispose();
    this.stingMaterial.dispose();
    disposeObject3D(this.sting);
    this.object.removeFromParent();
    this.stingStrut = null;
    this.stingBase = null;
    this.domain = null;
  }

  /* ---------------------------------------------------------------------------------------- */

  private updateSting(): void {
    const domain = this.domain;
    if (!domain) return;
    const { span } = tunnelDims(domain);
    const floorZ = domain.min[2];
    const height = Math.max(1e-3, this.mount[2] - floorZ);
    const r = Math.max(1e-3, 0.0045 * span);

    if (!this.stingStrut) {
      this.stingStrut = new THREE.Mesh(this.strutGeometry, this.stingMaterial);
      this.stingStrut.name = 'Sting';
      this.stingBase = new THREE.Mesh(this.baseGeometry, this.stingMaterial);
      this.stingBase.name = 'StingBase';
      this.sting.add(this.stingStrut, this.stingBase);
    }
    // Faired strut: longer along the flow than across it.
    this.stingStrut.position.set(this.mount[0], this.mount[1], floorZ);
    this.stingStrut.scale.set(2.4 * r, r, height);
    this.stingBase!.position.set(this.mount[0], this.mount[1], floorZ);
    this.stingBase!.scale.set(6 * r, 6 * r, 0.7 * r);
  }

  /** Unhook the shared texture so disposing the old shell does not free it. */
  private detachAirflowTexture(): void {
    if (this.airflowMaterial) this.airflowMaterial.map = null;
    this.airflowMaterial = null;
  }

  private buildShell(domain: TunnelDomain): void {
    this.detachAirflowTexture();
    clearGroup(this.shell);
    const d = tunnelDims(domain);
    const { lx, ly, lz, span } = d;
    const [x0, y0, z0] = domain.min;
    const [x1, y1, z1] = domain.max;
    const eps = 4e-4 * Math.max(lx, ly, lz);

    // Floor plate: a dark pane that gives the grid something to sit on.
    const floorMat = new THREE.MeshBasicMaterial({
      color: 0x0b1424,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const floor = quad(
      [x0, y0, z0 - eps],
      [x1, y0, z0 - eps],
      [x1, y1, z0 - eps],
      [x0, y1, z0 - eps],
      floorMat,
    );
    floor.name = 'FloorPlate';
    floor.renderOrder = -6;
    this.shell.add(floor);

    // Floor grid (additive, fades toward the edges).
    const step = niceStep(span, 10);
    const grid = floorGrid(domain, step, 5);
    const colors = new Float32Array(grid.brightness.length * 3);
    for (let i = 0; i < grid.brightness.length; i++) {
      const b = grid.brightness[i]!;
      colors[3 * i] = GRID_COLOR[0] * b;
      colors[3 * i + 1] = GRID_COLOR[1] * b;
      colors[3 * i + 2] = GRID_COLOR[2] * b;
    }
    const gridPositions = grid.positions.slice();
    for (let i = 2; i < gridPositions.length; i += 3) gridPositions[i] = z0 + eps;
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.BufferAttribute(gridPositions, 3));
    gridGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const gridLines = new THREE.LineSegments(
      gridGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    gridLines.name = 'FloorGrid';
    gridLines.frustumCulled = false;
    gridLines.renderOrder = -5;
    this.shell.add(gridLines);

    // Glass: side walls and ceiling, almost invisible.
    const glass = new THREE.MeshBasicMaterial({
      color: GLASS_COLOR,
      transparent: true,
      opacity: 0.025,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const wallL = quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], glass);
    const wallR = quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], glass);
    const ceiling = quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], glass);
    for (const [m, name] of [
      [wallL, 'WallLeft'],
      [wallR, 'WallRight'],
      [ceiling, 'Ceiling'],
    ] as const) {
      m.name = name;
      m.renderOrder = -4;
      this.shell.add(m);
    }

    // Edge lines and frame ribs.
    const edges = lineSegments(
      boxEdges(domain),
      new THREE.LineBasicMaterial({
        color: EDGE_COLOR,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
      }),
      'Edges',
    );
    edges.renderOrder = -3;
    this.shell.add(edges);
    const ribs = lineSegments(
      wallRibs(domain, 7),
      new THREE.LineBasicMaterial({
        color: EDGE_COLOR,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
      }),
      'Ribs',
    );
    ribs.renderOrder = -3;
    this.shell.add(ribs);

    this.buildHoneycomb(domain);
    this.buildOutlet(domain);
    this.buildAirflowMarking(domain);
  }

  /** Hexagonal flow straightener across the inlet face, two layers deep. */
  private buildHoneycomb(domain: TunnelDomain): void {
    const { lx, ly, lz } = tunnelDims(domain);
    const x = domain.min[0] + 1e-3 * lx;
    const depth = 0.022 * lx;
    const radius = Math.max(lz, 0.4 * ly) / 17;
    const seg = honeycombSegments(ly, lz, radius);
    const verts = honeycombVertices(ly, lz, radius);
    const y0 = domain.min[1];
    const z0 = domain.min[2];

    const layer = (xPos: number): Float32Array => {
      const p = new Float32Array((seg.length / 4) * 6);
      for (let i = 0, o = 0; i < seg.length; i += 4) {
        p[o++] = xPos;
        p[o++] = y0 + seg[i]!;
        p[o++] = z0 + seg[i + 1]!;
        p[o++] = xPos;
        p[o++] = y0 + seg[i + 2]!;
        p[o++] = z0 + seg[i + 3]!;
      }
      return p;
    };
    const front = lineSegments(
      layer(x),
      new THREE.LineBasicMaterial({
        color: 0x84a6cf,
        transparent: true,
        opacity: 0.11,
        depthWrite: false,
      }),
      'HoneycombFront',
    );
    const back = lineSegments(
      layer(x + depth),
      new THREE.LineBasicMaterial({
        color: 0x84a6cf,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
      }),
      'HoneycombBack',
    );
    const links = new Float32Array((verts.length / 2) * 6);
    for (let i = 0, o = 0; i < verts.length; i += 2) {
      links[o++] = x;
      links[o++] = y0 + verts[i]!;
      links[o++] = z0 + verts[i + 1]!;
      links[o++] = x + depth;
      links[o++] = y0 + verts[i]!;
      links[o++] = z0 + verts[i + 1]!;
    }
    const connectors = lineSegments(
      links,
      new THREE.LineBasicMaterial({
        color: 0x84a6cf,
        transparent: true,
        opacity: 0.035,
        depthWrite: false,
      }),
      'HoneycombLinks',
    );
    for (const o of [front, back, connectors]) {
      o.renderOrder = -2;
      this.fadeWhenCameraBeyond(o, domain.min[0], -1, 0.25);
      this.shell.add(o);
    }
  }

  /** Outlet wall with a round opening, and a slowly spinning fan inside it. */
  private buildOutlet(domain: TunnelDomain): void {
    const { lx, ly, lz, cy, cz } = tunnelDims(domain);
    const x = domain.max[0] - 1e-3 * lx;
    const R = FAN_RADIUS_FRACTION * Math.min(ly, lz);

    // Panel: the rectangle of the outlet face minus a circular opening.
    const shape = new THREE.Shape();
    shape.moveTo(-0.5 * ly, -0.5 * lz);
    shape.lineTo(0.5 * ly, -0.5 * lz);
    shape.lineTo(0.5 * ly, 0.5 * lz);
    shape.lineTo(-0.5 * ly, 0.5 * lz);
    shape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, 1.08 * R, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const panelGeo = new THREE.ShapeGeometry(shape, 32);
    const p = panelGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, x, cy + p.getX(i), cz + p.getY(i));
    p.needsUpdate = true;
    const panel = new THREE.Mesh(
      panelGeo,
      new THREE.MeshBasicMaterial({
        color: 0x16233b,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    panel.name = 'OutletPanel';
    panel.frustumCulled = false;
    panel.renderOrder = -4;
    this.fadeWhenCameraBeyond(panel, x, 1, 0);
    this.shell.add(panel);

    // Fan: shroud ring, hub and pitched blades, spinning about the flow axis.
    const fan = new THREE.Group();
    fan.name = 'OutletFan';
    // Inset so the pitched blades stay inside the section.
    fan.position.set(x - Math.max(0.02 * lx, 0.13 * R), cy, cz);
    const ringGeo = new THREE.TorusGeometry(R, 0.02 * R, 8, 72);
    ringGeo.rotateY(Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0x8fb0d8,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    this.fadeWhenCameraBeyond(ring, x - 0.05 * lx, 1, 0);
    this.shell.add(ring);
    ring.position.copy(fan.position);

    const hubGeo = new THREE.CylinderGeometry(0.11 * R, 0.11 * R, 0.1 * R, 20);
    hubGeo.rotateZ(Math.PI / 2);
    const bladeMat = new THREE.MeshBasicMaterial({
      color: 0x9db8dd,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    fan.add(new THREE.Mesh(hubGeo, bladeMat));
    const blades = 7;
    const r0 = 0.1 * R;
    const r1 = 0.96 * R;
    for (let i = 0; i < blades; i++) {
      const g = new THREE.BufferGeometry();
      const w0 = 0.07 * R;
      const w1 = 0.2 * R;
      // Blade in the y-z plane (normal along the flow axis x), radial along +y.
      g.setAttribute(
        'position',
        new THREE.BufferAttribute(
          Float32Array.from([0, r0, -w0, 0, r0, w0, 0, r1, w1, 0, r0, -w0, 0, r1, w1, 0, r1, -w1]),
          3,
        ),
      );
      g.rotateY(0.5); // pitch the blade about its radial axis (+y)
      g.rotateX((i * Math.PI * 2) / blades);
      fan.add(new THREE.Mesh(g, bladeMat));
    }
    for (const blade of fan.children) this.fadeWhenCameraBeyond(blade, x - 0.05 * lx, 1, 0);
    this.shell.add(fan);
    if (!this.reducedMotion) {
      setFrameTick(fan, (dt) => {
        fan.rotation.x += dt * FAN_SPIN_RAD_PER_S;
      });
    }
  }

  /**
   * Fade `object` (to `keep` x its opacity) while the camera is outside the test section beyond
   * the plane x = faceX on the given side (-1 upstream, +1 downstream), i.e. looking in through
   * it. Shared materials are fine: the opacity is set right before each draw.
   */
  private fadeWhenCameraBeyond(
    object: THREE.Object3D,
    faceX: number,
    side: 1 | -1,
    keep: number,
  ): void {
    const mesh = object as THREE.Mesh;
    const material = mesh.material as THREE.Material | undefined;
    if (!material || Array.isArray(material)) return;
    const base = material.opacity;
    object.onBeforeRender = (_renderer, _scene, camera) => {
      _camera.setFromMatrixPosition(camera.matrixWorld);
      this.shell.worldToLocal(_camera);
      material.opacity = side * (_camera.x - faceX) > 0 ? base * keep : base;
    };
  }

  /** "AIRFLOW ->" painted on the floor beside the wing's path, reading in the flow direction. */
  private buildAirflowMarking(domain: TunnelDomain): void {
    this.airflowTexture ??= createAirflowTexture();
    const tex = this.airflowTexture;
    if (!tex) return;
    const { lx, ly } = tunnelDims(domain);
    const w = 0.3 * lx;
    const h = w / 8;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.airflowMaterial = mat;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.name = 'AirflowMarking';
    mesh.position.set(
      domain.min[0] + 0.5 * lx - 0.08 * lx,
      domain.min[1] + 0.1 * ly,
      domain.min[2] + 1.2e-3 * Math.max(lx, ly),
    );
    mesh.renderOrder = -4;
    this.shell.add(mesh);
  }
}
