/**
 * 2D linear-strength vortex panel method (inviscid, incompressible).
 * OWNER: physics-airfoil agent. CONTRACT — keep the exported signatures.
 *
 * The influence matrix depends only on geometry, so a solver factorises it once and reuses
 * the factorisation (superposing alpha = 0 and alpha = 90 deg solutions) for any alpha.
 */
import type { AirfoilGeometry, PanelSolution } from '../types';
import { notImplemented } from '../../shared/notImplemented';

export interface PanelSolver {
  readonly geometry: AirfoilGeometry;
  /** Solve at angle of attack alpha (rad). Cheap after construction. */
  solve(alpha: number): PanelSolution;
  /**
   * Velocity (normalised by V_inf) at an arbitrary field point (airfoil frame) for a solution.
   * Writes [u, v] into `out`. Points on/inside the body return finite values.
   */
  velocityAt(solution: PanelSolution, x: number, y: number, out: [number, number]): void;
}

export const createPanelSolver: (geometry: AirfoilGeometry) => PanelSolver =
  notImplemented('createPanelSolver');
