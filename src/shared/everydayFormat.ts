/**
 * Plain-language wording for the probe and the "everyday pressure" readouts, shared by the 2D
 * cross-section, the 3D probe label and the Numbers card. Pure functions (no DOM).
 *
 *   speed:     "498 kt", "12% faster than the wind"
 *   pressure:  "1.8% below the air around it", "−1.9 kPa" (kPa, or psi for imperial)
 *   direction: "4° upward"
 *   push:      "520 kg" per "square metre" / "110 lb" per "square foot"
 */
import { formatNumber, formatQuantity, sigDecimals, type UnitSystem } from './units';

const PA_PER_PSI = 6894.757293168;
const KG_M2_PER_LB_FT2 = 4.88242763638;
const MINUS = '−';

/** A signed number with a real minus sign. */
function signed(text: string, negative: boolean, plus = true): string {
  const bare = text.replace(/^-/, '');
  return negative ? `${MINUS}${bare}` : plus ? `+${bare}` : bare;
}

/** A percentage with sensible precision: "12%", "1.8%", "0.04%". */
export function formatPercent(fraction: number): string {
  const pct = Math.abs(fraction) * 100;
  if (!Number.isFinite(pct)) return '–';
  const digits = pct >= 10 ? 0 : pct >= 0.1 ? 1 : pct >= 0.01 ? 2 : 3;
  return `${formatNumber(pct, digits)}%`;
}

/** A pressure change in kPa (aviation, metric) or psi (imperial), signed, e.g. "−1.94 kPa". */
export function formatPressureChange(deltaPa: number, system: UnitSystem): string {
  if (!Number.isFinite(deltaPa)) return '–';
  const imperial = system === 'imperial';
  const value = imperial ? deltaPa / PA_PER_PSI : deltaPa / 1000;
  const digits = Math.max(1, Math.min(3, sigDecimals(value, 2)));
  const text = formatNumber(value, digits);
  const zero = /^-?0(\.0+)?$/.test(text);
  return `${zero ? text.replace(/^-/, '') : signed(text, value < 0)} ${imperial ? 'psi' : 'kPa'}`;
}

/** An absolute pressure in kPa or psi, e.g. "24 kPa". */
export function formatPressure(pa: number, system: UnitSystem): string {
  if (!Number.isFinite(pa)) return '–';
  const imperial = system === 'imperial';
  const value = imperial ? pa / PA_PER_PSI : pa / 1000;
  return `${formatNumber(value, sigDecimals(value, 2))} ${imperial ? 'psi' : 'kPa'}`;
}

/** "12% faster than the wind" / "35% slower than the wind" / "the same speed as the wind". */
export function describeSpeedRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '–';
  const d = ratio - 1;
  if (Math.abs(d) < 0.005) return 'the same speed as the wind';
  if (ratio < 0.02) return 'almost still';
  return `${formatPercent(d)} ${d > 0 ? 'faster' : 'slower'} than the wind`;
}

/** "1.8% below the air around it" / "0.6% above the air around it". */
export function describePressureFraction(fraction: number): string {
  if (!Number.isFinite(fraction)) return '–';
  if (Math.abs(fraction) < 5e-5) return 'the same as the air around it';
  return `${formatPercent(fraction)} ${fraction < 0 ? 'below' : 'above'} the air around it`;
}

/**
 * Flow direction relative to the wind: "level", "4° upward", "12° downward". With a sideways
 * angle (3D), "6° downward, 2° toward the tip".
 */
export function describeDirection(
  upRad: number,
  sideRad?: number,
  sideName = 'toward the tip',
): string {
  if (!Number.isFinite(upRad)) return 'almost still';
  const up = (upRad * 180) / Math.PI;
  const parts: string[] = [];
  parts.push(
    Math.abs(up) < 0.5
      ? 'level'
      : `${formatNumber(Math.abs(up), Math.abs(up) < 10 ? 1 : 0)}° ${up > 0 ? 'upward' : 'downward'}`,
  );
  if (sideRad !== undefined && Number.isFinite(sideRad)) {
    const side = (sideRad * 180) / Math.PI;
    if (Math.abs(side) >= 0.5) {
      const name =
        side > 0 ? sideName : sideName === 'toward the tip' ? 'toward the body' : 'the other way';
      parts.push(`${formatNumber(Math.abs(side), Math.abs(side) < 10 ? 1 : 0)}° ${name}`);
    }
  }
  return parts.join(', ');
}

