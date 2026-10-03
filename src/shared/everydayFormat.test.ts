import { describe, expect, it } from 'vitest';
import {
  describeDirection,
  describePressureFraction,
  describeSpeedRatio,
  formatAirMass,
  formatDownwashSpeed,
  formatPercent,
  formatPressure,
  formatPressureChange,
  formatPushPerArea,
  probeText,
  roundSig,
} from './everydayFormat';

const DEG = Math.PI / 180;

describe('everyday wording', () => {
  it('formats percentages with sensible precision', () => {
    expect(formatPercent(0.123)).toBe('12%');
    expect(formatPercent(-0.018)).toBe('1.8%');
    expect(formatPercent(0.0004)).toBe('0.04%');
  });

  it('compares the speed with the wind', () => {
    expect(describeSpeedRatio(1.12)).toBe('12% faster than the wind');
    expect(describeSpeedRatio(0.65)).toBe('35% slower than the wind');
    expect(describeSpeedRatio(1.002)).toBe('the same speed as the wind');
    expect(describeSpeedRatio(0.01)).toBe('almost still');
  });

  it('compares the pressure with the surrounding air', () => {
    expect(describePressureFraction(-0.018)).toBe('1.8% below the air around it');
    expect(describePressureFraction(0.006)).toBe('0.6% above the air around it');
    expect(describePressureFraction(1e-6)).toBe('the same as the air around it');
  });

  it('gives pressure in kPa, or psi for imperial', () => {
    expect(formatPressureChange(-1940, 'metric')).toBe('−1.9 kPa');
    expect(formatPressureChange(250, 'aviation')).toBe('+0.25 kPa');
    expect(formatPressureChange(-1940, 'imperial')).toBe('−0.28 psi');
    expect(formatPressureChange(0, 'metric')).toBe('0.0 kPa');
    expect(formatPressure(23842, 'aviation')).toBe('24 kPa');
    expect(formatPressure(101325, 'imperial')).toBe('15 psi');
  });

  it('describes the flow direction', () => {
    expect(describeDirection(4 * DEG)).toBe('4.0° upward');
    expect(describeDirection(-12 * DEG)).toBe('12° downward');
    expect(describeDirection(0.1 * DEG)).toBe('level');
    expect(describeDirection(-6 * DEG, 2 * DEG)).toBe('6.0° downward, 2.0° toward the tip');
    expect(describeDirection(-6 * DEG, -3 * DEG)).toBe('6.0° downward, 3.0° toward the body');
    expect(describeDirection(NaN)).toBe('almost still');
  });

  it('builds the probe readout, and says when it is inside the wing', () => {
    const t = probeText(
      {
        inside: false,
        speedRatio: 1.12,
        vInf: 100,
        deltaPressure: -1500,
        pressureFraction: -0.0148,
        angleUp: 3 * DEG,
      },
      'metric',
    );
    expect(t.speed).toBe('403 km/h');
    expect(t.speedCompare).toBe('12% faster than the wind');
    expect(t.pressure).toBe('1.5% below the air around it');
    expect(t.pressureValue).toBe('−1.5 kPa');
    expect(t.direction).toBe('3.0° upward');
    expect(t.summary).toContain('403 km/h');
    const inside = probeText(
      {
        inside: true,
        speedRatio: NaN,
        vInf: 1,
        deltaPressure: NaN,
        pressureFraction: NaN,
        angleUp: NaN,
      },
      'metric',
    );
    expect(inside.speed).toBe('Inside the wing');
  });

  it('turns wing loading into a weight per area', () => {
    expect(formatPushPerArea(521.6, 'metric')).toBe('520 kg on every square metre');
    expect(formatPushPerArea(521.6, 'imperial')).toBe('110 lb on every square foot');
    expect(formatPushPerArea(-48, 'aviation')).toBe('48 kg on every square metre');
  });

  it('formats air mass flow and downwash speed', () => {
    expect(formatAirMass(80_800, 'aviation')).toBe('81 tonnes');
    expect(formatAirMass(2_340, 'metric')).toBe('2.3 tonnes');
    expect(formatAirMass(80_800, 'imperial')).toBe('180,000 lb');
    expect(formatDownwashSpeed(7.9, 'metric')).toBe('7.9 m/s');
    expect(formatDownwashSpeed(7.9, 'aviation')).toBe('15 kt');
    expect(formatDownwashSpeed(-2, 'imperial')).toBe('4.5 mph');
    expect(roundSig(0.0123, 2)).toBeCloseTo(0.012, 12);
  });
});
