/**
 * Airfoil module facade: memoised geometry + panel solver + polar per section definition.
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 */
import type { AirfoilGeometry, ChordwiseCp, FlapState, Naca4Params, SectionPolar } from '../types';
import type { PanelSolver } from './panel';
import { notImplemented } from '../../shared/notImplemented';

export interface AirfoilKey {
  params: Naca4Params;
  flap: FlapState | null;
  slat: boolean;
  supercritical: boolean;
}

export interface AirfoilModel {
  key: AirfoilKey;
  geometry: AirfoilGeometry;
  solver: PanelSolver;
  polar: SectionPolar;
  /**
   * Chordwise surface Cp at an effective angle of attack, with the upper-surface pressure
   * flattened aft of the separation point when stalled. When `targetCl` is given the Cp
   * difference is scaled so the section integrates to that cl (quasi-3D colouring).
   * @param nStations number of cosine-spaced x/c stations (default 41)
   */
  chordwiseCp(
    alphaEffective: number,
    reynolds: number,
    nStations?: number,
    targetCl?: number,
  ): ChordwiseCp;
}

/** Memoised (small LRU) — calling repeatedly with an equal key returns the same model. */
export const getAirfoilModel: (key: AirfoilKey) => AirfoilModel = notImplemented('getAirfoilModel');
