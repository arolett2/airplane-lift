/**
 * Hand-built solver-result fixtures for the visualisation tests. They are plausible, not exact:
 * the 2D flow is a uniform stream plus a doublet around an ellipse, which is enough to exercise
 * the drawing and animation maths without the real physics modules.
 */
import type {
  AeroResult,
  ChordwiseCp,
  LiftingSurface,
  PolarSweep,
  SectionFlow,
  Streamline2D,
  StripResult,
  WingGeometry,
  WingSection,
} from '../../physics/types';
import { DEFAULT_WING } from '../../state/params';
import type { AircraftPreset } from '../../state/presets';

export const DEG = Math.PI / 180;

export function makePolar(): PolarSweep {
  const n = 25;
  const alphaDeg = new Float32Array(n);
  const CL = new Float32Array(n);
  const CD = new Float32Array(n);
  const sectionCl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = -4 + i;
    alphaDeg[i] = a;
    const pre = 0.085 * (a + 2);
    CL[i] = a <= 14 ? pre : 0.085 * 16 - 0.06 * (a - 14);
    CD[i] = 0.012 + (CL[i]! * CL[i]!) / (Math.PI * 8 * 0.9) + (a > 14 ? 0.02 * (a - 14) : 0);
    sectionCl[i] = 0.11 * (a + 2);
  }
  return { requestId: 1, alphaDeg, CL, CD, sectionCl, alphaStallDeg: 14, CLmax: 0.085 * 16 };
}

export function makeCp(): ChordwiseCp {
  const n = 21;
  const xc = new Float32Array(n);
  const upper = new Float32Array(n);
  const lower = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (1 - Math.cos((i / (n - 1)) * Math.PI)) / 2;
    xc[i] = x;
    upper[i] = -1.6 * Math.exp(-x * 5) - 0.25 + (i === 0 ? 1.2 : 0);
    lower[i] = 0.45 * Math.exp(-x * 4) - 0.1;
  }
  return { xc, upper, lower };
}

export function makeStrip(
  surfaceId: string,
  eta: number,
  over: Partial<StripResult> = {},
): StripResult {
  return {
    surfaceId,
    side: 'right',
    center: [0, eta * 5, 0],
    eta,
    width: 0.25,
    chord: 1.5,
    cl: 0.8 * Math.sqrt(Math.max(0, 1 - eta * eta)) + 0.1,
    clMax: 1.4,
    alphaGeometric: 5 * DEG,
    alphaInduced: 1 * DEG,
    alphaEffective: 4 * DEG,
    cd: 0.01,
    circulation: 10,
    liftPerSpan: 1000 * Math.sqrt(Math.max(0, 1 - eta * eta)) + 100,
    normal: [0, 0, 1],
    stalled: false,
    attachedFraction: 1,
    cp: makeCp(),
    ...over,
  };
}

export function makeAero(over: Partial<AeroResult> = {}, withDevice = false): AeroResult {
  const strips: StripResult[] = [];
  const nStrips = 16;
  for (let i = 0; i < nStrips; i++) {
    const eta = (i + 0.5) / nStrips;
    strips.push(makeStrip('right-wing', eta));
    strips.push(makeStrip('left-wing', eta, { side: 'left' }));
  }
  if (withDevice) {
    for (let i = 0; i < 4; i++) {
      strips.push(
        makeStrip('right-winglet', 1 + (i + 0.5) * 0.03, {
          liftPerSpan: 150,
          cl: 0.3,
          normal: [0, -1, 0],
        }),
      );
    }
  }
  const aero = {
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
    alpha: 5 * DEG,
    CL: 0.6,
    CDi: 0.01,
    CD0: 0.012,
    CDw: 0,
    CD: 0.022,
    Cm: -0.05,
    liftToDrag: 27,
    spanEfficiency: 0.9,
    lift: 13000,
    drag: 480,
    inducedDrag: 220,
    liftSlope: 4.6,
    machCritical: 0.72,
    machDragDivergence: 0.75,
    stall: { any: false, fraction: 0, firstEta: null, margin: 0.4 },
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
    force: [480, 0, 13000],
    centerOfPressure: [0.4, 0, 0],
    warnings: [],
    ...over,
  } as AeroResult;
  return aero;
}

/** Ellipse semi-axes used by the section fixture (a 12% thick "airfoil" centred at x = 0.5). */
const ELLIPSE_A = 0.5;
const ELLIPSE_B = 0.06;

