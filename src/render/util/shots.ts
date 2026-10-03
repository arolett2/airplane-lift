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
 *
 * Shots frame the WING (the hero), not the tunnel: the tunnel is context and may run off-screen.
 * `fovYDeg` and `aspect` describe the part of the canvas that is actually visible (the caller
 * removes the floating panels), so "fills 65% of the width" means of the visible width.
 */
import type { CameraShot } from '../../state/params';
import type { TunnelDomain } from '../../physics/domain';
import type { Vec3 } from '../../physics/types';
import type { WingFraming, WingStation } from './framing';

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
  /** Wing bounds, rake station and tip in display units (estimated when not provided). */
  wing: WingFraming;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

function toDisplay(p: Vec3, center: Vec3, scale: number): Vec3 {
  return [(p[0] - center[0]) * scale, (p[1] - center[1]) * scale, (p[2] - center[2]) * scale];
}

function stationToDisplay(s: WingStation, center: Vec3, scale: number): WingStation {
  return { le: toDisplay(s.le, center, scale), chord: s.chord * scale };
}

/** A plausible wing (aspect ratio ~8, light sweep) around the pivot, for when none is known. */
function estimatedWing(pivot: Vec3, s: number): WingFraming {
  const c = 0.25 * s;
  const [px, py, pz] = pivot;
  return {
    min: [px - 0.25 * c, py - s, pz - 0.06 * c],
    max: [px + 0.15 * s + 0.75 * c, py + s, pz + 0.1 * c],
    station: { le: [px + 0.05 * s - 0.25 * c, py + 0.35 * s, pz], chord: 0.8 * c },
    tip: { le: [px + 0.15 * s - 0.1 * c, py + s, pz], chord: 0.4 * c },
  };
}

/**
 * Derive display extents from a tunnel domain.
 * @param pivotPhysics wing pivot in physics meters (default: the physics origin)
 * @param semispanPhysics wing semispan in meters; inferred from the domain width when omitted
 * @param framing wing bounds / stations in physics meters (see framing.ts); estimated when omitted
 */
