/**
 * Uniform velocity grid over the tunnel domain (for particle advection) and its trilinear sampler.
 * Velocities come from the near/far split evaluator (exact panels near each strip, lumped far
 * away); nodes inside the wing get zero velocity and solid = 1.
 */
import type { FlowFieldGrid, VortexLattice, WingGeometry } from '../types';
import type { TunnelDomain } from '../domain';
import { addInducedFast, getCompiledLattice } from './lattice';
import { getWingSolid } from './solid';
import { withThicknessSources } from './sources';

export interface GridOptions {
  domain: TunnelDomain;
  /** Approximate total node count (default 120_000); dims are chosen to keep cells ~cubic. */
  targetNodes?: number;
}

/** Node counts per axis for ~cubic cells and about `target` nodes in total. */
export function gridDims(domain: TunnelDomain, target: number): [number, number, number] {
  const lx = Math.max(domain.max[0] - domain.min[0], 1e-9);
  const ly = Math.max(domain.max[1] - domain.min[1], 1e-9);
  const lz = Math.max(domain.max[2] - domain.min[2], 1e-9);
  const h = Math.cbrt((lx * ly * lz) / Math.max(target, 8));
  return [
    Math.max(2, Math.round(lx / h) + 1),
    Math.max(2, Math.round(ly / h) + 1),
    Math.max(2, Math.round(lz / h) + 1),
  ];
}

const acc = new Float64Array(3);

export function buildFlowFieldGrid(
  lattice: VortexLattice,
  vInf: number,
  geometry: WingGeometry,
  alpha: number,
  options: GridOptions,
  requestId: number,
): FlowFieldGrid {
  const { domain } = options;
  const dims = gridDims(domain, options.targetNodes ?? 120_000);
  const [nx, ny, nz] = dims;
  const ox = domain.min[0];
  const oy = domain.min[1];
  const oz = domain.min[2];
  const sx = (domain.max[0] - ox) / (nx - 1);
  const sy = (domain.max[1] - oy) / (ny - 1);
  const sz = (domain.max[2] - oz) / (nz - 1);
  const nodes = nx * ny * nz;
  const velocity = new Float32Array(3 * nodes);
  const solidMask = new Uint8Array(nodes);

  const compiled = getCompiledLattice(withThicknessSources(lattice, geometry, alpha, vInf));
  const solid = getWingSolid(geometry, alpha);

  let n = 0;
  for (let k = 0; k < nz; k++) {
    const z = oz + k * sz;
    for (let j = 0; j < ny; j++) {
      const y = oy + j * sy;
      for (let i = 0; i < nx; i++, n++) {
        const x = ox + i * sx;
        if (solid.contains(x, y, z)) {
          solidMask[n] = 1;
          continue; // velocity stays 0
        }
        acc[0] = vInf;
        acc[1] = 0;
        acc[2] = 0;
        addInducedFast(compiled, x, y, z, acc);
        velocity[3 * n] = acc[0];
        velocity[3 * n + 1] = acc[1];
        velocity[3 * n + 2] = acc[2];
      }
    }
  }

  return {
    requestId,
    origin: [ox, oy, oz],
    spacing: [sx, sy, sz],
    dims,
    velocity,
    solid: solidMask,
    vInf,
  };
}

/** Trilinear sample. Returns false (and writes freestream) when outside the grid. */
export function sampleGrid(
  grid: FlowFieldGrid,
  x: number,
  y: number,
  z: number,
  out: Float64Array | number[],
): boolean {
  const [nx, ny, nz] = grid.dims;
  const fx = (x - grid.origin[0]) / grid.spacing[0];
  const fy = (y - grid.origin[1]) / grid.spacing[1];
  const fz = (z - grid.origin[2]) / grid.spacing[2];
  // NaN-safe: the negated comparisons also reject NaN coordinates.
  if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= nx - 1 && fy <= ny - 1 && fz <= nz - 1)) {
    out[0] = grid.vInf;
    out[1] = 0;
    out[2] = 0;
    return false;
  }
  let i = Math.floor(fx);
  let j = Math.floor(fy);
  let k = Math.floor(fz);
  if (i > nx - 2) i = nx - 2;
  if (j > ny - 2) j = ny - 2;
  if (k > nz - 2) k = nz - 2;
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const v = grid.velocity;
  const sj = nx;
  const sk = nx * ny;
  const n000 = 3 * (i + sj * j + sk * k);
  const n100 = n000 + 3;
  const n010 = n000 + 3 * sj;
  const n110 = n010 + 3;
  const n001 = n000 + 3 * sk;
  const n101 = n001 + 3;
  const n011 = n001 + 3 * sj;
  const n111 = n011 + 3;
  const w000 = (1 - tx) * (1 - ty) * (1 - tz);
  const w100 = tx * (1 - ty) * (1 - tz);
  const w010 = (1 - tx) * ty * (1 - tz);
  const w110 = tx * ty * (1 - tz);
  const w001 = (1 - tx) * (1 - ty) * tz;
  const w101 = tx * (1 - ty) * tz;
  const w011 = (1 - tx) * ty * tz;
  const w111 = tx * ty * tz;
  for (let c = 0; c < 3; c++) {
    out[c] =
      w000 * v[n000 + c]! +
      w100 * v[n100 + c]! +
      w010 * v[n010 + c]! +
      w110 * v[n110 + c]! +
      w001 * v[n001 + c]! +
      w101 * v[n101 + c]! +
      w011 * v[n011 + c]! +
      w111 * v[n111 + c]!;
  }
  return true;
}
