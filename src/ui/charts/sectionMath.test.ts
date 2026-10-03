import { describe, expect, it } from 'vitest';
import {
  airfoilX,
  airfoilY,
  arrowLength,
  centerOfPressureX,
  contourToDisplay,
  crossingAtX,
  displayX,
  displayY,
  fillFieldImage,
  findSegment,
  fitView,
  positionAtTime,
  prepareStreamlines,
  sectionPressureTint,
  separatedLabelAnchor,
  separationPolygon,
  speedGrid,
  surfaceArrows,
  surfaceProfile,
  tintAlpha,
} from './sectionMath';
import { DEG, makeCp, makeSection } from './testFixtures';

describe('display rotation', () => {
  it('turns the freestream direction into +X and back', () => {
    const a = 7 * DEG;
    const c = Math.cos(a);
    const s = Math.sin(a);
    expect(displayX(c, s, c, s)).toBeCloseTo(1, 12);
    expect(displayY(c, s, c, s)).toBeCloseTo(0, 12);
    const X = displayX(c, s, 0.3, -0.2);
    const Y = displayY(c, s, 0.3, -0.2);
    expect(airfoilX(c, s, X, Y)).toBeCloseTo(0.3, 12);
    expect(airfoilY(c, s, X, Y)).toBeCloseTo(-0.2, 12);
  });

  it('pitches the airfoil nose up: the trailing edge sits lower than the leading edge', () => {
    const a = 6 * DEG;
    const c = Math.cos(a);
    const s = Math.sin(a);
    expect(displayY(c, s, 1, 0)).toBeLessThan(displayY(c, s, 0, 0));
    const d = contourToDisplay(Float32Array.from([0, 0, 1, 0]), a);
    expect(d[3]!).toBeLessThan(d[1]!);
  });
});

describe('fitView', () => {
  it('keeps the airfoil inside the canvas with equal scale on both axes', () => {
    for (const [w, h] of [
      [340, 190],
      [300, 300],
      [600, 200],
    ] as const) {
      const vt = fitView(w, h, 8 * DEG);
      expect(vt.x(0)).toBeGreaterThan(0);
      expect(vt.x(1)).toBeLessThan(w);
      expect(vt.y(0.1)).toBeGreaterThan(0);
      expect(vt.y(-0.2)).toBeLessThan(h);
      expect(vt.worldX(vt.x(0.7))).toBeCloseTo(0.7, 9);
      expect(vt.worldY(vt.y(-0.1))).toBeCloseTo(-0.1, 9);
    }
  });
});

