/**
 * The wind-tunnel test section: the region where flow is computed and drawn.
 * Sized from the wing span so every aircraft fits. TUNNEL frame, meters.
 * Shared by the flow-field grid (physics) and the tunnel model (render).
 */
import type { Vec3 } from './types';

export interface TunnelDomain {
  min: Vec3;
  max: Vec3;
}

/**
 * @param overallSpan tip-to-tip span including tip devices (m)
 * @param rootChord   longest chord (m), so stubby wings still get room fore and aft
 */
export function tunnelDomain(overallSpan: number, rootChord: number): TunnelDomain {
  const b = overallSpan;
  const ahead = Math.max(0.45 * b, 2.5 * rootChord);
  const behind = Math.max(1.25 * b, 6 * rootChord);
  const halfWidth = 0.75 * b;
  const halfHeight = Math.max(0.3 * b, 2.5 * rootChord);
  return {
    min: [-ahead, -halfWidth, -halfHeight],
    max: [behind, halfWidth, halfHeight],
  };
}
