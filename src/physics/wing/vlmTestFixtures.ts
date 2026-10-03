/**
 * Test fixtures for the VLM (independent of the geometry and airfoil modules):
 * - makeTestWing: straight-tapered wing with optional quarter-chord sweep, dihedral, linear
 *   washout, an inboard flap, and tip devices (winglets / in-plane extensions) on both sides.
 * - makeMockPolar: a smooth analytic section polar with a stall peak and post-stall decline.
 */
import type {
  FlapState,
  LiftingSurface,
  Naca4Params,
  SectionPolar,
  Vec3,
  WingGeometry,
  WingSection,
} from '../types';

const DEG = Math.PI / 180;

export interface TestWingletSpec {
  /** Height (along the device span) as a fraction of the base semispan. */
  heightFrac: number;
  /** Cant from vertical (deg): 0 = straight up, 90 = in-plane extension, 180 = straight down. */
  cantDeg?: number;
  /** Leading-edge sweep (deg). */
  sweepDeg?: number;
  /** Device tip chord / wing tip chord. */
  taper?: number;
  /** Device incidence (twist about its own span tangent, rad sign convention of WingSection). */
  twistDeg?: number;
}

export interface TestWingSpec {
  span: number;
  rootChord: number;
  taper?: number;
  sweepQuarterDeg?: number;
  dihedralDeg?: number;
  rootIncidenceDeg?: number;
  washoutDeg?: number;
  airfoil?: Naca4Params;
  flap?: { chordFrac: number; deflectionDeg: number; spanFrac: number };
  slat?: boolean;
  devices?: TestWingletSpec[];
}

export const FLAT_PLATE: Naca4Params = { camber: 0, camberPos: 0.4, thickness: 0.12 };

function mirrorSurface(s: LiftingSurface): LiftingSurface {
  return {
    ...s,
    id: s.id.replace('right', 'left'),
    name: s.name.replace('Right', 'Left'),
    side: 'left',
    sections: s.sections.map((sec) => ({ ...sec, le: [sec.le[0], -sec.le[1], sec.le[2]] as Vec3 })),
  };
}

export function makeTestWing(spec: TestWingSpec): WingGeometry {
  const taper = spec.taper ?? 1;
  const b2 = spec.span / 2;
  const cr = spec.rootChord;
  const ct = cr * taper;
  const sweep = (spec.sweepQuarterDeg ?? 0) * DEG;
  const dihedral = (spec.dihedralDeg ?? 0) * DEG;
  const inc0 = (spec.rootIncidenceDeg ?? 0) * DEG;
  const washout = (spec.washoutDeg ?? 0) * DEG;
  const airfoil = spec.airfoil ?? FLAT_PLATE;
  const slat = spec.slat ?? false;

  const sectionAt = (eta: number, flap: FlapState | null): WingSection => {
    const y = eta * b2;
    const c = cr + (ct - cr) * eta;
    const xq = y * Math.tan(sweep);
    return {
      le: [xq - 0.25 * c, y, y * Math.tan(dihedral)],
      chord: c,
      twist: inc0 - washout * eta,
      roll: dihedral,
      airfoil: { ...airfoil },
      flap,
      slat,
    };
  };

  const flapState: FlapState | null = spec.flap
    ? { chordFrac: spec.flap.chordFrac, deflection: spec.flap.deflectionDeg * DEG }
    : null;
  const sections: WingSection[] = [];
  if (spec.flap && spec.flap.spanFrac < 1) {
    sections.push(sectionAt(0, flapState), sectionAt(spec.flap.spanFrac, flapState));
    sections.push(sectionAt(1, null));
  } else {
    sections.push(sectionAt(0, flapState), sectionAt(1, flapState));
  }
  const wing: LiftingSurface = {
    id: 'wing-right',
    name: 'Right wing',
    side: 'right',
    role: 'wing',
    sections,
  };
  const right: LiftingSurface[] = [wing];

  const tip = sections[sections.length - 1]!;
  (spec.devices ?? []).forEach((d, i) => {
    const h = d.heightFrac * b2;
    const roll = Math.PI / 2 - (d.cantDeg ?? 0) * DEG;
    const sweepLe = (d.sweepDeg ?? 0) * DEG;
    const twist = (d.twistDeg ?? 0) * DEG;
    const root: WingSection = { ...tip, flap: null, twist, roll, airfoil: { ...airfoil } };
    const top: WingSection = {
      ...root,
      le: [
        tip.le[0] + h * Math.tan(sweepLe),
        tip.le[1] + h * Math.cos(roll),
        tip.le[2] + h * Math.sin(roll),
      ],
      chord: tip.chord * (d.taper ?? 1),
    };
    right.push({
      id: `device${i}-right`,
      name: `Right device ${i}`,
      side: 'right',
      role: 'tip-device',
      sections: [root, top],
    });
  });

  const area = spec.span * cr * (1 + taper) * 0.5;
  const mac = ((2 / 3) * cr * (1 + taper + taper * taper)) / (1 + taper);
  return {
    surfaces: [...right, ...right.map(mirrorSurface)],
    pivot: [0, 0, 0],
    referenceArea: area,
    referenceSpan: spec.span,
    meanAeroChord: mac,
    aspectRatio: (spec.span * spec.span) / area,
    overallSpan: spec.span,
    wettedArea: 2.04 * area,
    sweepQuarterChord: sweep,
  };
}