describe('pressure field image', () => {
  const section = makeSection();
  const speed = speedGrid(section);
  const win = { Xmin: -0.55, Xmax: 1.75, Ymin: -0.6, Ymax: 0.6 };
  const w = 120;
  const h = 62;
  const out = new Uint8ClampedArray(w * h * 4);
  const tinted = fillFieldImage(section, speed, win, w, h, 'pressure', out);

  const pixelAt = (X: number, Y: number): [number, number, number, number] => {
    const i = Math.min(
      w - 1,
      Math.max(0, Math.floor(((X - win.Xmin) / (win.Xmax - win.Xmin)) * w)),
    );
    const j = Math.min(
      h - 1,
      Math.max(0, Math.floor(((win.Ymax - Y) / (win.Ymax - win.Ymin)) * h)),
    );
    const o = 4 * (j * w + i);
    return [out[o]!, out[o + 1]!, out[o + 2]!, out[o + 3]!];
  };

  it('computes speed magnitudes', () => {
    expect(speed[5]).toBeCloseTo(Math.hypot(section.grid.uv[10]!, section.grid.uv[11]!), 6);
  });

  it('tints suction above the wing blue and the stagnation region red', () => {
    const a = section.alphaEffective;
    const cx = 0.5 * Math.cos(a);
    const cy = -0.5 * Math.sin(a);
    const [r, , b, alpha] = pixelAt(cx, cy + 0.24);
    expect(alpha).toBeGreaterThan(80);
    expect(b).toBeGreaterThan(r);
    const [r2, , b2, alpha2] = pixelAt(cx - 0.6, cy); // just ahead of the leading edge
    expect(alpha2).toBeGreaterThan(60);
    expect(r2).toBeGreaterThan(b2);
    expect(tinted).toBeGreaterThan(100);
  });

  it('masks the airfoil interior and leaves the far field untinted', () => {
    const a = section.alphaEffective;
    expect(pixelAt(0.5 * Math.cos(a), -0.5 * Math.sin(a))[3]).toBe(0);
    expect(pixelAt(1.7, 0.55)[3]).toBeLessThan(30);
  });

  it('has no gaps outside the grid when the view is larger than it', () => {
    const big = new Uint8ClampedArray(w * h * 4);
    const wide = { Xmin: -3, Xmax: 4, Ymin: -2, Ymax: 2 };
    fillFieldImage(section, speed, wide, w, h, 'pressure', big);
    // Corner pixels are beyond the grid: undisturbed freestream, so exactly transparent.
    expect(big[3]).toBe(0);
    expect(big[4 * (w * h - 1) + 3]).toBe(0);
  });

  it('fades the tint out towards the edge of the solver grid', () => {
    // Uniformly fast flow everywhere (inside nodes none): without a fade the tint would end in
    // a hard rectangle at the grid border.
    const uniform = makeSection({ alphaEffective: 0 });
    uniform.grid.inside.fill(0);
    for (let k = 0; k < uniform.grid.nx * uniform.grid.ny; k++) {
      uniform.grid.uv[2 * k] = 1.5;
      uniform.grid.uv[2 * k + 1] = 0;
    }
    const g = uniform.grid;
    const full = { Xmin: g.xMin, Xmax: g.xMax, Ymin: g.yMin, Ymax: g.yMax };
    const img = new Uint8ClampedArray(w * h * 4);
    fillFieldImage(uniform, speedGrid(uniform), full, w, h, 'pressure', img);
    const alphaAt = (i: number, j: number): number => img[4 * (j * w + i) + 3]!;
    const centre = alphaAt(w >> 1, h >> 1);
    expect(centre).toBeGreaterThan(150);
    expect(alphaAt(0, h >> 1)).toBeLessThan(centre * 0.2);
    expect(alphaAt(w - 1, h >> 1)).toBeLessThan(centre * 0.2);
    expect(alphaAt(w >> 1, 0)).toBeLessThan(centre * 0.2);
    expect(alphaAt(w >> 1, h - 1)).toBeLessThan(centre * 0.2);
  });

  it('colours separated dead air as low pressure, not as stagnation red', () => {
    const stalled = makeSection({ alphaEffective: 0 });
    const g = stalled.grid;
    const mask = new Uint8Array(g.nx * g.ny);
    const dx = (g.xMax - g.xMin) / (g.nx - 1);
    const dy = (g.yMax - g.yMin) / (g.ny - 1);
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const x = g.xMin + i * dx;
        const y = g.yMin + j * dy;
        if (x > 1.05 && x < 1.5 && y > 0.05 && y < 0.3) {
          const k = i + g.nx * j;
          g.uv[2 * k] = 0.05; // nearly still air: Bernoulli alone would say Cp ~ 1 (red)
          g.uv[2 * k + 1] = 0;
          mask[k] = 1;
        }
      }
    }
    const sp = speedGrid(stalled);
    const view = { Xmin: -0.55, Xmax: 1.75, Ymin: -0.6, Ymax: 0.6 };
    const at = (img: Uint8ClampedArray, X: number, Y: number): [number, number, number, number] => {
      const i = Math.floor(((X - view.Xmin) / (view.Xmax - view.Xmin)) * w);
      const j = Math.floor(((view.Ymax - Y) / (view.Ymax - view.Ymin)) * h);
      const o = 4 * (j * w + i);
      return [img[o]!, img[o + 1]!, img[o + 2]!, img[o + 3]!];
    };
    const plain = new Uint8ClampedArray(w * h * 4);
    fillFieldImage(stalled, sp, view, w, h, 'pressure', plain);
    const [r0, , b0] = at(plain, 1.27, 0.18);
    expect(r0).toBeGreaterThan(b0);

    stalled.separated = mask;
    const masked = new Uint8ClampedArray(w * h * 4);
    fillFieldImage(stalled, sp, view, w, h, 'pressure', masked);
    const [r1, , b1, a1] = at(masked, 1.27, 0.18);
    expect(b1).toBeGreaterThan(r1);
    expect(a1).toBeGreaterThan(60);

    const anchor = separatedLabelAnchor(stalled)!;
    expect(anchor.X).toBeGreaterThan(1.05);
    expect(anchor.X).toBeLessThan(1.5);
    expect(anchor.Y).toBeGreaterThan(0.2);
    expect(separatedLabelAnchor(makeSection())).toBeNull();
  });

  it('gives suction a blue tint and high pressure a red one, both fading to clear at Cp = 0', () => {
    const rgb: [number, number, number] = [0, 0, 0];
    expect(sectionPressureTint(0, rgb)).toBe(0);
    expect(sectionPressureTint(-1, rgb)).toBeGreaterThan(0.6);
    expect(rgb[2]).toBeGreaterThan(rgb[0]);
    expect(sectionPressureTint(1, rgb)).toBeGreaterThan(0.6);
    expect(rgb[0]).toBeGreaterThan(rgb[2]);
    expect(sectionPressureTint(NaN, rgb)).toBe(0);
  });

  it('supports the speed colour mode', () => {
    const o2 = new Uint8ClampedArray(w * h * 4);
    expect(fillFieldImage(section, speed, win, w, h, 'speed', o2)).toBeGreaterThan(100);
  });

  it('keeps the freestream transparent and strong pressures opaque', () => {
    expect(tintAlpha(0)).toBe(0);
    expect(tintAlpha(1)).toBeGreaterThan(0.85);
    expect(tintAlpha(-3)).toBeLessThanOrEqual(0.92);
  });
});

