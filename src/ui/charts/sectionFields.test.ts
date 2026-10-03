import { describe, expect, it } from 'vitest';
import {
  circulationAround,
  contourSegments,
  disturbanceArrows,
  disturbanceGain,
  farFieldDisturbance,
  fillTerrainImage,
  insideContour,
  niceFloor,
  probeSection,
  sampleCpRaster,
  sampleSection,
  terrainColor,
  terrainHeight,
  TERRAIN_LEVELS,
  TERRAIN_STEP,
  terrainHeights,
} from './sectionFields';
import { displayX, displayY } from './sectionMath';
import { DEG, ellipseVelocity, makeSection } from './testFixtures';

const alpha = 4 * DEG;
const section = makeSection({ alphaEffective: alpha });
const c = Math.cos(alpha);
const s = Math.sin(alpha);
/** Display-frame coordinates of an airfoil-frame point. */
const disp = (x: number, y: number): [number, number] => [
  displayX(c, s, x, y),
  displayY(c, s, x, y),
];
const free = { vInf: 60, mach: 60 / 340, pInf: 101325, q: 0.5 * 1.225 * 60 * 60 };

describe('sampleSection', () => {
  it('matches the exact flow between grid nodes, rotated into the display frame', () => {
    const [X, Y] = disp(0.4, 0.15);
    const smp = sampleSection(section, X, Y);
    const [u, v] = ellipseVelocity(0.4, 0.15, alpha);
    expect(smp.inside).toBe(false);
    expect(smp.U).toBeCloseTo(u * c + v * s, 2);
    expect(smp.V).toBeCloseTo(-u * s + v * c, 2);
    expect(smp.cp).toBeCloseTo(1 - (u * u + v * v), 1);
  });

  it('knows the inside of the airfoil and the far field', () => {
    const [X, Y] = disp(0.5, 0);
    expect(sampleSection(section, X, Y).inside).toBe(true);
    expect(insideContour(section.contour, 0.5, 0.2)).toBe(false);
    const far = sampleSection(section, -5, 0);
    expect(far.outside).toBe(true);
    expect([far.U, far.V, far.cp]).toEqual([1, 0, 0]);
  });
});

describe('probeSection', () => {
  it('reads faster air and lower pressure above, slower and higher below', () => {
    const above = probeSection(section, ...disp(0.3, 0.1), free);
    const below = probeSection(section, ...disp(0.3, -0.1), free);
    expect(above.speedRatio).toBeGreaterThan(1.05);
    expect(above.pressure.delta).toBeLessThan(0);
    expect(below.speedRatio).toBeLessThan(1);
    expect(below.pressure.delta).toBeGreaterThan(0);
    // Low speed: the change is a small fraction of the atmosphere, close to Bernoulli.
    expect(Math.abs(above.pressure.fraction)).toBeLessThan(0.02);
    const bern = free.q * (1 - above.speedRatio ** 2);
    expect(above.pressure.delta).toBeCloseTo(bern, -1);
  });

  it('says "inside the wing" inside the airfoil', () => {
    const r = probeSection(section, ...disp(0.5, 0), free);
    expect(r.inside).toBe(true);
    expect(Number.isNaN(r.speedRatio)).toBe(true);
  });

  it('flow direction: rising ahead of the wing (upwash), falling behind it', () => {
    const ahead = probeSection(section, -0.25, 0.05, free);
    const behind = probeSection(section, 1.25, -0.05, free);
    expect(ahead.angle).toBeGreaterThan(0);
    expect(behind.angle).toBeLessThan(0);
  });

  it('scales the disturbance with Prandtl–Glauert at speed', () => {
    const slow = probeSection(section, ...disp(0.3, 0.1), free);
    const fast = probeSection(section, ...disp(0.3, 0.1), { ...free, mach: 0.6 });
    expect(fast.speedRatio - 1).toBeCloseTo((slow.speedRatio - 1) * 1.25, 1);
  });

  it('uses the dead-air base pressure inside a stall bubble', () => {
    const nx = section.grid.nx;
    const ny = section.grid.ny;
    const separated = new Uint8Array(nx * ny).fill(1);
    const stalled = makeSection({ alphaEffective: alpha, separated, stalled: true });
    const r = probeSection(stalled, ...disp(0.6, 0.2), free);
    expect(r.separated).toBe(true);
    expect(r.pressure.delta).toBeLessThan(0);
  });
});

