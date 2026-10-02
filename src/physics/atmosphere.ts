/**
 * International Standard Atmosphere (troposphere + lower stratosphere, 0..20 km).
 * OWNER: physics-geometry agent. CONTRACT — keep the exported signatures.
 *
 * Layers:
 *   0 .. 11 km    temperature falls linearly at 6.5 K per km from 288.15 K, pressure 101325 Pa
 *   11 .. 20 km   isothermal at 216.65 K, pressure decays exponentially
 * Density follows from the ideal-gas law, speed of sound from sqrt(gamma R T), and viscosity
 * from Sutherland's law.
 */
import type { AtmosphereState } from './types';

/** Lowest / highest altitude (m) the model accepts; inputs are clamped to this range. */
export const ISA_MIN_ALTITUDE = -500;
export const ISA_MAX_ALTITUDE = 20000;

/** Sea-level standard values. */
export const ISA_SEA_LEVEL_TEMPERATURE = 288.15; // K
export const ISA_SEA_LEVEL_PRESSURE = 101325; // Pa

/** Specific gas constant of dry air (J / (kg K)). */
const R_AIR = 287.05287;
/** Ratio of specific heats for air. */
const GAMMA = 1.4;
/** Standard gravity (m/s^2). */
const G0 = 9.80665;
/** Temperature lapse rate in the troposphere (K/m). */
const LAPSE = 0.0065;
/** Tropopause altitude (m) and its (constant) stratospheric temperature (K). */
const TROPOPAUSE = 11000;
const T_TROPOPAUSE = ISA_SEA_LEVEL_TEMPERATURE - LAPSE * TROPOPAUSE; // 216.65 K
/** Barometric exponent g / (L R) of the tropospheric layer. */
const BARO_EXPONENT = G0 / (LAPSE * R_AIR);
/** Pressure at the tropopause (Pa). */
const P_TROPOPAUSE =
  ISA_SEA_LEVEL_PRESSURE * Math.pow(T_TROPOPAUSE / ISA_SEA_LEVEL_TEMPERATURE, BARO_EXPONENT);

/** Sutherland's law constants for air: mu = MU_REF * T^1.5 / (T + S). */
const SUTHERLAND_MU_REF = 1.458e-6; // kg / (m s sqrt(K))
const SUTHERLAND_S = 110.4; // K

/**
 * ISA state at a geometric altitude (m). Altitudes outside [-500, 20000] m are clamped, and the
 * returned `altitude` is the clamped value.
 */
export function isaAtmosphere(altitude: number): AtmosphereState {
  const h = Number.isFinite(altitude)
    ? Math.min(ISA_MAX_ALTITUDE, Math.max(ISA_MIN_ALTITUDE, altitude))
    : 0;

  let temperature: number;
  let pressure: number;
  if (h <= TROPOPAUSE) {
    temperature = ISA_SEA_LEVEL_TEMPERATURE - LAPSE * h;
    pressure =
      ISA_SEA_LEVEL_PRESSURE * Math.pow(temperature / ISA_SEA_LEVEL_TEMPERATURE, BARO_EXPONENT);
  } else {
    temperature = T_TROPOPAUSE;
    pressure = P_TROPOPAUSE * Math.exp((-G0 * (h - TROPOPAUSE)) / (R_AIR * T_TROPOPAUSE));
  }

  const density = pressure / (R_AIR * temperature);
  const speedOfSound = Math.sqrt(GAMMA * R_AIR * temperature);
  const dynamicViscosity =
    (SUTHERLAND_MU_REF * Math.pow(temperature, 1.5)) / (temperature + SUTHERLAND_S);

  return { altitude: h, temperature, pressure, density, speedOfSound, dynamicViscosity };
}

/** Reynolds number rho V L / mu. */
export function reynoldsNumber(atm: AtmosphereState, velocity: number, length: number): number {
  return (atm.density * velocity * length) / atm.dynamicViscosity;
}