describe('surface profile and arrows', () => {
  const section = makeSection();

  it('splits the contour into upper and lower surfaces from the leading edge', () => {
    const p = surfaceProfile(section.contour);
    expect(p.upperX[0]).toBeCloseTo(0, 5);
    expect(p.lowerX[0]).toBeCloseTo(0, 5);
    expect(p.upperX[p.upperX.length - 1]).toBeCloseTo(1, 5);
    expect(p.lowerX[p.lowerX.length - 1]).toBeCloseTo(1, 5);
    expect(Math.max(...p.upperY)).toBeGreaterThan(0.05);
    expect(Math.min(...p.lowerY)).toBeLessThan(-0.05);
    for (let i = 1; i < p.upperX.length; i++)
      expect(p.upperX[i]!).toBeGreaterThanOrEqual(p.upperX[i - 1]!);
    for (let i = 1; i < p.lowerX.length; i++)
      expect(p.lowerX[i]!).toBeGreaterThanOrEqual(p.lowerX[i - 1]!);
  });

  it('points suction arrows outward on top and pressure arrows inward below', () => {
    const arrows = surfaceArrows(section);
    const upper = arrows.filter((a) => a.side === 'upper');
    const lower = arrows.filter((a) => a.side === 'lower');
    expect(upper.length).toBeGreaterThan(4);
    expect(lower.length).toBeGreaterThan(2);
    for (const a of upper) {
      expect(a.cp).toBeLessThan(0);
      expect(a.ny).toBeGreaterThan(0); // outward = away from the wing, upward
      expect(Math.hypot(a.nx, a.ny)).toBeCloseTo(1, 5);
    }
    for (const a of lower) expect(a.ny).toBeLessThan(0); // outward = downward
    const lowerPressure = lower.filter((a) => a.cp > 0);
    expect(lowerPressure.length).toBeGreaterThan(0);
  });

  it('scales arrow length with |Cp| up to a cap', () => {
    expect(arrowLength(0.5)).toBeCloseTo(0.1, 12);
    expect(arrowLength(-0.5)).toBeCloseTo(0.1, 12);
    expect(arrowLength(-10)).toBeLessThanOrEqual(0.34);
    const arrows = surfaceArrows(section);
    for (const a of arrows) expect(a.length).toBeGreaterThan(0);
  });

  it('skips negligible pressures', () => {
    const flat = makeSection();
    flat.cp.upper.fill(0.01);
    flat.cp.lower.fill(-0.01);
    expect(surfaceArrows(flat)).toHaveLength(0);
  });
});

describe('centerOfPressureX', () => {
  it('is mid-chord for uniform loading and quarter chord when there is none', () => {
    const cp = makeCp();
    cp.upper.fill(-1);
    cp.lower.fill(0);
    expect(centerOfPressureX(cp)).toBeCloseTo(0.5, 2);
    cp.upper.fill(0);
    expect(centerOfPressureX(cp)).toBe(0.25);
  });

  it('moves forward when the loading is concentrated at the front', () => {
    expect(centerOfPressureX(makeCp())).toBeLessThan(0.4);
  });
});

