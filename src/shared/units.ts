/**
 * Unit conversion and number formatting for display.
 *
 * Everything inside the app (state, physics, worker) is SI + degrees. These helpers convert to
 * the person's chosen `UnitSystem` only at the display boundary:
 *
 *   aviation: knots, feet, kilonewtons, square feet, tonnes
 *   metric:   km/h, metres, kilonewtons, square metres, tonnes
 *   imperial: mph, feet, pounds-force, square feet, pounds
 *
 * Pure functions, no DOM, so they are trivially testable.
 */
import type { UnitSystem } from '../state/params';

export type { UnitSystem };

/** Standard gravity (m/s^2), used to turn a lift force into "the mass it can hold up". */
export const GRAVITY = 9.80665;

/** What a number measures. Decides the unit shown for each `UnitSystem`. */
export type QuantityKind =
  | 'speed'
  | 'altitude'
  | 'length'
  | 'force'
  | 'area'
  | 'mass'
  | 'angle'
  /** Plain dimensionless number (taper ratio, coefficients). */
  | 'ratio'
  /** A 0..1 fraction shown as a percentage. */
  | 'percent'
  /** A speed or density multiplier shown as "1.5×". */
  | 'multiplier';

export const UNIT_SYSTEMS: readonly UnitSystem[] = ['aviation', 'metric', 'imperial'];

export const UNIT_SYSTEM_LABELS: Record<UnitSystem, string> = {
  aviation: 'Aviation',
  metric: 'Metric',
  imperial: 'Imperial',
};

export interface UnitDef {
  kind: QuantityKind;
  /** Short symbol, e.g. "kt". */
  symbol: string;
  /** Spelled-out plural name for sentences, e.g. "knots". */
  name: string;
  /** SI value -> display value. */
  toDisplay(si: number): number;
  /** Display value -> SI value. */
  fromDisplay(display: number): number;
}

const M_PER_FT = 0.3048;
const M_PER_S_PER_KT = 1852 / 3600;
const M_PER_S_PER_MPH = 0.44704;
const N_PER_LBF = 4.4482216152605;
const KG_PER_LB = 0.45359237;

function linear(kind: QuantityKind, symbol: string, name: string, perSi: number): UnitDef {
  return {
    kind,
    symbol,
    name,
    toDisplay: (si) => si * perSi,
    fromDisplay: (display) => display / perSi,
  };
}

const KT = linear('speed', 'kt', 'knots', 1 / M_PER_S_PER_KT);
const KMH = linear('speed', 'km/h', 'kilometres per hour', 3.6);
const MPH = linear('speed', 'mph', 'miles per hour', 1 / M_PER_S_PER_MPH);
const FT_ALT = linear('altitude', 'ft', 'feet', 1 / M_PER_FT);
const M_ALT = linear('altitude', 'm', 'metres', 1);
const FT = linear('length', 'ft', 'feet', 1 / M_PER_FT);
const M = linear('length', 'm', 'metres', 1);
const KN = linear('force', 'kN', 'kilonewtons', 1e-3);
const LBF = linear('force', 'lbf', 'pounds-force', 1 / N_PER_LBF);
const FT2 = linear('area', 'ft²', 'square feet', 1 / (M_PER_FT * M_PER_FT));
const M2 = linear('area', 'm²', 'square metres', 1);
const TONNE = linear('mass', 't', 'tonnes', 1e-3);
const LB = linear('mass', 'lb', 'pounds', 1 / KG_PER_LB);
const DEG = linear('angle', '°', 'degrees', 1);
const RATIO = linear('ratio', '', '', 1);
const PERCENT = linear('percent', '%', 'percent', 100);
const MULT = linear('multiplier', '×', 'times', 1);

const UNIT_TABLE: Record<QuantityKind, Record<UnitSystem, UnitDef>> = {
  speed: { aviation: KT, metric: KMH, imperial: MPH },
  altitude: { aviation: FT_ALT, metric: M_ALT, imperial: FT_ALT },
  length: { aviation: FT, metric: M, imperial: FT },
  force: { aviation: KN, metric: KN, imperial: LBF },
  area: { aviation: FT2, metric: M2, imperial: FT2 },
  mass: { aviation: TONNE, metric: TONNE, imperial: LB },
  angle: { aviation: DEG, metric: DEG, imperial: DEG },
  ratio: { aviation: RATIO, metric: RATIO, imperial: RATIO },
  percent: { aviation: PERCENT, metric: PERCENT, imperial: PERCENT },
  multiplier: { aviation: MULT, metric: MULT, imperial: MULT },
};