/**
 * Untwisted flat-plate wing with an elliptic chord distribution (straight quarter-chord line),
 * approximated by `nSections` sections per side placed with cosine spacing toward the tip.
 * Classic result: constant downwash CL / (pi AR), span efficiency 1.
 */
export function makeEllipticWing(aspectRatio: number, span = 6, nSections = 41): WingGeometry {
  const b2 = span / 2;
  const area = (span * span) / aspectRatio;
  const c0 = (4 * area) / (Math.PI * span);
  const sections: WingSection[] = [];
  for (let k = 0; k < nSections; k++) {
    const eta = Math.sin(((Math.PI / 2) * k) / (nSections - 1));
    const c = Math.max(1e-4 * c0, c0 * Math.sqrt(Math.max(0, 1 - eta * eta)));
    sections.push({
      le: [-0.25 * c, eta * b2, 0],
      chord: c,
      twist: 0,
      roll: 0,
      airfoil: { ...FLAT_PLATE },
      flap: null,
      slat: false,
    });
  }
  const right: LiftingSurface = {
    id: 'wing-right',
    name: 'Right wing',
    side: 'right',
    role: 'wing',
    sections,
  };
  return {
    surfaces: [right, mirrorSurface(right)],
    pivot: [0, 0, 0],
    referenceArea: area,
    referenceSpan: span,
    meanAeroChord: (8 * c0) / (3 * Math.PI),
    aspectRatio,
    overallSpan: span,
    wettedArea: 2.04 * area,
    sweepQuarterChord: 0,
  };
}

export interface MockPolarSpec {
  /** Zero-lift angle (rad). */
  alphaZeroLift: number;
  /** Linear lift slope (per rad), default 2 pi. */
  liftSlope?: number;
  /** Angle of peak cl (rad); default 14 deg above the zero-lift angle. */
  alphaStall?: number;
  /** Width of the rounded top before the peak (rad), default 3 deg. */
  roundness?: number;
  /** Fractional cl loss far past stall, default 0.4. */
  drop?: number;
  /** Angular scale of the post-stall decline (rad), default 6 deg. */
  decay?: number;
}

/**
 * Analytic polar, odd about the zero-lift angle: linear, then a parabolic rounding to zero slope
 * at alphaStall, then a Gaussian-shaped decline to (1 - drop) * clMax.
 */
export function makeMockPolar(spec: MockPolarSpec): SectionPolar {
  const a0 = spec.alphaZeroLift;
  const a = spec.liftSlope ?? 2 * Math.PI;
  const xs = (spec.alphaStall ?? a0 + 14 * DEG) - a0;
  const w = spec.roundness ?? 3 * DEG;
  const drop = spec.drop ?? 0.4;
  const tau = spec.decay ?? 6 * DEG;
  const x1 = xs - w;
  const clMax = a * (x1 + w / 2);
  const shape = (x: number): number => {
    if (x <= x1) return a * x;
    if (x <= xs) return a * (x - ((x - x1) * (x - x1)) / (2 * w));
    const d = (x - xs) / tau;
    return clMax * (1 - drop * (1 - Math.exp(-d * d)));
  };
  const cl = (alpha: number) => {
    const x = alpha - a0;
    return x >= 0 ? shape(x) : -shape(-x);
  };
  const attached = (alpha: number) => {
    const x = Math.abs(alpha - a0);
    if (x <= xs) return 1;
    const d = (x - xs) / tau;
    return Math.exp(-d * d);
  };
  return {
    alphaZeroLift: a0,
    liftSlope: a,
    clMax: () => clMax,
    alphaStall: () => a0 + xs,
    cl: (alpha) => cl(alpha),
    cd: (alpha) => 0.008 + 0.01 * (alpha - a0) ** 2 + 0.3 * (1 - attached(alpha)),
    cm: () => 0,
    attachedFraction: (alpha) => attached(alpha),
  };
}

/**
 * Polar shaped like the airfoil module's viscous polars past stall: slope 2 pi, a rounded peak at
 * `alphaStall`, then a blend (over ~4 deg) to the flat-plate curve 1.8 sin(a) cos(a), which stays
 * near 0.8-0.9 out to 45 deg. Deep-stall strips on this polar settle at large effective angles,
 * which is where the coupling's artificial viscosity bites hardest. Odd about the zero-lift angle.
 */
export function makeFlatPlateStallPolar(alphaZeroLift: number, alphaStall: number): SectionPolar {
  const a0 = alphaZeroLift;
  const slope = 2 * Math.PI;
  const w = 3 * DEG;
  const x1 = alphaStall - w;
  const peak = slope * (x1 - a0 + w / 2);
  const pre = (a: number) =>
    a <= x1 ? slope * (a - a0) : slope * (a - a0 - ((a - x1) * (a - x1)) / (2 * w));
  const cl = (a: number): number => {
    if (a < 2 * a0 - alphaStall) return -cl(2 * a0 - a);
    if (a <= alphaStall) return pre(a);
    const t = 1 - Math.exp(-(a - alphaStall) / (4 * DEG));
    return peak + (1.8 * Math.sin(a) * Math.cos(a) - peak) * t;
  };
  const attached = (a: number) => {
    const x = Math.abs(a - a0) - (alphaStall - a0);
    return x <= 0 ? 1 : Math.exp(-x / (6 * DEG));
  };
  return {
    alphaZeroLift: a0,
    liftSlope: slope,
    clMax: () => peak,
    alphaStall: () => alphaStall,
    cl,
    cd: (a) => 0.008 + 0.3 * (1 - attached(a)),
    cm: () => 0,
    attachedFraction: attached,
  };
}
