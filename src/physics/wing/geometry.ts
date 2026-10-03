/**
 * WingConfig (UI parameters, degrees) -> WingGeometry (sections in body frame, radians, meters),
 * including the mirrored left side and tip-device surfaces.
 * OWNER: physics-geometry agent. CONTRACT — keep the exported signatures.
 *
 * Planform recipe (right wing, then mirrored):
 *   - Reference trapezoid with semispan s = span / 2, root chord c_r, tip chord c_t = lambda c_r.
 *     Chord is linear in y.
 *   - The quarter-chord line sweeps back at `sweepDeg`: x_qc(y) = c_r/4 + y tan(sweep), and the
 *     leading edge is x_le(y) = x_qc(y) - c(y)/4, so the root LE sits at the origin.
 *   - Dihedral lifts the surface: z = y tan(dihedral). Every base-wing section has that roll.
 *   - Incidence = root incidence - washout * (y / s), linear in y.
 *   - A "Yehudi" widens only the root chord (same LE) and puts a kink at the trapezoid chord, so
 *     the trailing edge is straight from the root to the kink.
 *   - Flaps add one extra station at the flap's outboard end. Sections at or inboard of it carry
 *     the flap, so only the segments between them are flapped.
 */
import type {
  FlapState,
  LiftingSurface,
  Naca4Params,
  Vec3,
  WingGeometry,
  WingSection,
} from '../types';
import type { WingConfig } from '../../state/params';
import { buildTipDeviceSurfaces } from './tipDevices';

const DEG = Math.PI / 180;

/** Smallest taper accepted; guards against zero-chord tips. */
const MIN_TAPER = 0.01;
/** Largest sweep (rad) accepted, so tan() stays finite. */
const MAX_SWEEP = 85 * DEG;
/**
 * Largest forward run of the Yehudi's trailing edge per metre of span, root to kink (45 deg).
 * A kink very close to the root would otherwise make a sliver whose trailing edge runs almost
 * streamwise; the vortex lattice skipped it and smeared the wide root chord over the whole wing
 * (lift ~22 % too high). Real Yehudis have a nearly straight trailing edge, so they are unaffected.
 */
const MAX_YEHUDI_TE_RUN = 1;

/* ------------------------------------------------------------------------------------------ */
/* Section axes                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface SectionFrame {
  /** Unit span tangent (direction of increasing span, root -> tip). */
  tangent: Vec3;
  /** Unit normal: the direction of the airfoil's "up" (upper surface). */
  normal: Vec3;
  /** Unit chord direction, LE -> TE, after twist. */
  chordDir: Vec3;
}

/**
 * Local axes of a section (see `WingSection` in types.ts). `side` selects the right-hand
 * definition or its y -> -y mirror. A positive twist rotates the chord direction toward -normal,
 * which lifts the leading edge toward the normal ("nose up").
 */
export function sectionFrame(section: WingSection, side: 'right' | 'left'): SectionFrame {
  const sr = Math.sin(section.roll);
  const cr = Math.cos(section.roll);
  const st = Math.sin(section.twist);
  const ct = Math.cos(section.twist);
  // Right-hand definitions; the left side flips the sign of every y component.
  const m = side === 'right' ? 1 : -1;
  return {
    tangent: [0, m * cr, sr],
    normal: [0, -m * sr, cr],
    chordDir: [ct, m * st * sr, -st * cr],
  };
}

/** Trailing-edge point of a section (body frame), at the unflapped chord. */
export function sectionTrailingEdge(section: WingSection, side: 'right' | 'left'): Vec3 {
  const { chordDir } = sectionFrame(section, side);
  return [
    section.le[0] + section.chord * chordDir[0],
    section.le[1] + section.chord * chordDir[1],
    section.le[2] + section.chord * chordDir[2],
  ];
}

/* ------------------------------------------------------------------------------------------ */
/* Mirroring                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function copyAirfoil(a: Naca4Params): Naca4Params {
  return { camber: a.camber, camberPos: a.camberPos, thickness: a.thickness };
}

function copyFlap(f: FlapState | null): FlapState | null {
  return f ? { chordFrac: f.chordFrac, deflection: f.deflection } : null;
}

/**
 * Exact mirror y -> -y of a right-hand surface. Roll and twist keep their values because the
 * section axes of the left side are defined as the mirror image (see `WingSection`).
 */
