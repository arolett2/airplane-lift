/** Pure sizing rules for the force arrows (no three.js). */

/** Drag is drawn this many times longer than its true proportion so it stays visible. */
export const DRAG_VISUAL_SCALE = 5;
/** The largest force (lift or weight) is drawn this many semispans long. */
export const ARROW_REFERENCE_SEMISPANS = 0.6;
/** Drag is clamped to this many semispans so a stalled wing does not draw a monster arrow. */
export const MAX_DRAG_SEMISPANS = 1.5;

export interface ArrowLengths {
  /** Meters (physics space). */
  lift: number;
  drag: number;
  weight: number;
}

/**
 * Arrow lengths in meters: `0.6 * semispan * F / max(lift, weight, tiny)`, drag multiplied by
 * DRAG_VISUAL_SCALE. Lift and weight therefore share a scale, so equal arrows mean level flight.
 * Missing or non-positive forces give length 0.
 */
export function arrowLengths(
  semispan: number,
  liftN: number,
  dragN: number,
  weightN: number | null,
): ArrowLengths {
  const lift = Number.isFinite(liftN) ? Math.max(0, liftN) : 0;
  const drag = Number.isFinite(dragN) ? Math.max(0, dragN) : 0;
  const weight = weightN !== null && Number.isFinite(weightN) ? Math.max(0, weightN) : 0;
  const ref = Math.max(lift, weight, 1e-9);
  const unit = (ARROW_REFERENCE_SEMISPANS * semispan) / ref;
  return {
    lift: lift * unit,
    drag: Math.min(drag * unit * DRAG_VISUAL_SCALE, MAX_DRAG_SEMISPANS * semispan),
    weight: weight * unit,
  };
}

export interface ArrowShape {
  shaftLength: number;
  headLength: number;
  shaftRadius: number;
  headRadius: number;
}

/** Proportions of an arrow of total length `length` for a wing of the given semispan. */
export function arrowShape(length: number, semispan: number): ArrowShape {
  const shaftRadius = 0.013 * semispan;
  const headRadius = 2.7 * shaftRadius;
  // Short arrows keep a stubby head so they stay readable.
  const headLength = Math.min(6.5 * shaftRadius, 0.5 * length);
  const scale = length < 4 * shaftRadius ? Math.max(0.25, length / (4 * shaftRadius)) : 1;
  return {
    shaftLength: Math.max(0, length - headLength),
    headLength,
    shaftRadius: shaftRadius * scale,
    headRadius: headRadius * scale,
  };
}
