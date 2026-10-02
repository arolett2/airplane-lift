/**
 * Applies a lesson step to the app state. Pure: no DOM, no store access, so the lesson panel and
 * the tests share exactly the same logic.
 *
 * Order of operations (documented in docs/MODULE_APIS.md, "content"):
 *   1. `apply.preset` loads that preset's wing and CRUISE flight conditions.
 *   2. `apply.wing`, `apply.flow` and `apply.view` are deep-merged on top.
 *   3. `apply.compare` opens or closes the side-by-side comparison (absent = leave it alone).
 *   4. `step.camera` sets the camera shot (it wins over `apply.view.camera`).
 * The preset id becomes `null` ("Custom") when a wing patch actually changes the wing.
 */
import type { AppState } from '../state/params';
import { applyPreset } from '../state/presets';
import { deepEqual, deepMerge } from '../state/store';
import type { ApplyStep, LessonStep } from './types';

export const applyLessonStep: ApplyStep = (state: AppState, step: LessonStep): AppState => {
  const patch = step.apply;
  let next = state;

  if (patch?.preset) next = applyPreset(next, patch.preset, 'cruise');

  if (patch?.wing) {
    const wing = deepMerge(next.wing, patch.wing);
    if (!deepEqual(wing, next.wing)) next = { ...next, wing, presetId: null };
  }

  if (patch?.flow) {
    const flow = { ...next.flow, ...patch.flow };
    if (!deepEqual(flow, next.flow)) next = { ...next, flow };
  }

  if (patch?.view) {
    const view = deepMerge(next.view, patch.view);
    if (!deepEqual(view, next.view)) next = { ...next, view };
  }

  if (patch?.compare !== undefined) {
    const same =
      patch.compare === next.compare ||
      (patch.compare !== null &&
        next.compare !== null &&
        patch.compare[0] === next.compare[0] &&
        patch.compare[1] === next.compare[1]);
    if (!same) next = { ...next, compare: patch.compare };
  }

  if (step.camera && step.camera !== next.view.camera) {
    next = { ...next, view: { ...next.view, camera: step.camera } };
  }

  return next;
};

/**
 * Replay a lesson from a base state up to and including step `index`. Used when the person jumps
 * to a step: the result is the same whichever way they got there.
 */
export function applyLessonUpTo(
  base: AppState,
  steps: readonly LessonStep[],
  index: number,
): AppState {
  let state = base;
  const last = Math.min(index, steps.length - 1);
  for (let i = 0; i <= last; i++) state = applyLessonStep(state, steps[i]!);
  return state;
}
