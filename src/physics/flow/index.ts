/**
 * 3D flow field around the solved wing: Biot-Savart velocity from the vortex lattice plus
 * thickness line-sources, a uniform grid for particles, solid mask, and streamline tracing.
 * OWNER: physics-flow agent. CONTRACT — keep the exported signatures.
 * Everything here is in the TUNNEL frame, meters, m/s.
 *
 * Thickness sources: the VLM leaves `lattice.sources` empty. buildFlowFieldGrid and
 * traceStreamlines then build them from the geometry automatically (without mutating the
 * lattice). velocityAt uses exactly the sources the lattice carries; assign
 * `lattice.sources = buildThicknessSources(geometry, alpha, vInf)` to include thickness there.
 */
import type { VortexLattice, WingGeometry } from '../types';
import { addInducedExact, getCompiledLattice } from './lattice';
import { getWingSolid } from './solid';

export { buildThicknessSources, withThicknessSources } from './sources';
export { createWingSolidTester } from './solid';
export { buildFlowFieldGrid, sampleGrid } from './grid';
export type { GridOptions } from './grid';
export { seedStreamlines, traceStreamlines } from './streamlines';
export type { StreamlineSeeds } from './streamlines';

const acc = new Float64Array(3);

/** Velocity (freestream vInf along +x plus induced) at (x,y,z). Writes into out[0..2]. */
export function velocityAt(
  lattice: VortexLattice,
  vInf: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array | number[],
): void {
  const c = getCompiledLattice(lattice);
  acc[0] = vInf;
  acc[1] = 0;
  acc[2] = 0;
  addInducedExact(c, x, y, z, acc);
  out[0] = acc[0];
  out[1] = acc[1];
  out[2] = acc[2];
}

/** True when the tunnel-frame point lies inside the (pitched) wing or a tip device. */
export function isInsideWing(
  geometry: WingGeometry,
  alpha: number,
  x: number,
  y: number,
  z: number,
): boolean {
  return getWingSolid(geometry, alpha).contains(x, y, z);
}