describe('pressure terrain', () => {
  it('maps high pressure to hills and low pressure to valleys, compressing deep suction', () => {
    expect(terrainHeight(0)).toBe(0);
    expect(terrainHeight(0.8)).toBeCloseTo(0.8, 12);
    expect(terrainHeight(-0.5)).toBeLessThan(0);
    expect(terrainHeight(-3)).toBeLessThan(terrainHeight(-1));
    expect(terrainHeight(-3)).toBeGreaterThan(-3);
    expect(Number.isNaN(terrainHeight(NaN))).toBe(true);
  });

  it('colours valleys blue and hills red', () => {
    const rgb: [number, number, number] = [0, 0, 0];
    terrainColor(-1.2, rgb);
    expect(rgb[2]).toBeGreaterThan(rgb[0] + 60);
    terrainColor(0.9, rgb);
    expect(rgb[0]).toBeGreaterThan(rgb[2] + 60);
  });

  it('rasters Cp with the airfoil masked out and a stagnation hill at the nose', () => {
    const win = { Xmin: -0.5, Xmax: 1.5, Ymin: -0.5, Ymax: 0.5 };
    const w = 100;
    const h = 50;
    const cp = sampleCpRaster(section, win, w, h);
    const at = (X: number, Y: number) =>
      cp[
        Math.floor(((win.Ymax - Y) / (win.Ymax - win.Ymin)) * h) * w +
          Math.floor(((X - win.Xmin) / (win.Xmax - win.Xmin)) * w)
      ]!;
    expect(Number.isNaN(at(...disp(0.5, 0)))).toBe(true);
    expect(at(...disp(0.3, 0.08))).toBeLessThan(-0.1);
    expect(at(-0.03, -0.01)).toBeGreaterThan(0.2);

    const img = new Uint8ClampedArray(w * h * 4);
    const range = fillTerrainImage(cp, w, h, 40, img);
    expect(range.max).toBeGreaterThan(1.05); // slopes facing the light are brighter
    expect(range.min).toBeLessThan(0.95); // and the others darker
    const k = Math.floor(h / 2) * w + Math.floor(((0.5 - win.Xmin) / 2) * w);
    expect(img[4 * k + 3]).toBe(0); // the airfoil itself is left transparent
  });

  it('contours a cone into a closed ring at the right radius', () => {
    const w = 41;
    const h = 41;
    const f = new Float32Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) f[j * w + i] = Math.hypot(i + 0.5 - 20.5, j + 0.5 - 20.5);
    const segs = contourSegments(f, w, h, 10);
    expect(segs.length).toBeGreaterThan(4 * 40);
    for (let k = 0; k < segs.length; k += 2) {
      expect(Math.hypot(segs[k]! - 20.5, segs[k + 1]! - 20.5)).toBeCloseTo(10, 0);
    }
    expect(contourSegments(f, w, h, 100).length).toBe(0);
  });

  it('has evenly spaced contour levels in height, including normal pressure', () => {
    expect(TERRAIN_LEVELS).toContain(0);
    expect(TERRAIN_LEVELS[1]! - TERRAIN_LEVELS[0]!).toBeCloseTo(TERRAIN_STEP, 12);
    const hs = terrainHeights(Float32Array.from([0.5, NaN, -1]));
    expect(hs[0]).toBeCloseTo(0.5, 6);
    expect(Number.isNaN(hs[1])).toBe(true);
    expect(hs[2]).toBeCloseTo(terrainHeight(-1), 6);
  });
});

describe("disturbance (the air's view)", () => {
  const win = { Xmin: -0.5, Xmax: 1.7, Ymin: -0.55, Ymax: 0.55 };
  const arrows = disturbanceArrows(section, win, 0.12);
  const near = (X: number, Y: number) =>
    arrows.reduce((best, a) =>
      Math.hypot(a.X - X, a.Y - Y) < Math.hypot(best.X - X, best.Y - Y) ? a : best,
    );

  it('air is pulled back over the top and pushed forward underneath', () => {
    expect(near(0.45, 0.15).dU).toBeGreaterThan(0);
    expect(near(0.2, -0.15).dU).toBeLessThan(0);
  });

  it('air ahead is lifted and air behind is thrown down', () => {
    expect(near(-0.3, 0).dV).toBeGreaterThan(0);
    expect(near(1.35, 0).dV).toBeLessThan(0);
  });

  it('never puts an arrow inside the airfoil', () => {
    for (const a of arrows) expect(sampleSection(section, a.X, a.Y).inside).toBe(false);
  });

  it('circulates clockwise round a lifting wing: |Γ| / (V c) ≈ cl / 2', () => {
    const gamma = circulationAround(section, { Xmin: -0.4, Xmax: 1.4, Ymin: -0.4, Ymax: 0.4 });
    expect(gamma).toBeLessThan(0);
    // Exact for the fixture's Joukowski flow: Γ = 4πR sin a with R = 0.28, cl = 2Γ.
    const exact = 4 * Math.PI * 0.28 * Math.sin(alpha);
    expect(-gamma).toBeCloseTo(exact, 1);
  });

  it('continues smoothly beyond the solver grid with the far-field vortex', () => {
    // Just inside and just outside the grid's upper edge (airfoil y = 0.6) above mid-chord.
    const inside = sampleSection(section, ...disp(0.25, 0.57));
    const [fu, fv] = farFieldDisturbance(section, ...disp(0.25, 0.63));
    expect(fu).toBeGreaterThan(0); // pulled back above a lifting wing
    expect(fu).toBeCloseTo(inside.U - 1, 1);
    expect(Math.abs(fv)).toBeLessThan(0.05);
    const wide = disturbanceArrows(section, { Xmin: -2, Xmax: 3, Ymin: -2, Ymax: 2 }, 0.25);
    expect(wide.some((a) => a.Y > 1)).toBe(true);
  });

  it('picks a nice gain for the key', () => {
    const g = disturbanceGain(arrows, 0.1);
    expect(
      [1, 2, 2.5, 5].some((m) => Math.abs(g / 10 ** Math.floor(Math.log10(g)) - m) < 1e-9),
    ).toBe(true);
    expect(niceFloor(7.3)).toBe(5);
    expect(niceFloor(0.24)).toBe(0.2);
    expect(niceFloor(26)).toBe(25);
  });
});
