import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  UNIT_SYSTEMS,
  defaultDigits,
  formatAltitude,
  formatAngle,
  formatArea,
  formatForce,
  formatLength,
  formatMass,
  formatNumber,
  formatParts,
  formatQuantity,
  formatSpeed,
  massSupportedByLift,
  sigDecimals,
  unitFor,
  weightOfMass,
} from './units';
import type { QuantityKind } from './units';

describe('unitFor conversions', () => {
  it('converts speed to knots, km/h and mph', () => {
    expect(unitFor('speed', 'aviation').toDisplay(100)).toBeCloseTo(194.384, 2);
    expect(unitFor('speed', 'metric').toDisplay(100)).toBeCloseTo(360, 9);
    expect(unitFor('speed', 'imperial').toDisplay(100)).toBeCloseTo(223.694, 2);
    expect(unitFor('speed', 'aviation').symbol).toBe('kt');
    expect(unitFor('speed', 'metric').symbol).toBe('km/h');
    expect(unitFor('speed', 'imperial').symbol).toBe('mph');
  });

  it('converts altitude and length to feet', () => {
    expect(unitFor('altitude', 'aviation').toDisplay(3048)).toBeCloseTo(10000, 6);
    expect(unitFor('altitude', 'metric').toDisplay(3048)).toBe(3048);
    expect(unitFor('length', 'imperial').toDisplay(0.3048)).toBeCloseTo(1, 9);
    expect(unitFor('length', 'aviation').symbol).toBe('ft');
    expect(unitFor('length', 'metric').symbol).toBe('m');
  });

  it('converts force to kN or lbf', () => {
    expect(unitFor('force', 'aviation').toDisplay(5000)).toBe(5);
    expect(unitFor('force', 'metric').toDisplay(5000)).toBe(5);
    expect(unitFor('force', 'imperial').toDisplay(4.4482216152605)).toBeCloseTo(1, 9);
    expect(unitFor('force', 'imperial').symbol).toBe('lbf');
  });

  it('converts area and mass', () => {
    expect(unitFor('area', 'metric').toDisplay(10)).toBe(10);
    expect(unitFor('area', 'imperial').toDisplay(1)).toBeCloseTo(10.7639, 3);
    expect(unitFor('mass', 'aviation').toDisplay(74000)).toBeCloseTo(74, 9);
    expect(unitFor('mass', 'imperial').toDisplay(1000)).toBeCloseTo(2204.62, 1);
  });

  it('round-trips every kind and system', () => {
    const kinds: QuantityKind[] = [
      'speed',
      'altitude',
      'length',
      'force',
      'area',
      'mass',
      'angle',
      'ratio',
      'percent',
      'multiplier',
    ];
    for (const kind of kinds) {
      for (const system of UNIT_SYSTEMS) {
        const def = unitFor(kind, system);
        for (const si of [0, 0.37, 12.5, 4000]) {
          expect(def.fromDisplay(def.toDisplay(si))).toBeCloseTo(si, 9);
        }
      }
    }
  });
});

describe('formatting', () => {
  it('formats speeds with units', () => {
    expect(formatSpeed(77.17, 'aviation')).toBe('150 kt');
    expect(formatSpeed(250, 'metric')).toBe('900 km/h');
    expect(formatSpeed(100, 'imperial')).toBe('224 mph');
  });

  it('formats altitude with grouping', () => {
    expect(formatAltitude(10668, 'aviation')).toBe('35,000 ft');
    expect(formatAltitude(10668, 'metric')).toBe('10,668 m');
  });

  it('formats length with about three significant digits', () => {
    expect(formatLength(35.8, 'metric')).toBe('35.8 m');
    expect(formatLength(1.5, 'metric')).toBe('1.50 m');
    expect(formatLength(64.4, 'metric')).toBe('64.4 m');
    expect(formatLength(117.5, 'imperial')).toBe('385 ft');
  });

  it('formats force in kN and lbf', () => {
    expect(formatForce(152300, 'metric')).toBe('152 kN');
    expect(formatForce(15230, 'aviation')).toBe('15.2 kN');
    expect(formatForce(900, 'aviation')).toBe('0.900 kN');
    expect(formatForce(10000, 'imperial')).toBe('2,248 lbf');
  });

  it('formats area and mass', () => {
    expect(formatArea(124.6, 'metric')).toBe('125 m²');
    expect(formatArea(124.6, 'imperial')).toBe('1,341 ft²');
    expect(formatMass(74000, 'aviation')).toBe('74.0 t');
    expect(formatMass(74000, 'imperial')).toBe('163,142 lb');
  });

  it('formats angles and attaches the degree sign', () => {
    expect(formatAngle(5)).toBe('5.0°');
    expect(formatAngle(-2.46)).toBe('-2.5°');
  });

  it('formats percents and multipliers without a space', () => {
    expect(formatQuantity('percent', 0.35, 'metric')).toBe('35%');
    expect(formatQuantity('multiplier', 1.5, 'metric')).toBe('1.50×');
    expect(formatQuantity('ratio', 0.35, 'metric')).toBe('0.35');
  });

  it('supports overriding digits and splitting value from unit', () => {
    expect(formatParts('force', 152300, 'metric', { digits: 1 })).toEqual({
      value: '152.3',
      unit: 'kN',
    });
    expect(formatQuantity('speed', 150 * (1852 / 3600), 'aviation', { digits: 2 })).toBe(
      '150.00 kt',
    );
  });

  it('never prints negative zero or NaN', () => {
    expect(formatNumber(-0.0001, 1)).toBe('0.0');
    expect(formatNumber(Number.NaN, 2)).toBe('–');
    expect(formatNumber(Infinity, 2)).toBe('–');
    expect(formatNumber(1234.5, 0, { grouping: false })).toBe('1235');
  });

  it('chooses decimals by magnitude', () => {
    expect(sigDecimals(1234)).toBe(0);
    expect(sigDecimals(123)).toBe(0);
    expect(sigDecimals(12.3)).toBe(1);
    expect(sigDecimals(1.23)).toBe(2);
    expect(sigDecimals(0.123)).toBe(3);
    expect(sigDecimals(0.001)).toBe(3);
    expect(defaultDigits('speed', 150)).toBe(0);
  });
});

describe('lift and weight helpers', () => {
  it('converts between force and mass using standard gravity', () => {
    expect(massSupportedByLift(GRAVITY * 1000)).toBeCloseTo(1000, 9);
    expect(weightOfMass(1000)).toBeCloseTo(9806.65, 6);
  });
});
