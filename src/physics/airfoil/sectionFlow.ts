/**
 * 2D flow around one wing section for the cross-section view: velocity grid, streamlines with
 * travel times (for timeline pulses), Cp, stagnation point.
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 */
import type { SectionFlow } from '../types';
import type { AirfoilModel } from './index';
import { notImplemented } from '../../shared/notImplemented';

export interface SectionFlowInput {
  eta: number;
  alphaGeometric: number; // rad (root alpha + local twist + flap-free incidence)
  alphaInduced: number; // rad
  reynolds: number;
}

export interface SectionFlowOptions {
  /** Grid resolution (default 160 x 96) over the default window x in [-0.6, 1.8], y in [-0.6, 0.6]. */
  nx?: number;
  ny?: number;
  /** Number of streamlines seeded upstream (default 28). */
  streamlines?: number;
}

export const computeSectionFlow: (
  model: AirfoilModel,
  input: SectionFlowInput,
  options?: SectionFlowOptions,
) => SectionFlow = notImplemented('computeSectionFlow');
