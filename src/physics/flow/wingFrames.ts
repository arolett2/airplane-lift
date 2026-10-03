/**
 * Local helpers that map airfoil coordinates onto the 3D wing (see the WingSection doc in
 * physics/types.ts). Self-contained so the flow module does not depend on the geometry module's
 * implementation.
 */
import type { FlapState, LiftingSurface, Naca4Params, Vec3, WingGeometry } from '../types';

/** Orthonormal axes of a section, BODY frame. */
export interface SectionAxes {
  le: Vec3;
  chord: number;
  /** Along the chord, LE -> TE. */
  chordDir: Vec3;
  /** Section "up" (airfoil y), perpendicular to chordDir and spanDir. */
  normalDir: Vec3;
  /** Span tangent, pointing outboard along the surface. */
  spanDir: Vec3;
}

/**
 * Section axes from le / chord / twist / roll. Right side: span tangent t = (0, cos r, sin r),
 * normal n = (0, -sin r, cos r); the chord direction is +x rotated by `twist` about t (nose-up
 * positive), and the normal is rotated with it. The left side mirrors y.
 */
export function sectionAxes(
  le: Vec3,
  chord: number,
  twist: number,
  roll: number,
  side: 'right' | 'left',
): SectionAxes {
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ct = Math.cos(twist);
  const st = Math.sin(twist);
  const m = side === 'left' ? -1 : 1;
  return {
    le: [le[0], le[1], le[2]],
    chord,
    chordDir: [ct, m * sr * st, -cr * st],
    normalDir: [st, -m * sr * ct, cr * ct],
    spanDir: [0, m * cr, sr],
  };
}

/** Section properties interpolated linearly between sections i and i+1 at fraction s (0..1). */
export interface SegmentSection {
  axes: SectionAxes;
  airfoil: Naca4Params;
  /** Segment flap: the inboard section's flap when BOTH ends have one, else null. */
  flap: FlapState | null;
}

/** Flap rule for a spanwise segment (see WingSection.flap). */
export function segmentFlap(surface: LiftingSurface, i: number): FlapState | null {
  const a = surface.sections[i];
  const b = surface.sections[i + 1];
  if (!a || !b || !a.flap || !b.flap) return null;
  return a.flap;
}

export function interpolateSegment(surface: LiftingSurface, i: number, s: number): SegmentSection {
  const a = surface.sections[i]!;
  const b = surface.sections[i + 1]!;
  const lerp = (p: number, q: number) => p + (q - p) * s;
  const le: Vec3 = [lerp(a.le[0], b.le[0]), lerp(a.le[1], b.le[1]), lerp(a.le[2], b.le[2])];
  const axes = sectionAxes(
    le,
    lerp(a.chord, b.chord),
    lerp(a.twist, b.twist),
    lerp(a.roll, b.roll),
    surface.side,
  );
  const airfoil: Naca4Params = {
    camber: lerp(a.airfoil.camber, b.airfoil.camber),
    camberPos: lerp(a.airfoil.camberPos, b.airfoil.camberPos),
    thickness: lerp(a.airfoil.thickness, b.airfoil.thickness),
  };
  return { axes, airfoil, flap: segmentFlap(surface, i) };
}

/** Point on the section at airfoil coords (x, y) (unit chord), BODY frame. */
export function sectionPoint(axes: SectionAxes, x: number, y: number): Vec3 {
  const c = axes.chord;
  return [
    axes.le[0] + c * (x * axes.chordDir[0] + y * axes.normalDir[0]),
    axes.le[1] + c * (x * axes.chordDir[1] + y * axes.normalDir[1]),
    axes.le[2] + c * (x * axes.chordDir[2] + y * axes.normalDir[2]),
  ];
}

/** In-plane spanwise length of a segment (distance between the two leading-edge points in y-z). */
export function segmentSpanLength(surface: LiftingSurface, i: number): number {
  const a = surface.sections[i]!.le;
  const b = surface.sections[i + 1]!.le;
  return Math.hypot(b[1] - a[1], b[2] - a[2]);
}

export function semispan(geometry: WingGeometry): number {
  if (geometry.referenceSpan > 0) return geometry.referenceSpan / 2;
  let m = 0;
  for (const s of geometry.surfaces) for (const sec of s.sections) m = Math.max(m, sec.le[1]);
  return Math.max(m, 1e-3);
}

/** Longest chord of any section (m). */
export function maxChord(geometry: WingGeometry): number {
  let c = 0;
  for (const s of geometry.surfaces) for (const sec of s.sections) c = Math.max(c, sec.chord);
  return c;
}
