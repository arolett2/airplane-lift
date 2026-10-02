/**
 * 3D flow field around the solved wing: Biot-Savart velocity from the vortex lattice plus
 * thickness line-sources, a uniform grid for particles, solid mask, and streamline tracing.
 * OWNER: physics-flow agent. CONTRACT — keep the exported signatures.
 * Everything here is in the TUNNEL frame, meters, m/s.
 */
import type { FlowFieldGrid, Streamline3D, VortexLattice, WingGeometry } from '../types';
import type { TunnelDomain } from '../domain';
import type { RakeConfig } from '../../state/params';
import { notImplemented } from '../../shared/notImplemented';

/** Velocity (freestream vInf along +x plus induced) at (x,y,z). Writes into out[0..2]. */
export const velocityAt: (
  lattice: VortexLattice,
  vInf: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array | number[],
) => void = notImplemented('velocityAt');

/**
 * Spanwise line sources that displace the flow around the wing's thickness
 * (thin-airfoil thickness theory: source strength per unit chord = V_inf * dT/dx).
 */
export const buildThicknessSources: (
  geometry: WingGeometry,
  alpha: number,
  vInf: number,
) => VortexLattice['sources'] = notImplemented('buildThicknessSources');

/** True when the tunnel-frame point lies inside the (pitched) wing or a tip device. */
export const isInsideWing: (
  geometry: WingGeometry,
  alpha: number,
  x: number,
  y: number,
  z: number,
) => boolean = notImplemented('isInsideWing');

export interface GridOptions {
  domain: TunnelDomain;
  /** Approximate total node count (default 120_000); dims are chosen to keep cells ~cubic. */
  targetNodes?: number;
}

export const buildFlowFieldGrid: (
  lattice: VortexLattice,
  vInf: number,
  geometry: WingGeometry,
  alpha: number,
  options: GridOptions,
  requestId: number,
) => FlowFieldGrid = notImplemented('buildFlowFieldGrid');

/** Trilinear sample. Returns false (and writes freestream) when outside the grid. */
export const sampleGrid: (
  grid: FlowFieldGrid,
  x: number,
  y: number,
  z: number,
  out: Float64Array | number[],
) => boolean = notImplemented('sampleGrid');

export interface StreamlineSeeds {
  /** Interleaved xyz seed points. */
  points: Float32Array;
  group: Streamline3D['group'];
}

/** Seed points for the smoke rake (vertical / horizontal / tip-vortex modes), upstream of the wing. */
export const seedStreamlines: (
  geometry: WingGeometry,
  alpha: number,
  rake: RakeConfig,
  domain: TunnelDomain,
) => StreamlineSeeds[] = notImplemented('seedStreamlines');

/** Integrate streamlines (RK4, adaptive step) through the exact vortex model until they leave the domain. */
export const traceStreamlines: (
  lattice: VortexLattice,
  vInf: number,
  seeds: StreamlineSeeds[],
  domain: TunnelDomain,
  geometry: WingGeometry,
  alpha: number,
) => Streamline3D[] = notImplemented('traceStreamlines');
