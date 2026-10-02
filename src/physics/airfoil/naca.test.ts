import { describe, expect, it } from 'vitest';
import { camberLine, generateAirfoil, nacaCamber, nacaHalfThickness, nacaName } from './naca';

const naca2412 = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };

describe('naca', () => {
  it('has maximum thickness ~t at x = 0.3', () => {
    expect(2 * nacaHalfThickness(0.12, 0.3)).toBeCloseTo(0.12, 2);
    expect(nacaHalfThickness(0.12, 1)).toBeCloseTo(0, 10);
  });

  it('has maximum camber m at x = p with zero slope', () => {
    const c = nacaCamber(naca2412, 0.4);
    expect(c.yc).toBeCloseTo(0.02, 12);
    expect(c.slope).toBeCloseTo(0, 12);
  });

  it('builds a closed contour TE -> lower -> LE -> upper -> TE', () => {
    const g = generateAirfoil(naca2412, 100);
    const n = g.nPoints;
    expect(g.coords[0]).toBeCloseTo(1, 6);
    expect(g.coords[2 * (n - 1)]).toBe(g.coords[0]);
    expect(g.coords[2 * g.leIndex]).toBeCloseTo(0, 6);
    // Point a quarter of the way round is on the lower surface (below camber), three-quarters on upper.
    const lower = g.coords[2 * Math.floor(n / 4) + 1]!;
    const upper = g.coords[2 * Math.floor((3 * n) / 4) + 1]!;
    expect(upper).toBeGreaterThan(lower);
  });

  it('deflects the trailing edge down with a flap', () => {
    const flap = { chordFrac: 0.25, deflection: (20 * Math.PI) / 180 };
    const te = camberLine(naca2412, flap, 1);
    expect(te.yc).toBeLessThan(-0.25 * Math.tan(flap.deflection) * 0.8);
    expect(camberLine(naca2412, flap, 0.5).yc).toBeCloseTo(nacaCamber(naca2412, 0.5).yc, 12);
  });

  it('names sections', () => {
    expect(nacaName(naca2412)).toBe('NACA 2412');
    expect(nacaName({ camber: 0, camberPos: 0.4, thickness: 0.09 })).toBe('NACA 0009');
  });
});
