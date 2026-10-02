/**
 * International Standard Atmosphere (troposphere + lower stratosphere, 0..20 km).
 * OWNER: physics-geometry agent. CONTRACT — keep the exported signatures.
 */
import type { AtmosphereState } from './types';
import { notImplemented } from '../shared/notImplemented';

export const isaAtmosphere: (altitude: number) => AtmosphereState = notImplemented('isaAtmosphere');

/** Reynolds number rho V L / mu. */
export function reynoldsNumber(atm: AtmosphereState, velocity: number, length: number): number {
  return (atm.density * velocity * length) / atm.dynamicViscosity;
}
