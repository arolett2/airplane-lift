/**
 * Hand-built physics-shaped data for render tests. The physics modules are developed in
 * parallel (and throw until merged), so the render tests construct their own wing geometry,
 * strips and aero results here. Not used by the app.
 */
import type {
  AeroResult,
  FlapState,
  LiftingSurface,
  StripResult,
  Vec3,
  WingGeometry,
  WingSection,
} from '../../physics/types';
import { cosineSpacing } from '../../physics/airfoil/naca';
import { sectionAxes } from '../wing/loft';

export interface TestWingOptions {
  semispan?: number;
  rootChord?: number;
  tipChord?: number;
  sweepDeg?: number;
  dihedralDeg?: number;
  /** Flap applied from the root to 60 % of the semispan. */
  flap?: FlapState | null;
  slats?: boolean;
  /** Add a canted winglet on each tip. */
  winglet?: boolean;
  twistTipDeg?: number;
}

const NACA2412 = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };

function mirrorSection(s: WingSection): WingSection {
  return { ...s, le: [s.le[0], -s.le[1], s.le[2]] };
}

/** A three-section trapezoidal wing (plus optional winglets), both sides, in the body frame. */
export function makeTestWing(opts: TestWingOptions = {}): WingGeometry {
  const s = opts.semispan ?? 5;
  const c0 = opts.rootChord ?? 1.6;
  const c1 = opts.tipChord ?? 0.8;
  const sweep = ((opts.sweepDeg ?? 15) * Math.PI) / 180;
  const dih = ((opts.dihedralDeg ?? 0) * Math.PI) / 180;
  const flap = opts.flap ?? null;
  const slat = opts.slats ?? false;
  const twistTip = ((opts.twistTipDeg ?? 0) * Math.PI) / 180;

  const at = (eta: number, withFlap: boolean): WingSection => {
    const chord = c0 + (c1 - c0) * eta;
    const qc = 0.25 * c0 + Math.tan(sweep) * eta * s;
    return {
      le: [qc - 0.25 * chord, eta * s * Math.cos(dih), eta * s * Math.sin(dih)],
      chord,
      twist: twistTip * eta,
      roll: dih,
      airfoil: { ...NACA2412 },
      flap: withFlap ? flap : null,
      slat,
    };
  };
  const right: WingSection[] = [at(0, true), at(0.6, true), at(1, false)];
  const surfaces: LiftingSurface[] = [
    { id: 'right-wing', name: 'Right wing', side: 'right', role: 'wing', sections: right },
    {
      id: 'left-wing',
      name: 'Left wing',
      side: 'left',
      role: 'wing',
      sections: right.map(mirrorSection),
    },
  ];
  if (opts.winglet) {
    const tip = right[2]!;
    const h = 0.12 * s;
    const base: WingSection = { ...tip, roll: 1.35, flap: null, slat: false };
    const top: WingSection = {
      ...base,
      le: [tip.le[0] + 0.5 * h, tip.le[1] + 0.2 * h, tip.le[2] + h],
      chord: 0.5 * tip.chord,
      airfoil: { ...NACA2412, camber: 0 },
    };
    const wl = [base, top];
    surfaces.push(
      {
        id: 'right-winglet',
        name: 'Right winglet',
        side: 'right',
        role: 'tip-device',
        sections: wl,
      },
      {
        id: 'left-winglet',
        name: 'Left winglet',
        side: 'left',
        role: 'tip-device',
        sections: wl.map(mirrorSection),
      },
    );
  }
  const span = 2 * s;
  const area = 0.5 * (c0 + c1) * span;
  return {
    surfaces,
    pivot: [0.25 * c0, 0, 0],
    referenceArea: area,
    referenceSpan: span,
    meanAeroChord: area / span,
    aspectRatio: (span * span) / area,
    overallSpan: span + (opts.winglet ? 0 : 0),
    wettedArea: 2 * area,
    sweepQuarterChord: sweep,
  };
}

/** Quarter-chord point of a section in the body frame. */
export function quarterChord(sec: WingSection, side: 'right' | 'left'): Vec3 {
  const chord: Vec3 = [1, 0, 0];
  const normal: Vec3 = [0, 0, 1];
  sectionAxes(sec.roll, sec.twist, side, chord, normal);
  return [
    sec.le[0] + 0.25 * sec.chord * chord[0],
    sec.le[1] + 0.25 * sec.chord * chord[1],
    sec.le[2] + 0.25 * sec.chord * chord[2],
  ];
}

export interface TestStripOptions {
  /** Strips per surface (default 12). */
  perSurface?: number;
  /** Strips at or beyond this eta (0..1 on the base wing) are flagged stalled. */
  stallFromEta?: number;
  /** Peak strip cl (default 0.9). */
  peakCl?: number;
  /** Section clMax (default 1.5). */
  clMax?: number;
}

/**
 * Strips along each surface's quarter-chord line (body frame == tunnel frame at zero alpha),
 * with an elliptical cl distribution and a simple suction-peak Cp.
 */
