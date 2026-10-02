import { describe, expect, it } from 'vitest';
import { isaAtmosphere, reynoldsNumber } from './atmosphere';

/** Standard Atmosphere table values (ICAO Doc 7488 / US Standard Atmosphere 1976). */
const TABLE: {
  h: number;
  T: number;
  p: number;
  rho: number;
  a: number;
}[] = [
  { h: 0, T: 288.15, p: 101325, rho: 1.225, a: 340.294 },
  { h: 1000, T: 281.65, p: 89874.6, rho: 1.1117, a: 336.434 },
  { h: 5000, T: 255.65, p: 54019.9, rho: 0.73612, a: 320.529 },
  { h: 10000, T: 223.15, p: 26436.3, rho: 0.41271, a: 299.532 },
  { h: 11000, T: 216.65, p: 22632.1, rho: 0.36392, a: 295.069 },
  { h: 15000, T: 216.65, p: 12044.6, rho: 0.19367, a: 295.069 },
  { h: 20000, T: 216.65, p: 5474.89, rho: 0.088035, a: 295.069 },
];

describe('isaAtmosphere', () => {
  it.each(TABLE)('matches the standard table at $h m', ({ h, T, p, rho, a }) => {
    const atm = isaAtmosphere(h);
    expect(atm.altitude).toBe(h);
    expect(atm.temperature).toBeCloseTo(T, 2);
    expect(atm.pressure / p).toBeCloseTo(1, 3);
    expect(atm.density / rho).toBeCloseTo(1, 3);
    expect(atm.speedOfSound).toBeCloseTo(a, 0);
  });

  it('has the well-known sea-level values', () => {
    const atm = isaAtmosphere(0);
    expect(atm.density).toBeCloseTo(1.225, 3);
    expect(atm.speedOfSound).toBeCloseTo(340.29, 1);
    expect(atm.pressure).toBeCloseTo(101325, 6);
    expect(atm.temperature).toBeCloseTo(288.15, 10);
  });

  it('has the tropopause values at 11 km', () => {
    const atm = isaAtmosphere(11000);
    expect(atm.temperature).toBeCloseTo(216.65, 6);
    expect(atm.density).toBeCloseTo(0.3639, 3);
    expect(atm.pressure).toBeCloseTo(22632, -1);
  });

  it('is isothermal between 11 and 20 km', () => {
    for (const h of [11001, 13000, 16000, 20000]) {
      expect(isaAtmosphere(h).temperature).toBeCloseTo(216.65, 10);
    }
  });

  it('is continuous across the tropopause', () => {
    const below = isaAtmosphere(10999.9);
    const above = isaAtmosphere(11000.1);
    expect(above.temperature).toBeCloseTo(below.temperature, 2);
    expect(above.pressure / below.pressure).toBeCloseTo(1, 4);
    expect(above.density / below.density).toBeCloseTo(1, 4);
  });

  it('computes density from the ideal-gas law', () => {
    for (const h of [0, 3000, 9000, 12000, 18000]) {
      const atm = isaAtmosphere(h);
      expect(atm.density).toBeCloseTo(atm.pressure / (287.05287 * atm.temperature), 10);
    }
  });

  it('gives Sutherland viscosity of about 1.789e-5 Pa s at sea level', () => {
    expect(isaAtmosphere(0).dynamicViscosity).toBeCloseTo(1.7894e-5, 8);
    // Colder air is less viscous.
    expect(isaAtmosphere(11000).dynamicViscosity).toBeCloseTo(1.4216e-5, 8);
  });

  it('decreases density monotonically with altitude', () => {
    let previous = Infinity;
    for (let h = -500; h <= 20000; h += 250) {
      const rho = isaAtmosphere(h).density;
      expect(rho).toBeLessThan(previous);
      previous = rho;
    }
  });

  it('clamps altitude to [-500, 20000] m', () => {
    expect(isaAtmosphere(-5000).altitude).toBe(-500);
    expect(isaAtmosphere(-5000).density).toBeCloseTo(isaAtmosphere(-500).density, 12);
    expect(isaAtmosphere(50000).altitude).toBe(20000);
    expect(isaAtmosphere(50000).pressure).toBeCloseTo(isaAtmosphere(20000).pressure, 6);
    // Below sea level the air is slightly denser than standard sea level.
    expect(isaAtmosphere(-500).density).toBeGreaterThan(1.225);
  });

  it('never returns NaN, even for non-finite input', () => {
    for (const h of [NaN, Infinity, -Infinity]) {
      const atm = isaAtmosphere(h);
      for (const v of Object.values(atm)) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('reynoldsNumber', () => {
  it('is rho V L / mu', () => {
    const atm = isaAtmosphere(0);
    const re = reynoldsNumber(atm, 50, 2);
    expect(re).toBeCloseTo((1.225 * 50 * 2) / 1.7894e-5, -3);
    // About 6.8 million for a Cessna-sized wing at 50 m/s.
    expect(re).toBeGreaterThan(6e6);
    expect(re).toBeLessThan(7.5e6);
  });
});
