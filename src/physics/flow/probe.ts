/**
 * Flow probe: the exact flow model (Biot–Savart from the vortex lattice plus thickness sources)
 * evaluated at one tunnel-frame point, with the local static pressure from the isentropic
 * relation (see physics/everyday.ts). Used by the 3D probe through the worker.
 */
import type { AeroResult, Vec3, WingGeometry } from '../types';
import { pressureAtSpeed } from '../everyday';
import { isInsideWing, velocityAt } from './index';
import { withThicknessSources } from './sources';

export interface FlowProbeSample {
  /** Tunnel-frame point (m). */
  point: Vec3;
  /** True when the point lies inside the wing: no air there, all other fields are NaN. */
  inside: boolean;
  /** Local velocity (m/s, tunnel frame). */
  velocity: Vec3;
  /** |V| / V∞. */
  speedRatio: number;
  /** Static pressure (Pa). */
  pressure: number;
  /** Change from the surrounding air pressure (Pa). */
  deltaPressure: number;
  /** deltaPressure / p∞. */
  pressureFraction: number;
  /** Freestream static pressure (Pa) and speed (m/s) used, so readouts need nothing else. */
  pInf: number;
  vInf: number;
}

const scratch = new Float64Array(3);

/** Probe the solved flow around `geometry` (pitched by aero.alpha) at `point`. */
export function probeFlow(geometry: WingGeometry, aero: AeroResult, point: Vec3): FlowProbeSample {
  const [x, y, z] = point;
  const vInf = aero.velocity;
  const pInf = aero.atmosphere.pressure;
  if (isInsideWing(geometry, aero.alpha, x, y, z)) {
    return {
      point: [x, y, z],
      inside: true,
      velocity: [NaN, NaN, NaN],
      speedRatio: NaN,
      pressure: NaN,
      deltaPressure: NaN,
      pressureFraction: NaN,
      pInf,
      vInf,
    };
  }
  const lattice = withThicknessSources(aero.lattice, geometry, aero.alpha, vInf);
  velocityAt(lattice, vInf, x, y, z, scratch);
  const velocity: Vec3 = [scratch[0]!, scratch[1]!, scratch[2]!];
  const speedRatio = vInf > 0 ? Math.hypot(...velocity) / vInf : NaN;
  const p = pressureAtSpeed(speedRatio, aero.mach, pInf);
  return {
    point: [x, y, z],
    inside: false,
    velocity,
    speedRatio,
    pressure: p.pressure,
    deltaPressure: p.delta,
    pressureFraction: p.fraction,
    pInf,
    vInf,
  };
}
