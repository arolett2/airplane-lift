import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, type AppState } from '../state/params';
import { getPreset } from '../state/presets';
import { applyLessonStep, applyLessonUpTo } from './applyStep';
import type { LessonStep } from './types';

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

const step = (partial: Partial<LessonStep>): LessonStep => ({
  id: 't',
  title: 'Test',
  body: '<p>Test</p>',
  ...partial,
});

describe('applyLessonStep', () => {
  it('returns the same state object when a step changes nothing', () => {
    expect(applyLessonStep(DEFAULT_STATE, step({}))).toBe(DEFAULT_STATE);
    expect(applyLessonStep(DEFAULT_STATE, step({ apply: {} }))).toBe(DEFAULT_STATE);
    expect(applyLessonStep(DEFAULT_STATE, step({ apply: { view: { flowMode: 'both' } } }))).toBe(
      DEFAULT_STATE,
    );
  });

  it('loads a preset with its cruise conditions', () => {
    const next = applyLessonStep(DEFAULT_STATE, step({ apply: { preset: 'b747-400' } }));
    const p = getPreset('b747-400')!;
    expect(next.presetId).toBe('b747-400');
    expect(next.wing).toEqual(p.wing);
    expect(next.flow).toEqual(p.cruise);
  });

  it('ignores an unknown preset id', () => {
    const next = applyLessonStep(DEFAULT_STATE, step({ apply: { preset: 'nope' } }));
    expect(next).toBe(DEFAULT_STATE);
  });

  it('merges flow patches over the preset conditions', () => {
    const next = applyLessonStep(
      DEFAULT_STATE,
      step({ apply: { preset: 'b737-800', flow: { alphaDeg: 7, altitude: 0 } } }),
    );
    const p = getPreset('b737-800')!;
    expect(next.flow).toEqual({ alphaDeg: 7, airspeed: p.cruise.airspeed, altitude: 0 });
  });

  it('keeps the preset id when only flow or view change', () => {
    const base = applyLessonStep(DEFAULT_STATE, step({ apply: { preset: 'a380-800' } }));
    const next = applyLessonStep(
      base,
      step({ apply: { flow: { alphaDeg: 3 }, view: { colorBy: 'speed' } } }),
    );
    expect(next.presetId).toBe('a380-800');
    expect(next.view.colorBy).toBe('speed');
  });

  it('deep-merges wing patches and turns the preset into "Custom"', () => {
    const base = applyLessonStep(DEFAULT_STATE, step({ apply: { preset: 'b737-800' } }));
    const next = applyLessonStep(base, step({ apply: { wing: { flaps: { deflectionDeg: 30 } } } }));
    expect(next.presetId).toBeNull();
    expect(next.wing.flaps.deflectionDeg).toBe(30);
    // Untouched siblings survive the merge.
    expect(next.wing.flaps.chordFrac).toBe(base.wing.flaps.chordFrac);
    expect(next.wing.tipDevice).toEqual(base.wing.tipDevice);
    expect(next.wing.span).toBe(base.wing.span);
  });

  it('applies a preset and a wing patch from the same step', () => {
    const next = applyLessonStep(
      DEFAULT_STATE,
      step({ apply: { preset: 'b747-400', wing: { tipDevice: { size: 0 } } } }),
    );
    expect(next.presetId).toBeNull();
    expect(next.wing.tipDevice.size).toBe(0);
    expect(next.wing.tipDevice.kind).toBe('canted-winglet');
    expect(next.wing.sweepDeg).toBe(37.5);
  });

  it('keeps the preset id when a wing patch changes nothing', () => {
    const base = applyLessonStep(DEFAULT_STATE, step({ apply: { preset: 'b737-800' } }));
    const next = applyLessonStep(base, step({ apply: { wing: { sweepDeg: base.wing.sweepDeg } } }));
    expect(next.presetId).toBe('b737-800');
    expect(next).toBe(base);
  });

  it('deep-merges nested view patches', () => {
    const next = applyLessonStep(
      DEFAULT_STATE,
      step({ apply: { view: { flowMode: 'streamlines', rake: { mode: 'tip-vortex' } } } }),
    );
    expect(next.view.flowMode).toBe('streamlines');
    expect(next.view.rake).toEqual({ ...DEFAULT_STATE.view.rake, mode: 'tip-vortex' });
  });

  it('sets the camera from step.camera, which wins over apply.view.camera', () => {
    const a = applyLessonStep(DEFAULT_STATE, step({ camera: 'tip' }));
    expect(a.view.camera).toBe('tip');
    const b = applyLessonStep(
      DEFAULT_STATE,
      step({ camera: 'behind', apply: { view: { camera: 'top' } } }),
    );
    expect(b.view.camera).toBe('behind');
  });

  it('opens, keeps and closes the comparison', () => {
    const opened = applyLessonStep(
      DEFAULT_STATE,
      step({ apply: { compare: ['b747-400', 'b737-800'] } }),
    );
    expect(opened.compare).toEqual(['b747-400', 'b737-800']);
    // Absent: leave it alone.
    expect(applyLessonStep(opened, step({ apply: { flow: { alphaDeg: 2 } } })).compare).toEqual([
      'b747-400',
      'b737-800',
    ]);
    // Same pair again: no change (same object).
    expect(applyLessonStep(opened, step({ apply: { compare: ['b747-400', 'b737-800'] } }))).toBe(
      opened,
    );
    // null closes it.
    expect(applyLessonStep(opened, step({ apply: { compare: null } })).compare).toBeNull();
  });

  it('does not mutate its input', () => {
    const frozen = deepFreeze(structuredClone(DEFAULT_STATE)) as AppState;
    const frozenStep = deepFreeze(
      step({
        camera: 'side',
        apply: {
          preset: 'b737-800',
          wing: { flaps: { deflectionDeg: 25 }, slats: true },
          flow: { alphaDeg: 6 },
          view: { rake: { count: 40 } },
          compare: ['b747-400', 'b737-800'],
        },
      }),
    );
    expect(() => applyLessonStep(frozen, frozenStep)).not.toThrow();
    expect(frozen).toEqual(DEFAULT_STATE);
  });
});

describe('applyLessonUpTo', () => {
  const steps: LessonStep[] = [
    step({ id: 'a', apply: { preset: 'b737-800' } }),
    step({ id: 'b', apply: { wing: { flaps: { deflectionDeg: 30 } } } }),
    step({ id: 'c', apply: { flow: { alphaDeg: 9 } } }),
  ];

  it('replays steps in order and is independent of how you got there', () => {
    const viaSteps = steps.reduce(applyLessonStep, DEFAULT_STATE);
    expect(applyLessonUpTo(DEFAULT_STATE, steps, 2)).toEqual(viaSteps);
    // Going back to step 0 forgets the later flap change.
    const back = applyLessonUpTo(DEFAULT_STATE, steps, 0);
    expect(back.wing.flaps.deflectionDeg).toBe(0);
    expect(back.presetId).toBe('b737-800');
  });

  it('clamps the index to the available steps', () => {
    expect(applyLessonUpTo(DEFAULT_STATE, steps, 99)).toEqual(
      applyLessonUpTo(DEFAULT_STATE, steps, 2),
    );
    expect(applyLessonUpTo(DEFAULT_STATE, [], 0)).toBe(DEFAULT_STATE);
  });
});
