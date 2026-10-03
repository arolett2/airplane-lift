import { describe, expect, it } from 'vitest';
import { freestreamTransitTime, simSecondsPerSecond } from './playback';
import { tunnelDomain } from '../../physics/domain';

describe('simSecondsPerSecond', () => {
  const domain = {
    min: [-10, -5, -3] as [number, number, number],
    max: [30, 5, 3] as [number, number, number],
  };

  it('lets air cross the tunnel in 4 real seconds at playback speed 1', () => {
    const vInf = 20;
    const rate = simSecondsPerSecond(domain, vInf, 1);
    // 4 real seconds * rate sim seconds = the physical crossing time 40 m / 20 m/s = 2 s.
    expect(4 * rate).toBeCloseTo(freestreamTransitTime(domain, vInf), 12);
    expect(rate).toBeCloseTo(0.5, 12);
  });

  it('follows the documented formula', () => {
    const rate = simSecondsPerSecond(domain, 8, 0.5);
    expect(rate).toBeCloseTo((40 / 8 / 4) * 0.5, 12);
  });

  it('scales linearly with playback speed and is paused at zero', () => {
    const base = simSecondsPerSecond(domain, 25, 1);
    expect(simSecondsPerSecond(domain, 25, 2)).toBeCloseTo(2 * base, 12);
    expect(simSecondsPerSecond(domain, 25, 0.05)).toBeCloseTo(0.05 * base, 12);
    expect(simSecondsPerSecond(domain, 25, 0)).toBe(0);
  });

  it('survives a zero airspeed', () => {
    const rate = simSecondsPerSecond(domain, 0, 1);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeGreaterThan(0);
  });

  it('is faster in simulated time for slow aircraft over the same tunnel length', () => {
    const d = tunnelDomain(10, 1.5);
    expect(simSecondsPerSecond(d, 30, 1)).toBeGreaterThan(simSecondsPerSecond(d, 250, 1));
  });
});
