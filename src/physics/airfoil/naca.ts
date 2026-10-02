/**
 * NACA 4-digit airfoil geometry, with an optional plain trailing-edge flap.
 * Shared by the panel method, the wing mesh lofting and the 3D flow model.
 * All coordinates are in the unit-chord airfoil frame (x: 0 at LE .. 1 at TE, y up).
 */
import type { AirfoilGeometry, FlapState, Naca4Params } from '../types';

/**
 * Half-thickness of the symmetric NACA 4-digit section at x (closed trailing edge variant,
 * coefficient -0.1036, so the panel method sees a sharp TE).
 */
export function nacaHalfThickness(t: number, x: number): number {
  const xc = Math.min(1, Math.max(0, x));
  return (
    5 *
    t *
    (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)
  );
}

/** Undeflected NACA 4-digit mean camber line height and slope at x. */
export function nacaCamber(p: Naca4Params, x: number): { yc: number; slope: number } {
  const m = p.camber;
  const pos = p.camberPos;
  if (m <= 0 || pos <= 0 || pos >= 1) return { yc: 0, slope: 0 };
  if (x < pos) {
    return {
      yc: (m / (pos * pos)) * (2 * pos * x - x * x),
      slope: ((2 * m) / (pos * pos)) * (pos - x),
    };
  }
  const d = (1 - pos) * (1 - pos);
  return {
    yc: (m / d) * (1 - 2 * pos + 2 * pos * x - x * x),
    slope: ((2 * m) / d) * (pos - x),
  };
}

/** Half-width of the smooth blend around the flap hinge, as a fraction of chord. */
const FLAP_BLEND = 0.03;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Integral of tan(phi(s)) ds from 0 to x, where phi ramps smoothly from 0 to the flap
 * deflection across the hinge. Gives the downward displacement of the camber line by the flap.
 * Uses a closed form outside the blend zone and Simpson's rule inside it.
 */
function flapDrop(flap: FlapState, x: number): { drop: number; slope: number } {
  const hinge = 1 - flap.chordFrac;
  const a = hinge - FLAP_BLEND;
  const b = hinge + FLAP_BLEND;
  const tanAt = (s: number) => Math.tan(flap.deflection * smoothstep(a, b, s));
  if (x <= a) return { drop: 0, slope: 0 };
  const integrate = (lo: number, hi: number) => {
    const n = 16;
    const h = (hi - lo) / n;
    let sum = tanAt(lo) + tanAt(hi);
    for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * tanAt(lo + i * h);
    return (sum * h) / 3;
  };
  if (x <= b) return { drop: integrate(a, x), slope: tanAt(x) };
  return {
    drop: integrate(a, b) + (x - b) * Math.tan(flap.deflection),
    slope: Math.tan(flap.deflection),
  };
}

/**
 * Mean camber line including the flap (positive deflection = trailing edge down).
 * The flap is modelled as a smooth bend of the camber line about the hinge; the chord's
 * x-extent is preserved.
 */
export function camberLine(
  p: Naca4Params,
  flap: FlapState | null,
  x: number,
): { yc: number; slope: number } {
  const base = nacaCamber(p, x);
  if (!flap || flap.deflection === 0 || flap.chordFrac <= 0) return base;
  const f = flapDrop(flap, x);
  return { yc: base.yc - f.drop, slope: base.slope - f.slope };
}

/** Cosine-spaced stations 0..1 (clustered at LE and TE), n+1 values. */
export function cosineSpacing(n: number): Float64Array {
  const out = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = 0.5 * (1 - Math.cos((Math.PI * i) / n));
  return out;
}

/** Upper and lower surface point at chord station x. */
export function surfacePoint(
  p: Naca4Params,
  flap: FlapState | null,
  x: number,
  upper: boolean,
): [number, number] {
  const { yc, slope } = camberLine(p, flap, x);
  const yt = nacaHalfThickness(p.thickness, x);
  const th = Math.atan(slope);
  const s = upper ? 1 : -1;
  return [x - s * yt * Math.sin(th), yc + s * yt * Math.cos(th)];
}

/**
 * Closed airfoil contour for the panel method / mesh lofting.
 * @param nPanels total number of panels (rounded up to an even number, min 16)
 * Ordering: TE -> lower surface -> LE -> upper surface -> TE (first point == last point).
 */
export function generateAirfoil(
  params: Naca4Params,
  nPanels = 120,
  flap: FlapState | null = null,
): AirfoilGeometry {
  const half = Math.max(8, Math.ceil(nPanels / 2));
  const xs = cosineSpacing(half);
  const nPoints = 2 * half + 1;
  const coords = new Float64Array(2 * nPoints);
  let k = 0;
  // Lower surface from TE (x=1) to LE (x=0).
  for (let i = half; i >= 0; i--) {
    const [x, y] = surfacePoint(params, flap, xs[i]!, false);
    coords[k++] = x;
    coords[k++] = y;
  }
  // Upper surface from just after LE back to TE.
  for (let i = 1; i <= half; i++) {
    const [x, y] = surfacePoint(params, flap, xs[i]!, true);
    coords[k++] = x;
    coords[k++] = y;
  }
  // Make the closed TE exact so the contour has no gap.
  coords[2 * (nPoints - 1)] = coords[0]!;
  coords[2 * (nPoints - 1) + 1] = coords[1]!;
  return { coords, nPoints, leIndex: half, params, flap };
}

/** NACA designation string, e.g. "NACA 2412". Non-integer digits are rounded. */
export function nacaName(p: Naca4Params): string {
  const m = Math.round(p.camber * 100);
  const pos = m === 0 ? 0 : Math.round(p.camberPos * 10);
  const t = Math.round(p.thickness * 100);
  return `NACA ${m}${pos}${String(t).padStart(2, '0')}`;
}
