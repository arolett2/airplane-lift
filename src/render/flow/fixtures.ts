/**
 * Analytic flow fixtures for tests and for developing the flow renderers before the physics
 * solvers exist: a free stream past a circulating cylinder (axis along y, so the flow over the
 * top is faster than underneath, like a wing section) plus a Lamb-Oseen vortex filament along +x
 * (a stand-in tip vortex). Pure (no three.js).
 */
import type { TunnelDomain } from '../../physics/domain';
import type { FlowFieldGrid, Streamline3D } from '../../physics/types';

export interface AnalyticFlowParams {
  vInf: number;
  /** Cylinder radius (m); its axis runs along y through the origin. */
  radius: number;
  /** Circulation about the cylinder (m^2/s). Positive = clockwise seen from +y, i.e. faster on top. */
  cylinderGamma: number;
  /** Tip-vortex filament along +x through (vortexY, vortexZ). */
  vortexGamma: number;
  vortexY: number;
  vortexZ: number;
  vortexCore: number;
}

export function defaultAnalyticParams(vInf = 50): AnalyticFlowParams {
  return {
    vInf,
    radius: 1,
    cylinderGamma: 4 * Math.PI * vInf * 0.35,
    vortexGamma: 30,
    vortexY: 4,
    vortexZ: 0,
    vortexCore: 0.5,
  };
}

/** Velocity of the analytic field at (x,y,z); writes out[0..2]. */
export function analyticVelocity(
  p: AnalyticFlowParams,
  x: number,
  y: number,
  z: number,
  out: { [i: number]: number },
): void {
  let u = p.vInf;
  let v = 0;
  let w = 0;
  // Potential flow past a cylinder with axis along y (2D in the x-z plane).
  const r2 = x * x + z * z;
  const R2 = p.radius * p.radius;
  if (r2 > 1e-9) {
    const r4 = r2 * r2;
    u += (-p.vInf * R2 * (x * x - z * z)) / r4;
    w += (-2 * p.vInf * R2 * x * z) / r4;
    // Circulation, clockwise seen from +y: u_theta ~ (z, -x)/r^2 * Gamma/2pi gives +u on top.
    const k = p.cylinderGamma / (2 * Math.PI * r2);
    u += k * z;
    w += -k * x;
  }
  // Lamb-Oseen vortex along x: swirl in the y-z plane around (vortexY, vortexZ).
  const dy = y - p.vortexY;
  const dz = z - p.vortexZ;
  const rv2 = dy * dy + dz * dz;
  if (rv2 > 1e-12) {
    const swirl =
      (p.vortexGamma / (2 * Math.PI * rv2)) * (1 - Math.exp(-rv2 / (p.vortexCore * p.vortexCore)));
    v += -swirl * dz;
    w += swirl * dy;
  }
  out[0] = u;
  out[1] = v;
  out[2] = w;
}

/** True inside the cylinder. */
export function insideAnalyticBody(p: AnalyticFlowParams, x: number, z: number): boolean {
  return x * x + z * z < p.radius * p.radius;
}

/** Sample the analytic field onto a uniform FlowFieldGrid covering `domain`. */
export function makeAnalyticFlowGrid(
  domain: TunnelDomain,
  p: AnalyticFlowParams,
  dims: [number, number, number] = [48, 32, 24],
  requestId = 1,
): FlowFieldGrid {
  const [nx, ny, nz] = dims;
  const origin = [...domain.min] as [number, number, number];
  const spacing: [number, number, number] = [
    (domain.max[0] - domain.min[0]) / (nx - 1),
    (domain.max[1] - domain.min[1]) / (ny - 1),
    (domain.max[2] - domain.min[2]) / (nz - 1),
  ];
  const velocity = new Float32Array(nx * ny * nz * 3);
  const solid = new Uint8Array(nx * ny * nz);
  const tmp = [0, 0, 0];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = origin[0] + i * spacing[0];
        const y = origin[1] + j * spacing[1];
        const z = origin[2] + k * spacing[2];
        const idx = i + nx * (j + ny * k);
        if (insideAnalyticBody(p, x, z) && Math.abs(y) < 6) {
          solid[idx] = 1;
          continue;
        }
        analyticVelocity(p, x, y, z, tmp);
        velocity[idx * 3] = tmp[0]!;
        velocity[idx * 3 + 1] = tmp[1]!;
        velocity[idx * 3 + 2] = tmp[2]!;
      }
    }
  }
  return { requestId, origin, spacing, dims, velocity, solid, vInf: p.vInf };
}

/**
 * Trace a streamline with RK4 through the analytic field from `seed` until it leaves the domain
 * (or `maxPoints` is reached). Time is cumulative physical seconds.
 */
export function traceAnalyticStreamline(
  domain: TunnelDomain,
  p: AnalyticFlowParams,
  seed: [number, number, number],
  group: Streamline3D['group'] = 'rake',
  maxPoints = 1500,
): Streamline3D {
  const pts: number[] = [];
  const spd: number[] = [];
  const tim: number[] = [];
  const h = (domain.max[0] - domain.min[0]) / p.vInf / 500;
  const k1 = [0, 0, 0];
  const k2 = [0, 0, 0];
  const k3 = [0, 0, 0];
  const k4 = [0, 0, 0];
  let x = seed[0];
  let y = seed[1];
  let z = seed[2];
  let t = 0;
  for (let n = 0; n < maxPoints; n++) {
    analyticVelocity(p, x, y, z, k1);
    pts.push(x, y, z);
    spd.push(Math.hypot(k1[0]!, k1[1]!, k1[2]!) / p.vInf);
    tim.push(t);
    if (
      x > domain.max[0] ||
      y < domain.min[1] ||
      y > domain.max[1] ||
      z < domain.min[2] ||
      z > domain.max[2] ||
      insideAnalyticBody(p, x, z)
    ) {
      break;
    }
    analyticVelocity(p, x + 0.5 * h * k1[0]!, y + 0.5 * h * k1[1]!, z + 0.5 * h * k1[2]!, k2);
    analyticVelocity(p, x + 0.5 * h * k2[0]!, y + 0.5 * h * k2[1]!, z + 0.5 * h * k2[2]!, k3);
    analyticVelocity(p, x + h * k3[0]!, y + h * k3[1]!, z + h * k3[2]!, k4);
    x += (h / 6) * (k1[0]! + 2 * k2[0]! + 2 * k3[0]! + k4[0]!);
    y += (h / 6) * (k1[1]! + 2 * k2[1]! + 2 * k3[1]! + k4[1]!);
    z += (h / 6) * (k1[2]! + 2 * k2[2]! + 2 * k3[2]! + k4[2]!);
    t += h;
  }
  return {
    points: new Float32Array(pts),
    speed: new Float32Array(spd),
    time: new Float32Array(tim),
    group,
  };
}

/** A vertical rake of `count` lines at y = 0 from z = -zExtent to +zExtent, starting at the inlet. */
export function makeAnalyticStreamlines(
  domain: TunnelDomain,
  p: AnalyticFlowParams,
  count = 16,
  zExtent = 2.5,
  y = 0,
): Streamline3D[] {
  const lines: Streamline3D[] = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0.5 : i / (count - 1);
    const z = -zExtent + 2 * zExtent * f;
    lines.push(traceAnalyticStreamline(domain, p, [domain.min[0] + 1e-3, y, z]));
  }
  return lines;
}
