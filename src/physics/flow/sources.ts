/**
 * Thickness model: spanwise line sources on the (pitched) camber surface.
 *
 * Thin-airfoil thickness theory: a source sheet of strength q(x) = V_inf dT/dx (T = local
 * thickness, dimensional) displaces the flow around the section's thickness. We lump q over
 * chordwise intervals [x_i, x_{i+1}] into one line source per interval with strength per unit
 * span sigma_i = V_inf (T(x_{i+1}) - T(x_i)); the strengths telescope to T(TE) - T(LE) = 0, so
 * the wing is a closed body (no net outflow).
 */
import type { VortexLattice, WingGeometry } from '../types';
import { bodyToTunnel } from '../math/frames';
import { camberLine, nacaHalfThickness } from '../airfoil/naca';
import { setSourceMeta } from './lattice';
import { interpolateSegment, sectionPoint, segmentSpanLength } from './wingFrames';

/** Spanwise strips per base-wing semispan and per tip-device surface. */
export const SOURCE_STRIPS_WING = 24;
export const SOURCE_STRIPS_DEVICE = 6;
/** Chordwise intervals per strip (16: speed ripple ~1% of V_inf at 1% chord off the skin). */
export const SOURCE_CHORDWISE = 16;

/** Chordwise interval edges (cosine-spaced, clustered at LE and TE). */
function chordStations(n: number): Float64Array {
  const x = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) x[i] = 0.5 * (1 - Math.cos((Math.PI * i) / n));
  return x;
}

/** Where the lumped interval source sits: the q-centroid (x1/3 for the sqrt-singular LE). */
function stationPosition(x0: number, x1: number): number {
  return x0 === 0 ? x1 / 3 : 0.5 * (x0 + x1);
}

export function buildThicknessSources(
  geometry: WingGeometry,
  alpha: number,
  vInf: number,
): VortexLattice['sources'] {
  const xs = chordStations(SOURCE_CHORDWISE);
  const p0: number[] = [];
  const p1: number[] = [];
  const sigma: number[] = [];
  const core: number[] = [];
  const groupStart: number[] = [];
  const groupChord: number[] = [];
  const pivot = geometry.pivot;

  for (const surface of geometry.surfaces) {
    const nSeg = surface.sections.length - 1;
    if (nSeg < 1) continue;
    let total = 0;
    for (let i = 0; i < nSeg; i++) total += segmentSpanLength(surface, i);
    if (total <= 0) continue;
    const perSurface = surface.role === 'wing' ? SOURCE_STRIPS_WING : SOURCE_STRIPS_DEVICE;
    for (let i = 0; i < nSeg; i++) {
      const len = segmentSpanLength(surface, i);
      if (len <= 1e-9) continue;
      const nStrips = Math.max(1, Math.round((perSurface * len) / total));
      for (let j = 0; j < nStrips; j++) {
        const sA = j / nStrips;
        const sB = (j + 1) / nStrips;
        const inner = interpolateSegment(surface, i, sA);
        const outer = interpolateSegment(surface, i, sB);
        const mid = interpolateSegment(surface, i, 0.5 * (sA + sB));
        const chord = mid.axes.chord;
        const t = mid.airfoil.thickness;
        groupStart.push(sigma.length);
        groupChord.push(chord);
        for (let k = 0; k < SOURCE_CHORDWISE; k++) {
          const xa = xs[k]!;
          const xb = xs[k + 1]!;
          const dT = 2 * (nacaHalfThickness(t, xb) - nacaHalfThickness(t, xa)) * chord;
          const xm = stationPosition(xa, xb);
          const ycIn = camberLine(inner.airfoil, inner.flap, xm).yc;
          const ycOut = camberLine(outer.airfoil, outer.flap, xm).yc;
          const a = bodyToTunnel(sectionPoint(inner.axes, xm, ycIn), pivot, alpha);
          const b = bodyToTunnel(sectionPoint(outer.axes, xm, ycOut), pivot, alpha);
          // Left-side strips run outboard -> inboard in y; orientation does not matter for a source.
          p0.push(a[0], a[1], a[2]);
          p1.push(b[0], b[1], b[2]);
          sigma.push(vInf * dT);
          // A core of half the chordwise interval blends the discrete lines into a smooth sheet:
          // the speed ripple next to the skin stays ~2% of V_inf (vs ~10% with 0.2 intervals).
          core.push(Math.max(0.5 * (xb - xa) * chord, 0.005 * chord));
        }
      }
    }
  }
  groupStart.push(sigma.length);
  const sources: VortexLattice['sources'] = {
    count: sigma.length,
    p0: Float32Array.from(p0),
    p1: Float32Array.from(p1),
    sigma: Float32Array.from(sigma),
  };
  setSourceMeta(sources, {
    groupStart: Int32Array.from(groupStart),
    coreRadius: Float32Array.from(core),
    groupChord: Float32Array.from(groupChord),
  });
  return sources;
}

interface WithSourcesEntry {
  geometry: WingGeometry;
  alpha: number;
  vInf: number;
  lattice: VortexLattice;
}
const withSourcesCache = new WeakMap<VortexLattice, WithSourcesEntry>();

/**
 * The lattice the flow field should use: the given lattice if it already carries thickness
 * sources, otherwise a shallow copy with sources built from the geometry (memoised; the input is
 * not mutated). The VLM leaves `sources` empty and the flow module fills them.
 */
export function withThicknessSources(
  lattice: VortexLattice,
  geometry: WingGeometry,
  alpha: number,
  vInf: number,
): VortexLattice {
  if (lattice.sources.count > 0) return lattice;
  const e = withSourcesCache.get(lattice);
  if (
    e &&
    e.geometry === geometry &&
    e.alpha === alpha &&
    e.vInf === vInf &&
    e.lattice.gamma === lattice.gamma &&
    e.lattice.a === lattice.a &&
    e.lattice.count === lattice.count &&
    e.lattice.coreRadius === lattice.coreRadius
  ) {
    return e.lattice;
  }
  const out: VortexLattice = {
    ...lattice,
    sources: buildThicknessSources(geometry, alpha, vInf),
  };
  withSourcesCache.set(lattice, { geometry, alpha, vInf, lattice: out });
  return out;
}