function mirrorSurface(surface: LiftingSurface): LiftingSurface {
  return {
    id: surface.id.replace(/-right$/, '-left'),
    name: surface.name.replace(/^Right /, 'Left '),
    side: 'left',
    role: surface.role,
    sections: surface.sections.map((s) => ({
      le: [s.le[0], 0 - s.le[1], s.le[2]],
      chord: s.chord,
      twist: s.twist,
      roll: s.roll,
      airfoil: copyAirfoil(s.airfoil),
      flap: copyFlap(s.flap),
      slat: s.slat,
    })),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Base wing                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** Right-hand base-wing sections, root -> tip. */
function buildBaseWingSections(config: WingConfig): WingSection[] {
  const semispan = config.span / 2;
  const rootChord = config.rootChord;
  const taper = Math.max(MIN_TAPER, config.taperRatio);
  const tipChord = taper * rootChord;
  const tanSweep = Math.tan(Math.min(MAX_SWEEP, Math.max(-MAX_SWEEP, config.sweepDeg * DEG)));
  const dihedral = config.dihedralDeg * DEG;
  const tanDihedral = Math.tan(dihedral);
  const rootIncidence = config.rootIncidenceDeg * DEG;
  const washout = config.washoutDeg * DEG;
  // Stations closer than 0.1 % of the semispan merge, so no spanwise segment is a sliver.
  const tol = 1e-3 * semispan;

  // Reference trapezoid chord and leading edge at spanwise station y.
  const trapezoidChord = (y: number): number => rootChord + (tipChord - rootChord) * (y / semispan);
  const leadingEdgeX = (y: number): number => rootChord / 4 + y * tanSweep - trapezoidChord(y) / 4;

  // Yehudi: wider root chord, same leading edge, kink back on the trapezoid at yKink. The root
  // chord is capped so the trailing edge runs forward at most MAX_YEHUDI_TE_RUN per metre to the
  // kink, which also shrinks the extension continuously to nothing as the kink nears the root.
  const yKink = Math.min(config.yehudi.spanFrac, 0.95) * semispan;
  const hasYehudi = config.yehudi.spanFrac > 0 && config.yehudi.chordFrac > 0 && yKink > tol;
  const kinkTrailingEdgeX = leadingEdgeX(yKink) + trapezoidChord(yKink);
  const yehudiRootChord = Math.max(
    rootChord,
    Math.min(
      rootChord * (1 + config.yehudi.chordFrac),
      kinkTrailingEdgeX + MAX_YEHUDI_TE_RUN * yKink,
    ),
  );
  const chordAt = (y: number): number => {
    if (hasYehudi && y < yKink) {
      return yehudiRootChord + (trapezoidChord(yKink) - yehudiRootChord) * (y / yKink);
    }
    return trapezoidChord(y);
  };

  // Spanwise stations: root, optional kink, optional flap end, tip.
  const stations: number[] = [0, semispan];
  const addStation = (y: number): void => {
    if (y <= tol || y >= semispan - tol) return;
    if (stations.some((v) => Math.abs(v - y) <= tol)) return;
    stations.push(y);
  };
  const hasFlaps = config.flaps.deflectionDeg > 0;
  const flapEnd = Math.min(1, Math.max(0, config.flaps.spanFrac)) * semispan;
  if (hasYehudi) addStation(yKink);
  if (hasFlaps) addStation(flapEnd);
  stations.sort((a, b) => a - b);

  const flapDeflection = config.flaps.deflectionDeg * DEG;

  return stations.map((y): WingSection => {
    const flapped = hasFlaps && y <= flapEnd + tol;
    return {
      le: [leadingEdgeX(y), y, y * tanDihedral],
      chord: chordAt(y),
      twist: rootIncidence - washout * (y / semispan),
      roll: dihedral,
      airfoil: copyAirfoil(config.airfoil),
      flap: flapped ? { chordFrac: config.flaps.chordFrac, deflection: flapDeflection } : null,
      slat: config.slats,
    };
  });
}

/** Length of the segment between two sections measured along the span (the y-z distance). */
function spanLength(a: WingSection, b: WingSection): number {
  return Math.hypot(b.le[1] - a.le[1], b.le[2] - a.le[2]);
}

/**
 * Build the complete wing geometry for a configuration: the base wing, any tip devices, and the
 * exact left-hand mirror of all of them. Surface order is wing-right, wing-left, then each device
 * right/left pair.
 */
export function buildWingGeometry(config: WingConfig): WingGeometry {
  const semispan = config.span / 2;
  const rootChord = config.rootChord;
  const taper = Math.max(MIN_TAPER, config.taperRatio);

  const wingSections = buildBaseWingSections(config);
  const wingRight: LiftingSurface = {
    id: 'wing-right',
    name: 'Right wing',
    side: 'right',
    role: 'wing',
    sections: wingSections,
  };
  const tip = wingSections[wingSections.length - 1]!;
  const deviceRight = buildTipDeviceSurfaces(tip, config.tipDevice, semispan);

  const surfaces: LiftingSurface[] = [wingRight, mirrorSurface(wingRight)];
  for (const d of deviceRight) surfaces.push(d, mirrorSurface(d));

  // Reference quantities come from the base trapezoid (Yehudi and tip devices excluded).
  const referenceArea = (config.span * rootChord * (1 + taper)) / 2;
  const meanAeroChord = ((2 / 3) * rootChord * (1 + taper + taper * taper)) / (1 + taper);

  let maxY = 0;
  let wettedArea = 0;
  for (const surface of surfaces) {
    const secs = surface.sections;
    for (let i = 0; i < secs.length; i++) {
      const sec = secs[i]!;
      maxY = Math.max(
        maxY,
        Math.abs(sec.le[1]),
        Math.abs(sectionTrailingEdge(sec, surface.side)[1]),
      );
      if (i + 1 < secs.length) {
        const next = secs[i + 1]!;
        const meanChord = (sec.chord + next.chord) / 2;
        const thickness = (sec.airfoil.thickness + next.airfoil.thickness) / 2;
        wettedArea += 2 * (1 + 0.25 * thickness) * meanChord * spanLength(sec, next);
      }
    }
  }

  return {
    surfaces,
    pivot: [rootChord / 4, 0, 0],
    referenceArea,
    referenceSpan: config.span,
    meanAeroChord,
    aspectRatio: (config.span * config.span) / referenceArea,
    overallSpan: 2 * maxY,
    wettedArea,
    sweepQuarterChord: config.sweepDeg * DEG,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Interpolation                                                                               */
/* ------------------------------------------------------------------------------------------ */

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/**
 * Interpolate a section along a surface at parameter s in [0, sections.length - 1]
 * (integer part = segment index, fractional part = position within the segment).
 * Interpolates le, chord, twist, roll and airfoil linearly. The flap is the inboard section's flap
 * only when BOTH bounding sections have one (else null); slat likewise needs both ends true.
 */
export function interpolateSection(surface: LiftingSurface, s: number): WingSection {
  const sections = surface.sections;
  const last = sections.length - 1;
  if (last < 1) {
    const only = sections[0];
    if (!only) throw new Error(`Surface ${surface.id} has no sections`);
    return {
      ...only,
      le: [...only.le],
      airfoil: copyAirfoil(only.airfoil),
      flap: copyFlap(only.flap),
    };
  }
  const sc = Number.isFinite(s) ? Math.min(last, Math.max(0, s)) : 0;
  const i = Math.min(Math.floor(sc), last - 1);
  const f = sc - i;
  const a = sections[i]!;
  const b = sections[i + 1]!;
  return {
    le: [lerp(a.le[0], b.le[0], f), lerp(a.le[1], b.le[1], f), lerp(a.le[2], b.le[2], f)],
    chord: lerp(a.chord, b.chord, f),
    twist: lerp(a.twist, b.twist, f),
    roll: lerp(a.roll, b.roll, f),
    airfoil: {
      camber: lerp(a.airfoil.camber, b.airfoil.camber, f),
      camberPos: lerp(a.airfoil.camberPos, b.airfoil.camberPos, f),
      thickness: lerp(a.airfoil.thickness, b.airfoil.thickness, f),
    },
    flap: a.flap && b.flap ? copyFlap(a.flap) : null,
    slat: a.slat && b.slat,
  };
}
