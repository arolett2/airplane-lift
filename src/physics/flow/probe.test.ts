import { describe, expect, it } from 'vitest';
import { computeAero, createAeroCache } from '../aero';
import { DEFAULT_FLOW, DEFAULT_WING } from '../../state/params';
import type { Vec3 } from '../types';
import { probeFlow } from './probe';

describe('probeFlow (3D probe)', () => {
  const cache = createAeroCache();
  const { geometry, aero } = computeAero(DEFAULT_WING, { ...DEFAULT_FLOW, alphaDeg: 6 }, 1, cache);
  const strip = aero.strips.find((s) => s.side === 'right' && s.eta > 0.3 && s.eta < 0.45)!;
  const along = (d: number): Vec3 => [
    strip.center[0] + strip.normal[0] * d * strip.chord,
    strip.center[1] + strip.normal[1] * d * strip.chord,
    strip.center[2] + strip.normal[2] * d * strip.chord,
  ];

  it('finds faster air and lower pressure just above the wing', () => {
    const p = probeFlow(geometry, aero, along(0.12));
    expect(p.inside).toBe(false);
    expect(p.speedRatio).toBeGreaterThan(1.1);
    expect(p.deltaPressure).toBeLessThan(0);
    expect(p.pressureFraction).toBeCloseTo(p.deltaPressure / aero.atmosphere.pressure, 12);
  });

  it('finds slower air and higher pressure just below it', () => {
    const p = probeFlow(geometry, aero, along(-0.12));
    expect(p.inside).toBe(false);
    expect(p.speedRatio).toBeLessThan(1);
    expect(p.deltaPressure).toBeGreaterThan(0);
  });

  it('reports "inside the wing" for a point in the wing', () => {
    const p = probeFlow(geometry, aero, along(0));
    expect(p.inside).toBe(true);
    expect(Number.isNaN(p.speedRatio)).toBe(true);
  });

  it('is the undisturbed air far upstream', () => {
    const p = probeFlow(geometry, aero, [-200, 0, 0]);
    expect(p.speedRatio).toBeCloseTo(1, 3);
    expect(Math.abs(p.pressureFraction)).toBeLessThan(1e-4);
  });

  it('agrees with Bernoulli at this low speed', () => {
    const p = probeFlow(geometry, aero, along(0.12));
    const bern = aero.dynamicPressure * (1 - p.speedRatio * p.speedRatio);
    expect(Math.abs(p.deltaPressure - bern)).toBeLessThan(0.01 * aero.dynamicPressure);
  });
});
