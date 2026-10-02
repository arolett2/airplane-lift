/**
 * Camera shot framing, pure math (no three.js objects). Everything is in DISPLAY units: the
 * space of the world after `modelRoot` has been scaled and centred on the tunnel domain.
 *
 * World axes (Z-up): +x is the airflow direction, +y the right wing, +z up. Each shot's screen
 * orientation is chosen so the airflow reads naturally:
 *   side   camera at -y looking +y        -> airflow runs LEFT -> RIGHT
 *   front  camera upstream looking +x     -> right wing appears on the screen's left
 *   behind camera downstream looking -x   -> right wing on the screen's right
 *   top    camera above, tilted a hair    -> airflow LEFT -> RIGHT, right wing up the screen
 */
import type { CameraShot } from '../../state/params';
import type { TunnelDomain } from '../../physics/domain';
import type { Vec3 } from '../../physics/types';

/** Tunnel domain length (x) in display units. */
export const DISPLAY_LENGTH = 12;

/** The tunnel domain mapped into display space. */
export interface SceneExtents {
  /** Uniform scale from physics meters to display units. */
  scale: number;
  /** Physics-space centre of the domain (maps to the display origin). */
  centerPhysics: Vec3;
  /** Display-space size of the domain box (x, y, z). */
  size: Vec3;
  /** Wing pivot in display space. */
  pivot: Vec3;
  /** Wing semispan in display units (inferred: tunnelDomain() makes the width 1.5 * span). */
  semispan: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

/**
 * Derive display extents from a tunnel domain.
 * @param pivotPhysics wing pivot in physics meters (the physics frame has it at the origin)
 */
export function extentsFromDomain(
  domain: TunnelDomain,
  pivotPhysics: Vec3 = [0, 0, 0],
  displayLength = DISPLAY_LENGTH,
): SceneExtents {
  const lx = Math.max(1e-6, domain.max[0] - domain.min[0]);
  const ly = Math.max(1e-6, domain.max[1] - domain.min[1]);
  const lz = Math.max(1e-6, domain.max[2] - domain.min[2]);
  const scale = displayLength / lx;
  const centerPhysics: Vec3 = [
    0.5 * (domain.min[0] + domain.max[0]),
    0.5 * (domain.min[1] + domain.max[1]),
    0.5 * (domain.min[2] + domain.max[2]),
  ];
  return {
    scale,
    centerPhysics,
    size: [lx * scale, ly * scale, lz * scale],
    pivot: [
      (pivotPhysics[0] - centerPhysics[0]) * scale,
      (pivotPhysics[1] - centerPhysics[1]) * scale,
      (pivotPhysics[2] - centerPhysics[2]) * scale,
    ],
    // tunnelDomain(): halfWidth = 0.75 * overallSpan  =>  span = width / 1.5.
    semispan: (0.5 * ly * scale) / 1.5,
  };
}

/**
 * Distance from the look-at point at which a w x h rectangle (facing the camera, at the near
 * face of a box of the given depth) fills the view with the given margin.
 */
export function fitDistance(
  width: number,
  height: number,
  depth: number,
  fovYDeg: number,
  aspect: number,
  margin = 1.1,
): number {
  const tanV = Math.tan((fovYDeg * Math.PI) / 360);
  const tanH = tanV * Math.max(0.2, aspect);
  const dV = (0.5 * height * margin) / tanV;
  const dH = (0.5 * width * margin) / tanH;
  return Math.max(dV, dH) + 0.5 * depth;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Camera position and look-at target for a named shot. */
export function computeShot(
  shot: CameraShot,
  ext: SceneExtents,
  fovYDeg: number,
  aspect: number,
): CameraPose {
  const [lx, ly, lz] = ext.size;
  const pivot = ext.pivot;
  const s = ext.semispan;
  const span = 2 * s;
  const halfX = 0.5 * lx;

  switch (shot) {
    case 'side': {
      const d = fitDistance(lx, lz, ly, fovYDeg, aspect, 1.06);
      return { position: [0, -d, 0], target: [0, 0, 0] };
    }
    case 'front': {
      // Frame the wing span; the camera may sit inside the tunnel (the walls are almost clear).
      const d = fitDistance(span * 1.5, span * 0.75, 0, fovYDeg, aspect, 1.0);
      const x = Math.max(pivot[0] - d, -halfX - 0.35 * lx);
      return { position: [x, 0, pivot[2] + 0.08 * span], target: [pivot[0], 0, pivot[2]] };
    }
    case 'top': {
      const d = fitDistance(lx, ly, lz, fovYDeg, aspect, 1.06);
      // Tilted ~3 degrees toward -y so the Z-up camera has a defined screen-up (+y).
      const tilt = 0.05 * d;
      return { position: [0, -tilt, d], target: [0, 0, 0] };
    }
    case 'tip': {
      const tip: Vec3 = [pivot[0] + 0.12 * s, pivot[1] + s, pivot[2]];
      const off = Math.max(0.42 * s, 0.35);
      return {
        position: [tip[0] + 1.25 * off, tip[1] + 1.05 * off, tip[2] + 0.32 * off],
        target: [tip[0] + 0.45 * off, tip[1] - 0.02 * off, tip[2] - 0.02 * off],
      };
    }
    case 'behind': {
      const d = Math.min(
        fitDistance(span * 1.5, span * 0.75, 0, fovYDeg, aspect, 1.0),
        0.95 * (halfX - pivot[0]),
      );
      return {
        position: [pivot[0] + Math.max(d, 0.3), 0, pivot[2] + 0.1 * span],
        target: [pivot[0] - 0.1 * span, 0, pivot[2]],
      };
    }
    case 'section': {
      // Side view zoomed on the wing: show about 0.34 spans along the flow.
      const w = Math.max(0.34 * span, 0.4);
      const d = fitDistance(w, 0.5 * w, 0, fovYDeg, aspect, 1.0);
      return {
        position: [pivot[0] + 0.03 * span, pivot[1] - d, pivot[2] + 0.01 * span],
        target: [pivot[0] + 0.03 * span, pivot[1], pivot[2]],
      };
    }
    case 'overview':
    default: {
      // 3/4 view from the front-left, above. Frame the bounding sphere of the tunnel.
      const radius = 0.5 * Math.hypot(lx, ly, lz) * 0.8;
      const tanV = Math.tan((fovYDeg * Math.PI) / 360);
      const halfFov = Math.atan(Math.min(tanV, tanV * Math.max(0.2, aspect)));
      const d = radius / Math.sin(halfFov);
      const target: Vec3 = [0.65 * pivot[0], 0, 0.5 * pivot[2]];
      const dir: Vec3 = [-0.62, -0.62, 0.48];
      const n = Math.hypot(dir[0], dir[1], dir[2]);
      return {
        position: add(target, [(dir[0] / n) * d, (dir[1] / n) * d, (dir[2] / n) * d]),
        target,
      };
    }
  }
}
