/**
 * Lookup tables turning |V|/Vinf into colour for the two colouring modes, built once from the 3D
 * flow palette (render/util/palette.ts) so streamlines and particles always agree.
 * Pure (no three.js).
 *
 * Colours are LINEAR RGB (the flow shaders write them straight into three's linear working space
 * and the output pass encodes sRGB). Each entry also carries an `emphasis` (0 .. 1): 0 for
 * undisturbed air, 1 for strongly sped-up or slowed air. Renderers fade the undisturbed smoke
 * with it so the interesting flow stands out.
 */
import type { ColorBy } from '../../state/params';
import { cpFromSpeed } from '../../shared/colormaps';
import type { RGB } from '../../shared/colormaps';
import {
  flowEmphasis,
  flowPressureColor,
  flowSpeedColor,
  speedEmphasis,
  srgbToLinear,
} from '../util/palette';

/** Speed ratios 0 .. LUT_MAX_SPEED map onto LUT_SIZE entries. */
export const LUT_SIZE = 256;
export const LUT_MAX_SPEED = 2;

export interface ColorLut {
  /** LUT_SIZE * 3 floats, linear RGB. */
  rgb: Float32Array;
  /** LUT_SIZE floats: how far from the freestream (0 .. 1). */
  emphasis: Float32Array;
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
  const emphasis = new Float32Array(LUT_SIZE);
  const tmp: RGB = [0, 0, 0];
  for (let i = 0; i < LUT_SIZE; i++) {
    const s = (i / (LUT_SIZE - 1)) * LUT_MAX_SPEED;
    if (mode === 'pressure') {
      const cp = cpFromSpeed(s);
      flowPressureColor(cp, tmp);
      emphasis[i] = flowEmphasis(cp);
    } else {
      flowSpeedColor(s, tmp);
      emphasis[i] = speedEmphasis(s);
    }
    rgb[i * 3] = srgbToLinear(tmp[0]);
    rgb[i * 3 + 1] = srgbToLinear(tmp[1]);
    rgb[i * 3 + 2] = srgbToLinear(tmp[2]);
  }
  const lut = { rgb, emphasis };
  cache.set(mode, lut);
  return lut;
}

/** Index into the LUT (x3 for the float offset) for a speed ratio. NaN maps to freestream. */
export function lutIndex(speedRatio: number): number {
  const x = speedRatio * ((LUT_SIZE - 1) / LUT_MAX_SPEED);
  if (!(x > 0)) return x === x ? 0 : (LUT_SIZE - 1) >> 1;
  return x >= LUT_SIZE - 1 ? LUT_SIZE - 1 : (x + 0.5) | 0;
}