/** What a probe shows (2D and 3D share it). */
export interface ProbeText {
  inside: boolean;
  /** Headline, e.g. "Inside the wing" or "498 kt". */
  speed: string;
  /** "12% faster than the wind". */
  speedCompare: string;
  /** "1.8% below the air around it". */
  pressure: string;
  /** "−1.94 kPa". */
  pressureValue: string;
  /** "4° upward". */
  direction: string;
  /** One sentence for screen readers. */
  summary: string;
}

export interface ProbeTextInput {
  inside: boolean;
  speedRatio: number;
  /** Freestream speed (m/s), or NaN when unknown. */
  vInf: number;
  /** Pressure change (Pa) and as a fraction of the surrounding pressure. */
  deltaPressure: number;
  pressureFraction: number;
  /** Flow angle relative to the wind (rad, positive up) and sideways (rad, positive to the tip). */
  angleUp: number;
  angleSide?: number;
  /** In the dead air of a stall. */
  separated?: boolean;
}

export function probeText(r: ProbeTextInput, system: UnitSystem): ProbeText {
  if (r.inside) {
    const text = 'Inside the wing';
    return {
      inside: true,
      speed: text,
      speedCompare: 'No air here: move the probe into the flow.',
      pressure: '',
      pressureValue: '',
      direction: '',
      summary: 'The probe is inside the wing, where there is no air. Move it into the flow.',
    };
  }
  const speed = Number.isFinite(r.vInf)
    ? formatQuantity('speed', r.speedRatio * r.vInf, system)
    : `${formatNumber(r.speedRatio, 2)} × wind`;
  const speedCompare = describeSpeedRatio(r.speedRatio);
  const pressure = describePressureFraction(r.pressureFraction);
  const pressureValue = formatPressureChange(r.deltaPressure, system);
  const direction = describeDirection(r.angleUp, r.angleSide);
  const dead = r.separated ? ' This is the slow, swirling dead air of a stall.' : '';
  return {
    inside: false,
    speed,
    speedCompare,
    pressure,
    pressureValue,
    direction,
    summary: `Air here moves at ${speed}, ${speedCompare}, heading ${direction}. Its pressure is ${pressure} (${pressureValue}).${dead}`,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Numbers card: the pressure push and the air thrown down                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The average push per area as a resting weight, rounded to two significant figures:
 * { amount: "520 kg", area: "square metre" } (aviation, metric) or
 * { amount: "110 lb", area: "square foot" } (imperial). The sign is dropped.
 */
export function formatPushPerArea(
  massPerAreaKgM2: number,
  system: UnitSystem,
): { amount: string; area: string } {
  const imperial = system === 'imperial';
  const area = imperial ? 'square foot' : 'square metre';
  if (!Number.isFinite(massPerAreaKgM2)) return { amount: '–', area };
  const value = Math.abs(imperial ? massPerAreaKgM2 / KG_M2_PER_LB_FT2 : massPerAreaKgM2);
  const rounded = roundSig(value, 2);
  return {
    amount: `${formatNumber(rounded, rounded < 10 ? 1 : 0)} ${imperial ? 'lb' : 'kg'}`,
    area,
  };
}

/** Round to `sig` significant figures. */
export function roundSig(value: number, sig: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const e = Math.pow(10, Math.floor(Math.log10(Math.abs(value))) - sig + 1);
  return Math.round(value / e) * e;
}

/** A mass per second of air in the person's unit, rounded: "81 tonnes", "180,000 lb". */
export function formatAirMass(kg: number, system: UnitSystem): string {
  if (!Number.isFinite(kg)) return '–';
  const imperial = system === 'imperial';
  if (imperial) return `${formatNumber(roundSig(kg / 0.45359237, 2), 0)} lb`;
  const t = roundSig(kg / 1000, 2);
  return `${formatNumber(t, t < 10 ? 1 : 0)} tonnes`;
}

/** A small vertical speed: m/s for metric (with km/h), knots for aviation, mph for imperial. */
export function formatDownwashSpeed(ms: number, system: UnitSystem): string {
  if (!Number.isFinite(ms)) return '–';
  const v = Math.abs(ms);
  if (system === 'metric') return `${formatNumber(v, v < 10 ? 1 : 0)} m/s`;
  return formatQuantity('speed', v, system, { digits: v < 5 ? 1 : 0 });
}