/**
 * Exact potential flow around the fixture ellipse with circulation (Joukowski map of a circle),
 * in the airfoil frame with the freestream at angle `alpha`. Returns the velocity (u, v) at
 * (x, y) normalised by the freestream speed. Meaningless inside the ellipse (callers mask it).
 */
export function ellipseVelocity(x: number, y: number, alpha: number): [number, number] {
  const R = (ELLIPSE_A + ELLIPSE_B) / 2;
  const c2 = R * ((ELLIPSE_A - ELLIPSE_B) / 2);
  // z measured from the ellipse centre; invert z = zeta + c2 / zeta (outer branch).
  const zr = x - 0.5;
  const zi = y;
  // sqrt(z^2 - 4 c2) with the branch that keeps |zeta| >= R.
  const dr = zr * zr - zi * zi - 4 * c2;
  const di = 2 * zr * zi;
  const mag = Math.hypot(dr, di);
  let sr = Math.sqrt(Math.max(0, (mag + dr) / 2));
  let si = Math.sqrt(Math.max(0, (mag - dr) / 2)) * (di < 0 ? -1 : 1);
  if (sr * zr + si * zi < 0) {
    sr = -sr;
    si = -si;
  }
  const zetaR = (zr + sr) / 2;
  const zetaI = (zi + si) / 2;
  // 1/zeta and 1/zeta^2.
  const m2 = zetaR * zetaR + zetaI * zetaI;
  const invR = zetaR / m2;
  const invI = -zetaI / m2;
  const inv2R = invR * invR - invI * invI;
  const inv2I = 2 * invR * invI;
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const gamma = 4 * Math.PI * R * sa;
  // W'(zeta) = e^{-i a} - R^2 e^{i a} / zeta^2 + i gamma / (2 pi zeta)
  const wr = ca - R * R * (ca * inv2R - sa * inv2I) - (gamma / (2 * Math.PI)) * invI;
  const wi = -sa - R * R * (ca * inv2I + sa * inv2R) + (gamma / (2 * Math.PI)) * invR;
  // dz/dzeta = 1 - c2 / zeta^2
  const dzr = 1 - c2 * inv2R;
  const dzi = -c2 * inv2I;
  const dm = dzr * dzr + dzi * dzi;
  // (u - i v) = W' / (dz/dzeta)
  const ur = (wr * dzr + wi * dzi) / dm;
  const ui = (wi * dzr - wr * dzi) / dm;
  return [ur, -ui];
}

/** Surface Cp from the analytic flow (suction spike at the nose clamped to [-6, 1]). */
export function ellipseCp(alpha: number, n = 21): ChordwiseCp {
  const xc = new Float32Array(n);
  const upper = new Float32Array(n);
  const lower = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (1 - Math.cos((i / (n - 1)) * Math.PI)) / 2;
    xc[i] = x;
    const t = ELLIPSE_B * Math.sqrt(Math.max(0, 1 - ((x - 0.5) / ELLIPSE_A) ** 2));
    for (const [arr, sign] of [
      [upper, 1],
      [lower, -1],
    ] as const) {
      const [u, v] = ellipseVelocity(x, sign * (t + 0.004), alpha);
      arr[i] = Math.max(-6, Math.min(1, 1 - (u * u + v * v)));
    }
  }
  return { xc, upper, lower };
}

function velocityAt(x: number, y: number, alpha: number): [number, number] {
  return ellipseVelocity(x, y, alpha);
}