describe('separationPolygon', () => {
  it('is null for attached flow', () => {
    expect(separationPolygon(makeSection())).toBeNull();
  });

  it('covers the rear of the upper surface and the wake when stalled', () => {
    const stalled = makeSection({ stalled: true, attachedFraction: 0.35 });
    const poly = separationPolygon(stalled)!;
    expect(poly).not.toBeNull();
    expect(poly.length % 2).toBe(0);
    expect(poly.every((v) => Number.isFinite(v))).toBe(true);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < poly.length; i += 2) {
      xs.push(poly[i]!);
      ys.push(poly[i + 1]!);
    }
    expect(Math.min(...xs)).toBeGreaterThan(0.25);
    expect(Math.max(...xs)).toBeGreaterThan(1.2); // reaches into the wake
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.05);
  });

  it('grows as more of the surface separates', () => {
    const size = (frac: number): number => {
      const p = separationPolygon(makeSection({ stalled: true, attachedFraction: frac }))!;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 1; i < p.length; i += 2) {
        min = Math.min(min, p[i]!);
        max = Math.max(max, p[i]!);
      }
      return max - min;
    };
    expect(size(0.2)).toBeGreaterThan(size(0.6));
  });

  it('shows the beginning of trailing-edge separation before the full stall', () => {
    expect(separationPolygon(makeSection({ attachedFraction: 0.8 }))).not.toBeNull();
  });
});

describe('streamline preparation', () => {
  const section = makeSection();
  const prep = prepareStreamlines(section);

  it('starts every marker on one vertical line', () => {
    const out = new Float32Array(2);
    let checked = 0;
    for (const line of prep.lines) {
      if (!positionAtTime(line, line.pulseStart, out)) continue;
      expect(out[0]).toBeCloseTo(prep.pulseX, 3);
      checked++;
    }
    expect(checked).toBe(prep.lines.length);
  });

  it('lets the air over the top arrive at the trailing edge sooner', () => {
    expect(Number.isFinite(prep.topArrival)).toBe(true);
    expect(Number.isFinite(prep.bottomArrival)).toBe(true);
    expect(prep.topArrival).toBeLessThan(prep.bottomArrival);
    const tops = prep.lines.filter((l) => l.side === 'top').length;
    const bottoms = prep.lines.filter((l) => l.side === 'bottom').length;
    expect(tops).toBeGreaterThan(0);
    expect(bottoms).toBeGreaterThan(0);
  });

  it('keeps display coordinates consistent with the airfoil-frame points', () => {
    const line = prep.lines[3]!;
    const sl = section.streamlines[3]!;
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    expect(line.disp[10]).toBeCloseTo(displayX(c, s, sl.points[10]!, sl.points[11]!), 5);
    expect(line.disp[11]).toBeCloseTo(displayY(c, s, sl.points[10]!, sl.points[11]!), 5);
    expect(line.total).toBeCloseTo(sl.time[sl.time.length - 1]!, 6);
  });

  it('handles an empty streamline set', () => {
    const empty = prepareStreamlines(makeSection({ streamlines: [] }));
    expect(empty.lines).toHaveLength(0);
    expect(Number.isFinite(empty.pulseX)).toBe(true);
  });
});

describe('time sampling', () => {
  const time = Float32Array.from([0, 1, 2, 4]);

  it('finds segments by binary search', () => {
    expect(findSegment(time, -0.1)).toBe(-1);
    expect(findSegment(time, 0)).toBe(0);
    expect(findSegment(time, 0.99)).toBe(0);
    expect(findSegment(time, 1)).toBe(1);
    expect(findSegment(time, 3)).toBe(2);
    expect(findSegment(time, 4)).toBe(-1);
    expect(findSegment(Float32Array.from([0]), 0)).toBe(-1);
  });

  it('interpolates positions in time, so fast stretches cover more distance', () => {
    const line = {
      disp: Float32Array.from([0, 0, 1, 0, 3, 0, 4, 0]),
      time,
      speed: new Float32Array(4),
      pulseStart: 0,
      total: 4,
      side: null,
      teTime: NaN,
      teOffset: NaN,
    };
    const out = new Float32Array(2);
    expect(positionAtTime(line, 0.5, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(positionAtTime(line, 1.5, out)).toBe(true);
    expect(out[0]).toBeCloseTo(2, 6); // 2 chords in 1 time unit: the fast part
    expect(positionAtTime(line, 5, out)).toBe(false);
  });

  it('finds where a polyline crosses a vertical line', () => {
    const hit = crossingAtX(Float32Array.from([0, 0, 2, 2]), Float32Array.from([0, 2]), 1)!;
    expect(hit.t).toBeCloseTo(1, 9);
    expect(hit.y).toBeCloseTo(1, 9);
    expect(crossingAtX(Float32Array.from([0, 0, 2, 2]), Float32Array.from([0, 2]), 5)).toBeNull();
  });
});