export function extentsFromDomain(
  domain: TunnelDomain,
  pivotPhysics: Vec3 = [0, 0, 0],
  displayLength = DISPLAY_LENGTH,
  semispanPhysics?: number,
  framing?: WingFraming,
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
  const pivot = toDisplay(pivotPhysics, centerPhysics, scale);
  // tunnelDomain(): halfWidth = 0.75 * overallSpan  =>  span = width / 1.5.
  const semispan =
    semispanPhysics !== undefined && semispanPhysics > 0
      ? semispanPhysics * scale
      : (0.5 * ly * scale) / 1.5;
  const wing = framing
    ? {
        min: toDisplay(framing.min, centerPhysics, scale),
        max: toDisplay(framing.max, centerPhysics, scale),
        station: stationToDisplay(framing.station, centerPhysics, scale),
        tip: stationToDisplay(framing.tip, centerPhysics, scale),
      }
    : estimatedWing(pivot, semispan);
  return {
    scale,
    centerPhysics,
    size: [lx * scale, ly * scale, lz * scale],
    pivot,
    semispan,
    wing,
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

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Smallest distance along `toCamera` (unit, from the target to the camera) at which every point
 * projects inside `fillX` x `fillY` of the view (fractions of the half-widths), in perspective.
 */
export function fitPoints(
  points: readonly Vec3[],
  target: Vec3,
  toCamera: Vec3,
  fovYDeg: number,
  aspect: number,
  fillX: number,
  fillY: number,
): number {
  const c = normalize(toCamera);
  const worldUp: Vec3 = Math.abs(c[2]) > 0.995 ? [0, 1, 0] : [0, 0, 1];
  const right = normalize(cross(worldUp, c));
  const up = cross(c, right);
  const tanV = Math.tan((fovYDeg * Math.PI) / 360) * fillY;
  const tanH = Math.tan((fovYDeg * Math.PI) / 360) * Math.max(0.2, aspect) * fillX;
  let d = 0;
  for (const p of points) {
    const rel: Vec3 = [p[0] - target[0], p[1] - target[1], p[2] - target[2]];
    const along = dot(rel, c);
    d = Math.max(
      d,
      along + Math.abs(dot(rel, right)) / tanH,
      along + Math.abs(dot(rel, up)) / tanV,
    );
  }
  return d;
}

function boxCorners(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

function along(target: Vec3, dir: Vec3, d: number): Vec3 {
  const n = normalize(dir);
  return [target[0] + n[0] * d, target[1] + n[1] * d, target[2] + n[2] * d];
}

/** Camera position and look-at target for a named shot. */
export function computeShot(
  shot: CameraShot,
  ext: SceneExtents,
  fovYDeg: number,
  aspect: number,
): CameraPose {
  const s = ext.semispan;
  const { min, max, station, tip } = ext.wing;
  const halfX = 0.5 * ext.size[0];
  const wingCenter: Vec3 = [0.5 * (min[0] + max[0]), 0.5 * (min[1] + max[1]), ext.pivot[2]];
  const wingLength = Math.max(max[0] - min[0], 1e-3);
  const chord = Math.max(station.chord, 1e-3);
  // Leftmost wing point the side cameras must stay clear of.
  const nearY = min[1];

  switch (shot) {
    case 'side':
    case 'section': {
      // Look along +y at the rake station: the chord plus the air ahead (upwash) and behind
      // (downwash). 'section' is a close-up of the airfoil itself.
      const close = shot === 'section';
      const ahead = (close ? 1.1 : 2.4) * chord;
      const behind = (close ? 2.0 : 4.6) * chord;
      const target: Vec3 = [
        station.le[0] + 0.5 * (behind - ahead),
        station.le[1],
        station.le[2] + (close ? 0 : 0.1 * chord),
      ];
      const halfW = 0.5 * (ahead + behind);
      const tanV = Math.tan((fovYDeg * Math.PI) / 360);
      const tanH = tanV * Math.max(0.2, aspect);
      let d = Math.max(halfW / tanH, (0.6 * chord) / tanV);
      // A short side camera would sit right on the near wing: then look down on it a little more
      // so the near wing passes under the frame (the side shot also backs off to the tip).
      const clearance = station.le[1] - nearY + 0.6 * chord;
      if (!close) d = Math.max(d, clearance);
      const inside = d < clearance;
      const elevation = ((inside ? 14 : close ? 6 : 3) * Math.PI) / 180;
      return {
        position: [
          target[0],
          target[1] - d * Math.cos(elevation),
          target[2] + d * Math.sin(elevation),
        ],
        target,
      };
    }
    case 'front': {
      // From upstream, a little above: the span fills ~78% of the width.
      const target: Vec3 = [wingCenter[0], wingCenter[1], wingCenter[2]];
      const dir: Vec3 = [-1, 0, 0.16];
      const d = fitPoints(boxCorners(min, max), target, dir, fovYDeg, aspect, 0.78, 0.7);
      const pos = along(target, dir, d);
      pos[0] = Math.max(pos[0], -halfX - 0.35 * ext.size[0]);
      return { position: pos, target };
    }
    case 'top': {
      // From above: the wing and the start of its wake.
      const lo: Vec3 = [min[0] - 0.15 * s, min[1], min[2]];
      const hi: Vec3 = [max[0] + 0.55 * s, max[1], max[2]];
      const target: Vec3 = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), wingCenter[2]];
      // Tilted ~3 degrees toward -y so the Z-up camera has a defined screen-up (+y).
      const dir: Vec3 = [0, -0.05, 1];
      const d = fitPoints(boxCorners(lo, hi), target, dir, fovYDeg, aspect, 0.92, 0.88);
      return { position: along(target, dir, d), target };
    }
    case 'tip': {
      // Behind, outboard and above the right tip, looking back up the trailing vortex so its
      // curl and the wingtip it comes from are both in view.
      const tc = Math.max(tip.chord, 0.12 * chord);
      const te: Vec3 = [tip.le[0] + tc, tip.le[1], tip.le[2]];
      const r = Math.max(0.22 * s, 4.5 * tc);
      const target: Vec3 = [te[0] + 0.35 * r, te[1] - 0.12 * r, te[2] - 0.05 * r];
      return {
        position: [target[0] + 1.6 * r, target[1] + 1.05 * r, target[2] + 0.55 * r],
        target,
      };
    }
    case 'behind': {
      // From downstream, slightly above: downwash and both tip vortices.
      const target: Vec3 = [max[0], wingCenter[1], wingCenter[2]];
      const dir: Vec3 = [1, 0, 0.2];
      const lo: Vec3 = [min[0], min[1], min[2]];
      const d = fitPoints(boxCorners(lo, max), target, dir, fovYDeg, aspect, 0.8, 0.7);
      const pos = along(target, dir, Math.max(d, 0.05 * s));
      pos[0] = Math.min(pos[0], halfX + 0.35 * ext.size[0]);
      return { position: pos, target };
    }
    case 'overview':
    default: {
      // 3/4 view from the front-left, above: the wing spans about two thirds of the width, with
      // room behind it for the wake.
      const wake = Math.min(0.55 * s, 1.2 * wingLength);
      const target: Vec3 = [wingCenter[0] + 0.25 * wake, wingCenter[1], wingCenter[2] - 0.04 * s];
      const dir: Vec3 = [-0.62, -0.74, 0.5];
      const lo: Vec3 = [min[0], min[1], min[2] - 0.05 * s];
      const hi: Vec3 = [max[0] + wake, max[1], max[2] + 0.05 * s];
      const d = fitPoints(boxCorners(lo, hi), target, dir, fovYDeg, aspect, 0.8, 0.78);
      return { position: along(target, dir, d), target };
    }
  }
}
