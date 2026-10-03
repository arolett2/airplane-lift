/**
 * Truth check of the cross-section claims in the "What is lift?" lesson, with the REAL solvers at
 * the exact state each step sets up: what the probe reads above and under the wing, and the
 * circulation the air's view shows. (Claims about whole-wing numbers are checked in
 * src/physics/lessons.e2e.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { applyLessonUpTo } from '../../content/applyStep';
import { LESSONS } from '../../content/lessons';
import { computeAero, computeSection, createAeroCache } from '../../physics/aero';
import { DEFAULT_STATE, type AppState } from '../../state/params';
import { circulationAround, disturbanceArrows, probeSection } from './sectionFields';

const cache = createAeroCache();

function stateAt(stepId: string): AppState {
  const lesson = LESSONS.find((l) => l.id === 'what-is-lift')!;
  const index = lesson.steps.findIndex((s) => s.id === stepId);
  if (index < 0) throw new Error(`no step ${stepId}`);
  return applyLessonUpTo(DEFAULT_STATE, lesson.steps, index);
}

function setup(stepId: string) {
  const s = stateAt(stepId);
  const { aero } = computeAero(s.wing, s.flow, 1, cache);
  const section = computeSection(s.wing, s.flow, s.view.sectionEta, cache);
  const free = {
    vInf: aero.velocity,
    mach: aero.mach,
    pInf: aero.atmosphere.pressure,
    q: aero.dynamicPressure,
  };
  return { s, section, free };
}

describe('What is lift? cross-section claims (real solvers)', { timeout: 60_000 }, () => {
  it('probe step: ~30% faster and ~1.5% below the surrounding pressure above the wing', () => {
    const { s, section, free } = setup('what-is-lift-probe');
    const p = s.view.sectionProbe!;
    expect(p).not.toBeNull();
    const above = probeSection(section, p.x, p.y, free);
    expect(above.inside).toBe(false);
    expect(above.speedRatio).toBeGreaterThan(1.24);
    expect(above.speedRatio).toBeLessThan(1.36);
    expect(above.pressure.fraction).toBeLessThan(-0.012);
    expect(above.pressure.fraction).toBeGreaterThan(-0.018);
    // Mirrored under the wing: a little slower than the wind, pressure a little above normal.
    const below = probeSection(section, p.x, -p.y, free);
    expect(below.speedRatio).toBeLessThan(1);
    expect(below.pressure.fraction).toBeGreaterThan(0);
  });

  it("air's view step: lifted ahead, pulled back above, pushed forward below, thrown down behind", () => {
    const { section } = setup('what-is-lift-air-view');
    const arrows = disturbanceArrows(
      section,
      { Xmin: -0.6, Xmax: 1.8, Ymin: -0.5, Ymax: 0.5 },
      0.05,
    );
    const near = (X: number, Y: number) =>
      arrows.reduce((b, a) =>
        Math.hypot(a.X - X, a.Y - Y) < Math.hypot(b.X - X, b.Y - Y) ? a : b,
      );
    expect(near(-0.3, 0).dV).toBeGreaterThan(0);
    expect(near(0.4, 0.15).dU).toBeGreaterThan(0);
    expect(near(0.3, -0.12).dU).toBeLessThan(0);
    expect(near(1.3, -0.05).dV).toBeLessThan(0);
  });

  it("air's view step: the air circulates round the wing with Γ ≈ cl·V·c / 2", () => {
    const { section } = setup('what-is-lift-air-view');
    const gamma = circulationAround(section, { Xmin: -0.4, Xmax: 1.4, Ymin: -0.45, Ymax: 0.45 });
    expect(gamma).toBeLessThan(0); // clockwise with the air flowing left to right
    const cl = section.fieldCl ?? section.cl;
    expect(-gamma / (cl / 2)).toBeGreaterThan(0.85);
    expect(-gamma / (cl / 2)).toBeLessThan(1.15);
  });
});