/** The unit definition (symbol + conversions) for a quantity in a unit system. */
export function unitFor(kind: QuantityKind, system: UnitSystem): UnitDef {
  return UNIT_TABLE[kind][system];
}

/** Symbols that read better glued to the number ("5.0°", "35%", "1.5×"). */
const ATTACHED_SYMBOLS = new Set(['°', '%', '×']);

/** Decimals that give about `sig` significant digits for a value of this magnitude (0..3). */
export function sigDecimals(value: number, sig = 3): number {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return Math.min(3, sig - 1);
  const intDigits = Math.floor(Math.log10(abs)) + 1;
  return Math.min(3, Math.max(0, sig - intDigits));
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(digits: number, grouping: boolean): Intl.NumberFormat {
  const key = `${digits}:${grouping}`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: grouping,
    });
    formatterCache.set(key, f);
  }
  return f;
}

export interface FormatNumberOptions {
  /** Thousands separators (default true). Turn off for editable fields. */
  grouping?: boolean;
}

/** Format a number with a fixed number of decimals; never prints "-0" or "NaN". */
export function formatNumber(
  value: number,
  digits: number,
  options: FormatNumberOptions = {},
): string {
  if (!Number.isFinite(value)) return '–';
  const d = Math.max(0, Math.min(6, Math.round(digits)));
  const half = 0.5 * Math.pow(10, -d);
  const v = Math.abs(value) < half ? 0 : value;
  return formatter(d, options.grouping ?? true).format(v);
}

/** Default number of decimals for a displayed value of this kind. */
export function defaultDigits(kind: QuantityKind, displayValue: number): number {
  switch (kind) {
    case 'speed':
    case 'altitude':
    case 'percent':
      return 0;
    case 'angle':
      return 1;
    case 'ratio':
    case 'multiplier':
      return 2;
    default:
      return sigDecimals(displayValue, 3);
  }
}

export interface FormatOptions {
  /** Override the number of decimals. */
  digits?: number;
  grouping?: boolean;
}

export interface QuantityParts {
  /** The formatted number, e.g. "152.3". */
  value: string;
  /** Unit symbol, e.g. "kN" ('' when the kind has none). */
  unit: string;
}

/** Convert an SI value and format it, returning the number and the unit separately. */
export function formatParts(
  kind: QuantityKind,
  si: number,
  system: UnitSystem,
  options: FormatOptions = {},
): QuantityParts {
  const def = unitFor(kind, system);
  const display = def.toDisplay(si);
  const digits = options.digits ?? defaultDigits(kind, display);
  return { value: formatNumber(display, digits, options), unit: def.symbol };
}

/** Convert an SI value and format it with its unit, e.g. `formatQuantity('speed', 77, 'aviation')` -> "150 kt". */
export function formatQuantity(
  kind: QuantityKind,
  si: number,
  system: UnitSystem,
  options: FormatOptions = {},
): string {
  const { value, unit } = formatParts(kind, si, system, options);
  if (unit === '') return value;
  return ATTACHED_SYMBOLS.has(unit) ? `${value}${unit}` : `${value} ${unit}`;
}

export const formatSpeed = (ms: number, system: UnitSystem, o?: FormatOptions) =>
  formatQuantity('speed', ms, system, o);
export const formatAltitude = (m: number, system: UnitSystem, o?: FormatOptions) =>
  formatQuantity('altitude', m, system, o);
export const formatLength = (m: number, system: UnitSystem, o?: FormatOptions) =>
  formatQuantity('length', m, system, o);
export const formatForce = (n: number, system: UnitSystem, o?: FormatOptions) =>
  formatQuantity('force', n, system, o);
export const formatArea = (m2: number, system: UnitSystem, o?: FormatOptions) =>
  formatQuantity('area', m2, system, o);
export const formatMass = (kg: number, system: UnitSystem, o?: FormatOptions) =>
  formatQuantity('mass', kg, system, o);
/** Angles are stored in degrees already; this only formats. */
export const formatAngle = (deg: number, o?: FormatOptions) =>
  formatQuantity('angle', deg, 'metric', o);

/** Mass (kg) that a given lift force (N) can hold up in 1 g. */
export function massSupportedByLift(liftN: number): number {
  return liftN / GRAVITY;
}

/** Weight (N) of a mass in kg. */
export function weightOfMass(massKg: number): number {
  return massKg * GRAVITY;
}
