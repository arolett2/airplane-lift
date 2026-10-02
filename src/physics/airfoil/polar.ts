/**
 * Viscous section polar: panel-method lift slope + empirical stall/post-stall and drag models.
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 */
import type { FlapState, Naca4Params, SectionPolar } from '../types';
import type { PanelSolver } from './panel';
import { notImplemented } from '../../shared/notImplemented';

export interface SectionPolarOptions {
  flap: FlapState | null;
  /** Leading-edge slat deployed: delays stall (roughly +6..10 deg, +0.6..1.0 clMax). */
  slat: boolean;
  /** Supercritical section (affects only compressibility estimates elsewhere; kept for keying). */
  supercritical: boolean;
}

export const createSectionPolar: (
  params: Naca4Params,
  solver: PanelSolver,
  options: SectionPolarOptions,
) => SectionPolar = notImplemented('createSectionPolar');
