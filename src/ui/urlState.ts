/**
 * Shareable URL state.
 *
 * `encodeState` squeezes the parts of AppState that define "what you are looking at" (aircraft,
 * wing, flight conditions and a few view choices) into a short base64url string that is safe in
 * a URL hash. `decodeState` reverses it defensively: any malformed input yields the fallback
 * state, and numbers are clamped to the ranges in PARAM_SPECS so a hand-edited link can never
 * put the solver outside its supported envelope.
 *
 * Format (JSON, positional arrays to stay compact; bump `VERSION` when the layout changes):
 *   { v, p: presetId|null, w: [20 wing numbers], t: tipKindIndex, b: bitflags,
 *     f: [alpha, airspeed, altitude], o: [flowMode, colorBy, rakeMode, rakeEta, rakeHeight,
 *     rakeCount, sectionEta, units, camera] }
 */
import type {
  AppState,
  CameraShot,
  ColorBy,
  FlowVizMode,
  RakeMode,
  TipDeviceKind,
  UnitSystem,
} from '../state/params';
import { PARAM_SPEC_BY_PATH } from '../state/params';
import { getPreset } from '../state/presets';
import { getPath, setPath } from '../state/store';

const VERSION = 1;

/** Numeric wing/flow parameters, in a fixed order. All have a ParamSpec range to clamp to. */
const WING_PATHS = [
  'wing.span',
  'wing.rootChord',
  'wing.taperRatio',
  'wing.sweepDeg',
  'wing.dihedralDeg',
  'wing.rootIncidenceDeg',
  'wing.washoutDeg',
  'wing.yehudi.spanFrac',
  'wing.yehudi.chordFrac',
  'wing.airfoil.camber',
  'wing.airfoil.camberPos',
  'wing.airfoil.thickness',
  'wing.tipDevice.size',
  'wing.tipDevice.cantDeg',
  'wing.tipDevice.sweepDeg',
  'wing.tipDevice.toeDeg',
  'wing.tipDevice.taper',
  'wing.flaps.deflectionDeg',
  'wing.flaps.chordFrac',
  'wing.flaps.spanFrac',
] as const;

const FLOW_PATHS = ['flow.alphaDeg', 'flow.airspeed', 'flow.altitude'] as const;

const TIP_KINDS: readonly TipDeviceKind[] = [
  'none',
  'canted-winglet',
  'blended-winglet',
  'raked-tip',
  'split-winglet',
  'wingtip-fence',
];
const FLOW_MODES: readonly FlowVizMode[] = ['streamlines', 'particles', 'both', 'off'];
const COLOR_BYS: readonly ColorBy[] = ['pressure', 'speed'];
const RAKE_MODES: readonly RakeMode[] = ['vertical', 'horizontal', 'tip-vortex'];
const UNIT_SYSTEMS_ORDER: readonly UnitSystem[] = ['aviation', 'metric', 'imperial'];
const CAMERAS: readonly CameraShot[] = [
  'overview',
  'side',
  'front',
  'top',
  'tip',
  'behind',
  'section',
];

/** Bit flags packed into `b`. */
const FLAG_SUPERCRITICAL = 1;
const FLAG_SLATS = 2;
const FLAG_SURFACE_PRESSURE = 4;
const FLAG_FORCES = 8;
const FLAG_SPAN_LOAD = 16;

const RAKE_ETA_RANGE: readonly [number, number] = [-1, 1];
const RAKE_HEIGHT_RANGE: readonly [number, number] = [-0.3, 0.3];
const RAKE_COUNT_RANGE: readonly [number, number] = [8, 64];
const SECTION_ETA_RANGE: readonly [number, number] = [0, 1];
const MAX_PRESET_ID_LENGTH = 64;
const MAX_PAYLOAD_LENGTH = 4096;

class DecodeError extends Error {}

/* ------------------------------------------------------------------------------------------ */
/* base64url                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new DecodeError('not base64url');
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/* ------------------------------------------------------------------------------------------ */
/* Encode                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Round to 4 decimals: far finer than any slider step, and keeps the JSON short. */
function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : 0;
}

function indexOrZero<T>(list: readonly T[], value: T): number {
  const i = list.indexOf(value);
  return i < 0 ? 0 : i;
}

