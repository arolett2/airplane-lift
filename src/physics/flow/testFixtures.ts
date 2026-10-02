/**
 * Test-only builders: simple wing geometries and horseshoe lattices constructed directly (the
 * geometry and VLM modules are developed in parallel). Not imported by production code.
 */
import type {
  FlapState,
  LiftingSurface,
  Naca4Params,
  Vec3,
  VortexLattice,
  WingGeometry,
  WingSection,
} from '../types';
import { bodyToTunnel } from '../math/frames';
import { camberLine } from '../airfoil/naca';
import { interpolateSegment, sectionPoint } from './wingFrames';

export interface TestWingOptions {
  span: number;
  rootChord: number;
  tipChord?: number;
  /** Leading-edge sweep (rad). */
  sweep?: number;
  /** Dihedral (rad). */
  dihedral?: number;
  airfoil?: Naca4Params;
  flap?: FlapState | null;
  /** Vertical winglet at each tip: height (m) and tip chord fraction. */
  winglet?: { height: number; taper?: number };
}

const NACA2412: Naca4Params = { camber: 0.02, camberPos: 0.4, thickness: 0.12 };

export function makeTestWing(o: TestWingOptions): WingGeometry {
  const s = o.span / 2;
  const cr = o.rootChord;
  const ct = o.tipChord ?? cr;
  const sweep = o.sweep ?? 0;
  const dih = o.dihedral ?? 0;
  const airfoil = o.airfoil ?? NACA2412;
  const flap = o.flap ?? null;
  const surfaces: LiftingSurface[] = [];
  for (const side of ['right', 'left'] as const) {
    const m = side === 'left' ? -1 : 1;
    const section = (le: Vec3, chord: number, roll: number, f: FlapState | null): WingSection => ({
      le,
      chord,
      twist: 0,
      roll,
      airfoil,
      flap: f,
      slat: false,
    });
    const tipLe: Vec3 = [s * Math.tan(sweep), m * s, s * Math.tan(dih)];
    surfaces.push({
      id: `wing-${side}`,
      name: `${side} wing`,
      side,
      role: 'wing',
      sections: [section([0, 0, 0], cr, dih, flap), section(tipLe, ct, dih, flap)],
    });
    if (o.winglet) {
      const h = o.winglet.height;
      const top: Vec3 = [tipLe[0] + 0.6 * h, tipLe[1], tipLe[2] + h];
      surfaces.push({
        id: `winglet-${side}`,
        name: `${side} winglet`,
        side,
        role: 'tip-device',
        sections: [
          section([...tipLe], ct, Math.PI / 2, null),
          section(top, ct * (o.winglet.taper ?? 0.5), Math.PI / 2, null),
        ],
      });
    }
  }
  const area = o.span * 0.5 * (cr + ct);
  return {
    surfaces,
    pivot: [0.25 * cr, 0, 0],
    referenceArea: area,
    referenceSpan: o.span,
    meanAeroChord: area / o.span,
    aspectRatio: (o.span * o.span) / area,
    overallSpan: o.span,
    wettedArea: 2.04 * area,
    sweepQuarterChord: sweep,
  };
}

export interface TestLatticeOptions {
  /** Strips per surface (default 24 on wings, 6 on devices). */
  nSpanWing?: number;
  nSpanDevice?: number;
  /** Chordwise panels (default 6). */
  nChord?: number;
  /** Strip circulation (m^2/s) given the surface and strip-centre fraction s (0 root .. 1 tip). */
  gamma?: (surface: LiftingSurface, s: number) => number;
  coreRadius?: number;
}

/** Elliptic loading for a given lift coefficient: Gamma0 = 2 V S CL / (pi b). */
export function ellipticGamma(
  geometry: WingGeometry,
  vInf: number,
  CL: number,
): (surface: LiftingSurface, s: number) => number {
  const g0 = (2 * vInf * geometry.referenceArea * CL) / (Math.PI * geometry.referenceSpan);
  return (surface, s) =>
    surface.role === 'wing' ? g0 * Math.sqrt(Math.max(0, 1 - s * s)) : 0.05 * g0 * (1 - s);
}

/**
 * Horseshoe lattice on the mean camber surface of every surface, TUNNEL frame, following the
 * VortexLattice orientation rule (right: A inboard; left: A outboard).
 */
export function makeTestLattice(
  geometry: WingGeometry,
  alpha: number,
  o: TestLatticeOptions = {},
): VortexLattice {
  const nc = o.nChord ?? 6;
  const gammaOf = o.gamma ?? (() => 1);
  const a: number[] = [];
  const b: number[] = [];
  const teA: number[] = [];
  const teB: number[] = [];
  const gamma: number[] = [];
  // Chordwise share of the strip circulation (front-loaded like a thin cambered plate).
  const w: number[] = [];
  for (let k = 0; k < nc; k++) w.push(nc - k);
  const wSum = w.reduce((p, q) => p + q, 0);
  const T = (p: Vec3) => bodyToTunnel(p, geometry.pivot, alpha);

  for (const surface of geometry.surfaces) {
    const ns = surface.role === 'wing' ? (o.nSpanWing ?? 24) : (o.nSpanDevice ?? 6);
    for (let j = 0; j < ns; j++) {
      const inner = interpolateSegment(surface, 0, j / ns);
      const outer = interpolateSegment(surface, 0, (j + 1) / ns);
      // Points on the mean camber surface at chord fraction x.
      const onCamber = (sec: typeof inner, x: number) =>
        T(sectionPoint(sec.axes, x, camberLine(sec.airfoil, sec.flap, x).yc));
      const g = gammaOf(surface, (j + 0.5) / ns);
      const right = surface.side === 'right';
      const tIn = onCamber(inner, 1);
      const tOut = onCamber(outer, 1);
      for (let k = 0; k < nc; k++) {
        const xq = (k + 0.25) / nc;
        const pIn = onCamber(inner, xq);
        const pOut = onCamber(outer, xq);
        a.push(...(right ? pIn : pOut));
        b.push(...(right ? pOut : pIn));
        teA.push(...(right ? tIn : tOut));
        teB.push(...(right ? tOut : tIn));
        gamma.push((g * w[k]!) / wSum);
      }
    }
  }
  return {
    count: gamma.length,
    a: Float32Array.from(a),
    b: Float32Array.from(b),
    teA: Float32Array.from(teA),
    teB: Float32Array.from(teB),
    gamma: Float32Array.from(gamma),
    sources: {
      count: 0,
      p0: new Float32Array(0),
      p1: new Float32Array(0),
      sigma: new Float32Array(0),
    },
    coreRadius: o.coreRadius ?? 0.02 * geometry.meanAeroChord,
  };
}

/** A lattice holding a single horseshoe. */
export function singleHorseshoe(
  a: Vec3,
  b: Vec3,
  teA: Vec3,
  teB: Vec3,
  gamma: number,
  coreRadius = 1e-3,
): VortexLattice {
  return {
    count: 1,
    a: Float32Array.from(a),
    b: Float32Array.from(b),
    teA: Float32Array.from(teA),
    teB: Float32Array.from(teB),
    gamma: Float32Array.from([gamma]),
    sources: {
      count: 0,
      p0: new Float32Array(0),
      p1: new Float32Array(0),
      sigma: new Float32Array(0),
    },
    coreRadius,
  };
}
