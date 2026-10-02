/**
 * Body <-> tunnel frame transforms. See the frame definitions in physics/types.ts.
 * The wing is pitched nose-up by alpha about the +y axis through the pivot.
 */
import type { Vec3 } from '../types';

/** Rotate a body-frame point into the tunnel frame. */
export function bodyToTunnel(p: Vec3, pivot: Vec3, alpha: number): Vec3 {
  const c = Math.cos(alpha);
  const s = Math.sin(alpha);
  const dx = p[0] - pivot[0];
  const dz = p[2] - pivot[2];
  return [pivot[0] + dx * c + dz * s, p[1], pivot[2] - dx * s + dz * c];
}

/** Rotate a body-frame direction (no translation) into the tunnel frame. */
export function bodyDirToTunnel(d: Vec3, alpha: number): Vec3 {
  const c = Math.cos(alpha);
  const s = Math.sin(alpha);
  return [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c];
}

/** Inverse of bodyToTunnel. */
export function tunnelToBody(p: Vec3, pivot: Vec3, alpha: number): Vec3 {
  return bodyToTunnel(p, pivot, -alpha);
}
