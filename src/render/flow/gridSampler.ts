/**
 * Allocation-free trilinear sampler of a FlowFieldGrid (render-side copy of the sampling the
 * particle advection needs; the physics module has its own `sampleGrid`).
 *
 * Results are written to the public fields vx/vy/vz so the hot loop never allocates.
 */
import type { FlowFieldGrid } from '../../physics/types';

/** Point lies outside the grid: velocity is set to the freestream. */
export const SAMPLE_OUTSIDE = 0;
/** Point is in the fluid: vx/vy/vz hold the interpolated velocity. */
export const SAMPLE_OK = 1;
/** The nearest grid node is inside the wing body (the caller should respawn the particle). */
export const SAMPLE_SOLID = 2;

export type SampleStatus = typeof SAMPLE_OUTSIDE | typeof SAMPLE_OK | typeof SAMPLE_SOLID;

export class FlowSampler {
  /** Velocity of the last sample (m/s, tunnel frame). */
  vx = 0;
  vy = 0;
  vz = 0;

  private vel: Float32Array = new Float32Array(0);
  private solid: Uint8Array = new Uint8Array(0);
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private ix = 0; // inverse spacing
  private iy = 0;
  private iz = 0;
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private vInf = 0;
  private valid = false;

  /** Point the sampler at a grid (or null to disable: every sample is SAMPLE_OUTSIDE). */
  setGrid(grid: FlowFieldGrid | null): void {
    if (!grid) {
      this.valid = false;
      return;
    }
    const [nx, ny, nz] = grid.dims;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.ox = grid.origin[0];
    this.oy = grid.origin[1];
    this.oz = grid.origin[2];
    this.ix = grid.spacing[0] > 0 ? 1 / grid.spacing[0] : 0;
    this.iy = grid.spacing[1] > 0 ? 1 / grid.spacing[1] : 0;
    this.iz = grid.spacing[2] > 0 ? 1 / grid.spacing[2] : 0;
    this.vel = grid.velocity;
    this.solid = grid.solid;
    this.vInf = grid.vInf;
    const n = nx * ny * nz;
    this.valid =
      nx >= 1 &&
      ny >= 1 &&
      nz >= 1 &&
      this.ix > 0 &&
      this.iy > 0 &&
      this.iz > 0 &&
      grid.velocity.length >= 3 * n &&
      grid.solid.length >= n;
  }

  /**
   * Trilinear sample at (x,y,z). Solid corner nodes are left out of the blend (their weights
   * are renormalised) so wing-interior values never leak into the fluid next to the surface.
   */
  sample(x: number, y: number, z: number): SampleStatus {
    if (!this.valid) {
      this.vx = this.vInf;
      this.vy = 0;
      this.vz = 0;
      return SAMPLE_OUTSIDE;
    }
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const gx = (x - this.ox) * this.ix;
    const gy = (y - this.oy) * this.iy;
    const gz = (z - this.oz) * this.iz;
    // The negated form also rejects NaN.
    if (!(gx >= 0 && gy >= 0 && gz >= 0 && gx <= nx - 1 && gy <= ny - 1 && gz <= nz - 1)) {
      this.vx = this.vInf;
      this.vy = 0;
      this.vz = 0;
      return SAMPLE_OUTSIDE;
    }
    let i0 = gx | 0;
    let j0 = gy | 0;
    let k0 = gz | 0;
    if (i0 > nx - 2) i0 = nx - 2 < 0 ? 0 : nx - 2;
    if (j0 > ny - 2) j0 = ny - 2 < 0 ? 0 : ny - 2;
    if (k0 > nz - 2) k0 = nz - 2 < 0 ? 0 : nz - 2;
    const i1 = i0 + 1 < nx ? i0 + 1 : i0;
    const j1 = j0 + 1 < ny ? j0 + 1 : j0;
    const k1 = k0 + 1 < nz ? k0 + 1 : k0;
    const fx = gx - i0;
    const fy = gy - j0;
    const fz = gz - k0;

    const solid = this.solid;
    const r00 = nx * (j0 + ny * k0);
    const r10 = nx * (j1 + ny * k0);
    const r01 = nx * (j0 + ny * k1);
    const r11 = nx * (j1 + ny * k1);

    // Nearest node decides whether the particle is "inside" the wing.
    const nearest =
      (fz < 0.5 ? (fy < 0.5 ? r00 : r10) : fy < 0.5 ? r01 : r11) + (fx < 0.5 ? i0 : i1);
    if (solid[nearest] !== 0) return SAMPLE_SOLID;

    const gx0 = 1 - fx;
    const gy0 = 1 - fy;
    const gz0 = 1 - fz;
    const vel = this.vel;
    let sw = 0;
    let ax = 0;
    let ay = 0;
    let az = 0;
    let c: number;
    let w: number;

    c = r00 + i0;
    if (solid[c] === 0) {
      w = gx0 * gy0 * gz0;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    c = r00 + i1;
    if (solid[c] === 0) {
      w = fx * gy0 * gz0;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    c = r10 + i0;
    if (solid[c] === 0) {
      w = gx0 * fy * gz0;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    c = r10 + i1;
    if (solid[c] === 0) {
      w = fx * fy * gz0;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    c = r01 + i0;
    if (solid[c] === 0) {
      w = gx0 * gy0 * fz;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    c = r01 + i1;
    if (solid[c] === 0) {
      w = fx * gy0 * fz;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    c = r11 + i0;
    if (solid[c] === 0) {
      w = gx0 * fy * fz;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    c = r11 + i1;
    if (solid[c] === 0) {
      w = fx * fy * fz;
      sw += w;
      c *= 3;
      ax += w * vel[c]!;
      ay += w * vel[c + 1]!;
      az += w * vel[c + 2]!;
    }
    // The nearest node is fluid and carries weight >= 1/8, so sw > 0 here.
    const inv = 1 / sw;
    this.vx = ax * inv;
    this.vy = ay * inv;
    this.vz = az * inv;
    return SAMPLE_OK;
  }
}