export function makeTestStrips(geometry: WingGeometry, opts: TestStripOptions = {}): StripResult[] {
  const n = opts.perSurface ?? 12;
  const peak = opts.peakCl ?? 0.9;
  const clMax = opts.clMax ?? 1.5;
  const strips: StripResult[] = [];
  const xs = cosineSpacing(40);
  const xc = Float32Array.from(xs);
  for (const surface of geometry.surfaces) {
    const secs = surface.sections;
    const q = secs.map((sec) => quarterChord(sec, surface.side));
    const segLen: number[] = [];
    let total = 0;
    for (let i = 0; i + 1 < q.length; i++) {
      const l = Math.hypot(
        q[i + 1]![0] - q[i]![0],
        q[i + 1]![1] - q[i]![1],
        q[i + 1]![2] - q[i]![2],
      );
      segLen.push(l);
      total += l;
    }
    const isDevice = surface.role === 'tip-device';
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      // Locate the segment holding arc length f * total.
      let d = f * total;
      let seg = 0;
      while (seg < segLen.length - 1 && d > segLen[seg]!) {
        d -= segLen[seg]!;
        seg++;
      }
      const t = segLen[seg]! > 0 ? d / segLen[seg]! : 0;
      const a = secs[seg]!;
      const b = secs[seg + 1]!;
      const chord = a.chord + (b.chord - a.chord) * t;
      const roll = a.roll + (b.roll - a.roll) * t;
      const center: Vec3 = [
        q[seg]![0] + (q[seg + 1]![0] - q[seg]![0]) * t,
        q[seg]![1] + (q[seg + 1]![1] - q[seg]![1]) * t,
        q[seg]![2] + (q[seg + 1]![2] - q[seg]![2]) * t,
      ];
      const chordDir: Vec3 = [1, 0, 0];
      const normal: Vec3 = [0, 0, 1];
      sectionAxes(roll, 0, surface.side, chordDir, normal);
      const eta = isDevice ? 1 + f * 0.2 : f;
      const cl = peak * Math.sqrt(Math.max(0, 1 - f * f));
      const stalled = opts.stallFromEta !== undefined && !isDevice && f >= opts.stallFromEta;
      const upper = new Float32Array(xc.length);
      const lower = new Float32Array(xc.length);
      for (let i = 0; i < xc.length; i++) {
        const x = xc[i]!;
        upper[i] =
          -(0.4 + 2.2 * cl) * Math.exp(-6 * x) - 0.3 * cl * (1 - x) + 0.9 * Math.exp(-80 * x);
        lower[i] = 0.35 * (1 - x) - 0.1 * x;
      }
      strips.push({
        surfaceId: surface.id,
        side: surface.side,
        center,
        eta,
        width: total / n,
        chord,
        cl,
        clMax,
        alphaGeometric: 0.1,
        alphaInduced: 0.02,
        alphaEffective: 0.08,
        cd: 0.01,
        circulation: 10 * cl,
        liftPerSpan: 5000 * cl * (chord / c0Of(geometry)),
        normal,
        stalled,
        attachedFraction: stalled ? 0.55 : 1,
        cp: { xc, upper, lower },
      });
    }
  }
  return strips;
}

function c0Of(g: WingGeometry): number {
  return g.surfaces[0]?.sections[0]?.chord ?? 1;
}

/** A complete AeroResult around the given strips (level-flight-ish numbers). */
export function makeTestAero(
  geometry: WingGeometry,
  strips: StripResult[] = makeTestStrips(geometry),
  overrides: Partial<AeroResult> = {},
): AeroResult {
  const lift = 60_000;
  const drag = 4_000;
  return {
    requestId: 1,
    atmosphere: {
      altitude: 0,
      temperature: 288.15,
      pressure: 101325,
      density: 1.225,
      speedOfSound: 340.3,
      dynamicViscosity: 1.79e-5,
    },
    velocity: 60,
    mach: 0.18,
    dynamicPressure: 2205,
    reynoldsMac: 6e6,
    alpha: 0.087,
    CL: 0.9,
    CDi: 0.03,
    CD0: 0.012,
    CDw: 0,
    CD: 0.042,
    Cm: -0.05,
    liftToDrag: lift / drag,
    spanEfficiency: 0.85,
    lift,
    drag,
    inducedDrag: 2_500,
    liftSlope: 4.8,
    machCritical: 0.7,
    machDragDivergence: 0.75,
    stall: { any: false, fraction: 0, firstEta: null, margin: 0.6 },
    strips,
    lattice: {
      count: 0,
      a: new Float32Array(0),
      b: new Float32Array(0),
      teA: new Float32Array(0),
      teB: new Float32Array(0),
      gamma: new Float32Array(0),
      sources: {
        count: 0,
        p0: new Float32Array(0),
        p1: new Float32Array(0),
        sigma: new Float32Array(0),
      },
      coreRadius: 0.01,
    },
    force: [drag, 0, lift],
    centerOfPressure: [geometry.pivot[0], 0, geometry.pivot[2]],
    warnings: [],
    ...overrides,
  };
}
