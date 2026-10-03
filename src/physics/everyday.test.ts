import { describe, expect, it } from 'vitest';
import {
  bernoulliPressure,
  momentumEstimate,
  prandtlGlauertFactor,
  pressureAtSpeed,
  pressureFromCp,
  pressurePush,
  staticPressureFromSpeed,
} from './everyday';
import { isaAtmosphere } from './atmosphere';

describe('staticPressureFromSpeed (isentropic)', () => {
  const p0 = 101325;

  it('is the freestream pressure at the freestream speed', () => {
    expect(staticPressureFromSpeed(1, 0.5, p0)).toBeCloseTo(p0, 6);
  });

  it('reduces to Bernoulli at low Mach', () => {
    const atm = isaAtmosphere(0);
    const v = 30;
    const mach = v / atm.speedOfSound;
    const q = 0.5 * atm.density * v * v;
    for (const r of [0, 0.6, 1.2, 1.5]) {
      const exact = staticPressureFromSpeed(r, mach, atm.pressure);
      const bern = bernoulliPressure(r, q, atm.pressure);
      // The difference is about q M² (1 − r²)² / 4: under 0.5% of q at Mach 0.09.
      expect(Math.abs(exact - bern)).toBeLessThan(0.005 * q);
    }
  });

  it('gives the isentropic stagnation pressure where the air stops', () => {
    const m = 0.78;
    const ratio = staticPressureFromSpeed(0, m, p0) / p0;
    expect(ratio).toBeCloseTo(Math.pow(1 + 0.2 * m * m, 3.5), 9);
  });

  it('falls with speed and never goes negative', () => {
    expect(staticPressureFromSpeed(1.2, 0.78, p0)).toBeLessThan(p0);
    expect(staticPressureFromSpeed(1.2, 0.78, p0)).toBeGreaterThan(0);
    expect(staticPressureFromSpeed(50, 0.9, p0)).toBe(0);
  });
});

describe('pressure helpers', () => {
  it('expresses the change as a fraction of the surrounding pressure', () => {
    const p = pressureAtSpeed(1.1, 0.2, 100_000);
    expect(p.delta).toBeLessThan(0);
    expect(p.fraction).toBeCloseTo(p.delta / 100_000, 12);
  });

  it('turns Cp into a pressure change with the dynamic pressure', () => {
    const p = pressureFromCp(-0.5, 2000, 100_000);
    expect(p.delta).toBe(-1000);
    expect(p.fraction).toBeCloseTo(-0.01, 12);
  });

  it('Prandtl–Glauert factor: 1 at rest, 1/0.6 at Mach 0.8, capped near Mach 1', () => {
    expect(prandtlGlauertFactor(0)).toBe(1);
    expect(prandtlGlauertFactor(0.8)).toBeCloseTo(1 / 0.6, 9);
    expect(Number.isFinite(prandtlGlauertFactor(1.2))).toBe(true);
  });
});

describe('pressurePush (wing loading)', () => {
  it('is lift per area, as kg per square metre and as a share of the atmosphere', () => {
    // A 737-800 in cruise: ~65 t on 125 m² -> ~520 kg/m², ~5.1 kPa, ~21% of p at 35,000 ft.
    const atm = isaAtmosphere(10668);
    const lift = 65_000 * 9.80665;
    const push = pressurePush(lift, 124.6, atm.pressure);
    expect(push.massPerArea).toBeCloseTo(65_000 / 124.6, 6);
    expect(push.meanDelta).toBeCloseTo(lift / 124.6, 6);
    expect(push.fractionOfAtmosphere).toBeGreaterThan(0.18);
    expect(push.fractionOfAtmosphere).toBeLessThan(0.24);
  });

  it('is negative for negative lift', () => {
    expect(pressurePush(-1000, 10, 1e5).massPerArea).toBeLessThan(0);
  });
});

describe('momentumEstimate (air thrown down)', () => {
  it('ṁ = ρVπb²/4 and ṁ·w equals the lift', () => {
    const m = momentumEstimate(600_000, 0.38, 230, 34.3);
    expect(m.massFlow).toBeCloseTo((0.38 * 230 * Math.PI * 34.3 * 34.3) / 4, 6);
    expect(m.massFlow * m.downwash).toBeCloseTo(600_000, 3);
    // Tens of tonnes a second at a few metres per second.
    expect(m.massFlow).toBeGreaterThan(50_000);
    expect(m.downwash).toBeGreaterThan(5);
    expect(m.downwash).toBeLessThan(12);
  });

  it('matches the elliptic-wing far-wake downwash, twice the induced downwash at the wing', () => {
    // Elliptic wing: w_wing = CL V / (π AR); far wake w = 2 w_wing.
    const rho = 1.225;
    const v = 60;
    const b = 10;
    const area = 15;
    const cl = 0.6;
    const lift = 0.5 * rho * v * v * area * cl;
    const ar = (b * b) / area;
    const wWing = (cl * v) / (Math.PI * ar);
    expect(momentumEstimate(lift, rho, v, b).downwash).toBeCloseTo(2 * wWing, 9);
  });

  it('zero lift throws nothing; negative lift throws air up', () => {
    expect(momentumEstimate(0, 1.2, 50, 10).downwash).toBe(0);
    expect(momentumEstimate(-500, 1.2, 50, 10).downwash).toBeLessThan(0);
    expect(Number.isNaN(momentumEstimate(500, 1.2, 0, 10).downwash)).toBe(true);
  });
});
