/**
 * WingConfig (UI parameters, degrees) -> WingGeometry (sections in body frame, radians, meters),
 * including the mirrored left side and tip-device surfaces.
 * OWNER: physics-geometry agent. CONTRACT — keep the exported signatures.
 */
import type { LiftingSurface, WingGeometry, WingSection } from '../types';
import type { WingConfig } from '../../state/params';
import { notImplemented } from '../../shared/notImplemented';

export const buildWingGeometry: (config: WingConfig) => WingGeometry =
  notImplemented('buildWingGeometry');

/**
 * Interpolate a section along a surface at parameter s in [0, sections.length - 1]
 * (integer part = segment index, fractional part = position within the segment).
 * Interpolates le, chord, twist, roll and airfoil linearly. The flap is the inboard section's flap
 * only when BOTH bounding sections have one (else null); slat likewise needs both ends true.
 */
export const interpolateSection: (surface: LiftingSurface, s: number) => WingSection =
  notImplemented('interpolateSection');