export function makeSection(over: Partial<SectionFlow> = {}): SectionFlow {
  const alpha = over.alphaEffective ?? 4 * DEG;
  const nx = 60;
  const ny = 40;
  const xMin = -0.6;
  const xMax = 1.8;
  const yMin = -0.6;
  const yMax = 0.6;
  const uv = new Float32Array(2 * nx * ny);
  const inside = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xMin + ((xMax - xMin) * i) / (nx - 1);
      const y = yMin + ((yMax - yMin) * j) / (ny - 1);
      const k = i + nx * j;
      const [u, v] = velocityAt(x, y, alpha);
      uv[2 * k] = u;
      uv[2 * k + 1] = v;
      const ex = (x - 0.5) / 0.5;
      const ey = y / 0.06;
      inside[k] = ex * ex + ey * ey < 1 ? 1 : 0;
    }
  }

  // Ellipse contour: TE, lower surface to the LE, upper surface back to the TE.
  const nc = 41;
  const contour = new Float32Array(2 * nc);
  for (let i = 0; i < nc; i++) {
    const t = Math.PI * 2 * (i / (nc - 1)); // 0 -> 2pi: TE -> lower -> LE -> upper -> TE
    contour[2 * i] = 0.5 + 0.5 * Math.cos(t);
    contour[2 * i + 1] = -0.06 * Math.sin(t);
  }

  const streamlines: Streamline2D[] = [];
  for (let s = 0; s < 14; s++) {
    const y0 = -0.5 + (s / 13) * 1.0;
    const pts: number[] = [];
    const speed: number[] = [];
    const time: number[] = [];
    let x = -0.6;
    let y = y0;
    let t = 0;
    for (let step = 0; step < 150 && x < 1.8; step++) {
      const [u, v] = velocityAt(x, y, alpha);
      const sp = Math.hypot(u, v);
      pts.push(x, y);
      speed.push(sp);
      time.push(t);
      const h = 0.02;
      x += (u / sp) * h;
      y += (v / sp) * h;
      t += h / sp;
    }
    streamlines.push({
      points: Float32Array.from(pts),
      speed: Float32Array.from(speed),
      time: Float32Array.from(time),
    });
  }

  return {
    eta: 0.35,
    alphaEffective: alpha,
    alphaGeometric: alpha + 1 * DEG,
    alphaInduced: 1 * DEG,
    contour,
    cp: makeCp(),
    cl: 0.7,
    stalled: false,
    attachedFraction: 1,
    stagnation: [0.002, -0.004],
    grid: { xMin, xMax, yMin, yMax, nx, ny, uv, inside },
    streamlines,
    ...over,
  };
}

function section(
  x: number,
  y: number,
  chord: number,
  over: Partial<WingSection> = {},
): WingSection {
  return {
    le: [x, y, 0],
    chord,
    twist: 0,
    roll: 0,
    airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
    flap: null,
    slat: false,
    ...over,
  };
}

/** A swept, tapered wing: root chord `c0`, span `b`, optional winglet. */
export function makeGeometry(opts: {
  span?: number;
  rootChord?: number;
  tipChord?: number;
  sweepOffset?: number;
  winglet?: boolean;
}): WingGeometry {
  const b = opts.span ?? 10;
  const c0 = opts.rootChord ?? 1.5;
  const c1 = opts.tipChord ?? 0.75;
  const sweep = opts.sweepOffset ?? 0.8;
  const half = b / 2;
  const mk = (
    id: string,
    name: string,
    side: 'right' | 'left',
    role: 'wing' | 'tip-device',
  ): LiftingSurface => {
    const m = side === 'right' ? 1 : -1;
    const sections =
      role === 'wing'
        ? [section(0, 0, c0), section(sweep, m * half, c1)]
        : [
            section(sweep, m * half, c1),
            section(sweep + 0.4, m * (half + 0.4), c1 * 0.5, {
              roll: (side === 'right' ? 1 : -1) * 1.2,
            }),
          ];
    return { id, name, side, role, sections };
  };
  const surfaces = [
    mk('right-wing', 'Right wing', 'right', 'wing'),
    mk('left-wing', 'Left wing', 'left', 'wing'),
  ];
  if (opts.winglet) {
    surfaces.push(mk('right-winglet', 'Right winglet', 'right', 'tip-device'));
    surfaces.push(mk('left-winglet', 'Left winglet', 'left', 'tip-device'));
  }
  const area = ((c0 + c1) / 2) * b;
  return {
    surfaces,
    pivot: [c0 * 0.25, 0, 0],
    referenceArea: area,
    referenceSpan: b,
    meanAeroChord: (2 / 3) * c0 * ((1 + c1 / c0 + (c1 / c0) ** 2) / (1 + c1 / c0)),
    aspectRatio: (b * b) / area,
    overallSpan: b,
    wettedArea: area * 2.1,
    sweepQuarterChord: Math.atan2(sweep + (c1 - c0) / 4, half),
  };
}

/** A preset for comparison tests; override anything. */
export function makePreset(over: Partial<AircraftPreset> & { id: string }): AircraftPreset {
  return {
    name: over.id.toUpperCase(),
    shortName: over.id.toUpperCase(),
    category: 'airliner',
    blurb: 'A test wing.',
    wing: DEFAULT_WING,
    cruise: { alphaDeg: 3, airspeed: 230, altitude: 10668 },
    approach: { alphaDeg: 8, airspeed: 70, altitude: 0 },
    maxTakeoffMassKg: 80000,
    typicalCruiseMassKg: 65000,
    facts: [],
    ...over,
  };
}
