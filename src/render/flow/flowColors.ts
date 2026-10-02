/**
 * Lookup tables turning |V|/Vinf into RGB for the two colouring modes, built once from the
 * shared colour maps so streamlines, particles and the wing surface always agree.
 * Pure (no three.js).
 */
import type { ColorBy } from '../../state/params';
import { cpFromSpeed, pressureColor, speedColor } from '../../shared/colormaps';
import type { RGB } from '../../shared/colormaps';

/** Speed ratios 0 .. LUT_MAX_SPEED map onto LUT_SIZE entries. */
export const LUT_SIZE = 256;
export const LUT_MAX_SPEED = 2;

export interface ColorLut {
  /** LUT_SIZE * 3 floats. */
  rgb: Float32Array;
}

const cache = new Map<ColorBy, ColorLut>();

/**
 * Pressure mode colours by Cp = 1 - (V/Vinf)^2, so fast air over the wing is blue (like the
 * suction side of the wing surface); speed mode uses the sequential speed map.
 */
export function getColorLut(mode: ColorBy): ColorLut {
  const hit = cache.get(mode);
  if (hit) return hit;
  const rgb = new Float32Array(LUT_SIZE * 3);
  const tmp: RGB = [0, 0, 0];
  for (let i = 0; i < LUT_SIZE; i++) {
    const s = (i / (LUT_SIZE - 1)) * LUT_MAX_SPEED;
    if (mode === 'pressure') pressureColor(cpFromSpeed(s), tmp);
    else speedColor(s, tmp);
    rgb[i * 3] = tmp[0];
    rgb[i * 3 + 1] = tmp[1];
    rgb[i * 3 + 2] = tmp[2];
  }
  const lut = { rgb };
  cache.set(mode, lut);
  return lut;
}

/** Index into the LUT (x3 for the float offset) for a speed ratio. NaN maps to freestream. */
export function lutIndex(speedRatio: number): number {
  const x = speedRatio * ((LUT_SIZE - 1) / LUT_MAX_SPEED);
  if (!(x > 0)) return x === x ? 0 : (LUT_SIZE - 1) >> 1;
  return x >= LUT_SIZE - 1 ? LUT_SIZE - 1 : (x + 0.5) | 0;
}
