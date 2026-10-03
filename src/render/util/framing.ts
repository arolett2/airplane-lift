/**
 * What the camera shots need to know about the wing, extracted once per geometry: its bounds,
 * the chord at the station the smoke rake / cross-section looks at, and the outermost tip.
 * Pure (no three.js). Physics meters, body frame (alpha is ignored: framing need not follow it).
 */
import type { Vec3, WingGeometry, WingSection } from '../../physics/types';

export interface WingStation {
  /** Leading-edge point (m). */
  le: Vec3;
  /** Local chord (m). */
  chord: number;
}

export interface WingFraming {
  /** Axis-aligned bounds of every surface, leading to trailing edge (m). */
  min: Vec3;
  max: Vec3;
  /** The section the side / section shots look at (the smoke-rake station). */
  station: WingStation;
  /** The outermost right-side section (tip device included): where the tip vortex is shed. */
  tip: WingStation;
}

function trailingEdge(s: WingSection): Vec3 {
  // Nose-up twist lowers the trailing edge (see loft.ts / frames.ts).
  return [s.le[0] + s.chord * Math.cos(s.twist), s.le[1], s.le[2] - s.chord * Math.sin(s.twist)];
}

/**
 * @param stationEta spanwise station of interest, -1 (left tip) .. 1 (right tip) of the base wing
 */
export function wingFraming(geometry: WingGeometry, stationEta: number): WingFraming {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let tip: WingStation | null = null;
  for (const surface of geometry.surfaces) {
    for (const s of surface.sections) {
      for (const p of [s.le, trailingEdge(s)]) {
        for (let k = 0; k < 3; k++) {
          if (p[k]! < min[k]!) min[k] = p[k]!;
          if (p[k]! > max[k]!) max[k] = p[k]!;
        }
      }
      if (surface.side === 'right' && (!tip || s.le[1] > tip.le[1])) {
        tip = { le: [s.le[0], s.le[1], s.le[2]], chord: s.chord };
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    const p = geometry.pivot;
    return {
      min: [p[0], p[1], p[2]],
      max: [p[0], p[1], p[2]],
      station: { le: [p[0], p[1], p[2]], chord: 1 },
      tip: { le: [p[0], p[1], p[2]], chord: 1 },
    };
  }
  return { min, max, station: stationAt(geometry, stationEta), tip: tip! };
}

/** Leading edge and chord of the base wing at `eta` (-1 .. 1, mirrored for the left side). */
export function stationAt(geometry: WingGeometry, eta: number): WingStation {
  const right = geometry.surfaces.find((s) => s.side === 'right' && s.role === 'wing');
  const sections = right?.sections ?? geometry.surfaces[0]?.sections ?? [];
  if (sections.length === 0) {
    const p = geometry.pivot;
    return { le: [p[0], p[1], p[2]], chord: geometry.meanAeroChord || 1 };
  }
  const semispan = Math.max(1e-6, sections[sections.length - 1]!.le[1]);
  const e = Math.min(1, Math.max(-1, Number.isFinite(eta) ? eta : 0));
  const y = Math.abs(e) * semispan;
  let i = 0;
  while (i < sections.length - 2 && sections[i + 1]!.le[1] < y) i++;
  const a = sections[i]!;
  const b = sections[Math.min(i + 1, sections.length - 1)]!;
  const dy = b.le[1] - a.le[1];
  const f = dy > 1e-9 ? Math.min(1, Math.max(0, (y - a.le[1]) / dy)) : 0;
  const sign = e < 0 ? -1 : 1;
  return {
    le: [
      a.le[0] + (b.le[0] - a.le[0]) * f,
      sign * (a.le[1] + (b.le[1] - a.le[1]) * f),
      a.le[2] + (b.le[2] - a.le[2]) * f,
    ],
    chord: a.chord + (b.chord - a.chord) * f,
  };
}