/** Compact, URL-hash-safe encoding of the shareable part of the state. */
export function encodeState(state: AppState): string {
  const { wing, view } = state;
  let flags = 0;
  if (wing.supercritical) flags |= FLAG_SUPERCRITICAL;
  if (wing.slats) flags |= FLAG_SLATS;
  if (view.showSurfacePressure) flags |= FLAG_SURFACE_PRESSURE;
  if (view.showForces) flags |= FLAG_FORCES;
  if (view.showSpanLoad) flags |= FLAG_SPAN_LOAD;

  const payload = {
    v: VERSION,
    p: state.presetId,
    w: WING_PATHS.map((path) => round4(Number(getPath(state, path)))),
    t: indexOrZero(TIP_KINDS, wing.tipDevice.kind),
    b: flags,
    f: FLOW_PATHS.map((path) => round4(Number(getPath(state, path)))),
    o: [
      indexOrZero(FLOW_MODES, view.flowMode),
      indexOrZero(COLOR_BYS, view.colorBy),
      indexOrZero(RAKE_MODES, view.rake.mode),
      round4(view.rake.eta),
      round4(view.rake.height),
      Math.round(view.rake.count),
      round4(view.sectionEta),
      indexOrZero(UNIT_SYSTEMS_ORDER, view.units),
      indexOrZero(CAMERAS, view.camera),
    ],
  };
  return toBase64Url(JSON.stringify(payload));
}

/* ------------------------------------------------------------------------------------------ */
/* Decode                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DecodeError('expected object');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new DecodeError('bad array');
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DecodeError('bad number');
  return value;
}

function clampTo(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function asEnum<T>(value: unknown, list: readonly T[]): T {
  const i = asNumber(value);
  const item = Number.isInteger(i) ? list[i] : undefined;
  if (item === undefined) throw new DecodeError('bad enum index');
  return item;
}

function clampToSpec(path: string, value: number): number {
  const spec = PARAM_SPEC_BY_PATH.get(path);
  if (!spec) throw new DecodeError(`no spec for ${path}`);
  return clampTo(value, spec.min, spec.max);
}

function decodeUnsafe(payloadText: string, fallback: AppState): AppState {
  if (payloadText.length === 0 || payloadText.length > MAX_PAYLOAD_LENGTH) {
    throw new DecodeError('bad length');
  }
  const root = asRecord(JSON.parse(fromBase64Url(payloadText)));
  if (root.v !== VERSION) throw new DecodeError('unsupported version');

  let next: AppState = fallback;

  const wingValues = asArray(root.w, WING_PATHS.length);
  WING_PATHS.forEach((path, i) => {
    next = setPath(next, path, clampToSpec(path, asNumber(wingValues[i])));
  });

  const flowValues = asArray(root.f, FLOW_PATHS.length);
  FLOW_PATHS.forEach((path, i) => {
    next = setPath(next, path, clampToSpec(path, asNumber(flowValues[i])));
  });

  const flags = asNumber(root.b);
  if (!Number.isInteger(flags) || flags < 0 || flags > 255) throw new DecodeError('bad flags');
  next = setPath(next, 'wing.tipDevice.kind', asEnum(root.t, TIP_KINDS));
  next = setPath(next, 'wing.supercritical', (flags & FLAG_SUPERCRITICAL) !== 0);
  next = setPath(next, 'wing.slats', (flags & FLAG_SLATS) !== 0);
  next = setPath(next, 'view.showSurfacePressure', (flags & FLAG_SURFACE_PRESSURE) !== 0);
  next = setPath(next, 'view.showForces', (flags & FLAG_FORCES) !== 0);
  next = setPath(next, 'view.showSpanLoad', (flags & FLAG_SPAN_LOAD) !== 0);

  const o = asArray(root.o, 9);
  next = setPath(next, 'view.flowMode', asEnum(o[0], FLOW_MODES));
  next = setPath(next, 'view.colorBy', asEnum(o[1], COLOR_BYS));
  next = setPath(next, 'view.rake.mode', asEnum(o[2], RAKE_MODES));
  next = setPath(next, 'view.rake.eta', clampTo(asNumber(o[3]), ...RAKE_ETA_RANGE));
  next = setPath(next, 'view.rake.height', clampTo(asNumber(o[4]), ...RAKE_HEIGHT_RANGE));
  next = setPath(next, 'view.rake.count', Math.round(clampTo(asNumber(o[5]), ...RAKE_COUNT_RANGE)));
  next = setPath(next, 'view.sectionEta', clampTo(asNumber(o[6]), ...SECTION_ETA_RANGE));
  next = setPath(next, 'view.units', asEnum(o[7], UNIT_SYSTEMS_ORDER));
  next = setPath(next, 'view.camera', asEnum(o[8], CAMERAS));

  // A preset id is only kept when it names a preset we know; otherwise the wing is "Custom".
  let presetId: string | null = null;
  if (root.p !== null) {
    if (typeof root.p !== 'string' || root.p.length > MAX_PRESET_ID_LENGTH) {
      throw new DecodeError('bad preset id');
    }
    presetId = getPreset(root.p) ? root.p : null;
  }
  return { ...next, presetId };
}

/**
 * Decode a hash produced by `encodeState`. Accepts an optional leading "#". Returns `fallback`
 * (the same object) when the hash is empty, malformed, from another version or otherwise invalid.
 */
export function decodeState(hash: string, fallback: AppState): AppState {
  try {
    const text = hash.replace(/^#/, '').trim();
    if (text === '') return fallback;
    return decodeUnsafe(text, fallback);
  } catch {
    return fallback;
  }
}
