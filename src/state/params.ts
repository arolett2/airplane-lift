/**
 * User-facing configuration: what the person can change in the wind tunnel.
 * Angles here are in DEGREES (UI boundary). Physics converts to radians.
 */
import type { Naca4Params } from '../physics/types';

export type TipDeviceKind =
  | 'none'
  /** 747-400 style: a separate, canted, mostly vertical fin joined at a sharp corner. */
  | 'canted-winglet'
  /** 737NG / A320neo "sharklet" style: wing curves smoothly up into a tall winglet. */
  | 'blended-winglet'
  /** 747-8 / 787 style: extra span with much higher leading-edge sweep, staying in-plane. */
  | 'raked-tip'
  /** 737 MAX "AT winglet" / split scimitar: an upper winglet plus a smaller downward fin. */
  | 'split-winglet'
  /** A320ceo / A380 style: small fence projecting above and below the tip. */
  | 'wingtip-fence';

export interface TipDeviceConfig {
  kind: TipDeviceKind;
  /**
   * Size as a fraction of the base SEMISPAN. For winglets/fences: device height.
   * For raked tips: the in-plane span extension.
   */
  size: number;
  /** Cant from vertical (deg): 0 = straight up, 90 = flat. Ignored for raked tips. */
  cantDeg: number;
  /** Leading-edge sweep of the device (deg). */
  sweepDeg: number;
  /** Toe (deg), positive = leading edge turned outward. */
  toeDeg: number;
  /** Device tip chord / wing tip chord. */
  taper: number;
}

export interface FlapConfig {
  /** Trailing-edge flap deflection (deg), positive down. 0 = retracted. */
  deflectionDeg: number;
  /** Flap chord / local chord. */
  chordFrac: number;
  /** Flaps extend from the root to this fraction of the semispan. */
  spanFrac: number;
}

export interface YehudiConfig {
  /**
   * Inboard trailing-edge extension ("Yehudi") found on most airliners: the trailing edge is
   * straight from the root to a kink at `spanFrac` of the semispan, adding chord at the root.
   * spanFrac = 0 disables it.
   */
  spanFrac: number;
  /** Extra root chord as a fraction of the reference root chord. */
  chordFrac: number;
}

export interface WingConfig {
  /** Base wing span tip-to-tip (m), tip devices excluded. */
  span: number;
  /** Reference trapezoid chord at the centreline (m). */
  rootChord: number;
  /** Tip chord / root chord of the reference trapezoid. */
  taperRatio: number;
  /** Quarter-chord sweep (deg). */
  sweepDeg: number;
  /** Dihedral (deg), positive tips up. */
  dihedralDeg: number;
  /** Root incidence relative to the tunnel's zero (deg). Usually 0 in the tunnel. */
  rootIncidenceDeg: number;
  /** Washout (deg): tip incidence = root incidence - washout. Positive = tip nose-down. */
  washoutDeg: number;
  yehudi: YehudiConfig;
  airfoil: Naca4Params;
  /** Treat the section as a modern supercritical airfoil for critical-Mach estimates. */
  supercritical: boolean;
  tipDevice: TipDeviceConfig;
  flaps: FlapConfig;
  /** Leading-edge slats deployed. */
  slats: boolean;
}

export interface FlowConditions {
  /** Angle of attack of the wing root chord to the oncoming air (deg). */
  alphaDeg: number;
  /** True airspeed (m/s). */
  airspeed: number;
  /** Pressure altitude (m), International Standard Atmosphere. */
  altitude: number;
}

export type FlowVizMode = 'streamlines' | 'particles' | 'both' | 'off';
export type ColorBy = 'pressure' | 'speed';
export type RakeMode = 'vertical' | 'horizontal' | 'tip-vortex';
export type CameraShot = 'overview' | 'side' | 'front' | 'top' | 'tip' | 'behind' | 'section';
export type UnitSystem = 'aviation' | 'metric' | 'imperial';
/** Background of the 2D cross-section: pressure colours, or pressure as hills and valleys. */
export type SectionBackdrop = 'tint' | 'terrain';
/**
 * Whose point of view the 2D cross-section shows the air from: the wing's (the tunnel: air
 * streams past) or the air's (the freestream subtracted: what the passing wing does to still air).
 */
export type SectionFrame = 'wing' | 'air';

/** Probe position in the 2D cross-section, display frame (chords; air flows along +x, y up,
 * origin at the leading edge). */
export interface SectionProbe {
  x: number;
  y: number;
}

export interface RakeConfig {
  mode: RakeMode;
  /** Spanwise station of the smoke rake, -1 (left tip) .. 1 (right tip). Used by 'vertical'. */
  eta: number;
  /** Rake height relative to the wing, as a fraction of the base semispan (-0.3 .. 0.3). */
  height: number;
  /** Number of smoke lines (8 .. 64). */
  count: number;
}

export interface ViewSettings {
  flowMode: FlowVizMode;
  colorBy: ColorBy;
  /** Colour the wing surface by pressure coefficient. */
  showSurfacePressure: boolean;
  /** Lift / drag / resultant arrows. */
  showForces: boolean;
  /** Spanwise lift distribution drawn on the wing. */
  showSpanLoad: boolean;
  rake: RakeConfig;
  /** Particle budget multiplier (0.25 .. 2). */
  particleDensity: number;
  /** Animation speed multiplier (0.05 .. 2). 1 = air crosses the tunnel in ~4 s. */
  playbackSpeed: number;
  paused: boolean;
  /** Span station (0 root .. 1 tip, right wing) shown in the 2D cross-section view. */
  sectionEta: number;
  units: UnitSystem;
  /** Show the full engineering readouts (coefficients, Reynolds, Mach, ...). */
  engineerMode: boolean;
  camera: CameraShot;
  /** Cross-section background (see SectionBackdrop). */
  sectionBackdrop: SectionBackdrop;
  /** Cross-section point of view (see SectionFrame). */
  sectionFrame: SectionFrame;
  /** Probe in the cross-section, or null when it is not placed. Not shared in links. */
  sectionProbe: SectionProbe | null;
}

export interface LessonProgress {
  lessonId: string | null;
  step: number;
}

export interface AppState {
  /** Preset the current wing came from; null once the user edits the wing ("Custom"). */
  presetId: string | null;
  wing: WingConfig;
  flow: FlowConditions;
  view: ViewSettings;
  lesson: LessonProgress;
  /** Preset ids being compared side by side, or null when the compare view is closed. */
  compare: [string, string] | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Defaults                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export const NO_TIP_DEVICE: TipDeviceConfig = {
  kind: 'none',
  size: 0,
  cantDeg: 0,
  sweepDeg: 0,
  toeDeg: 0,
  taper: 1,
};

/** Typical shape of each tip device, applied when the user picks a device kind. */
export const TIP_DEVICE_DEFAULTS: Record<TipDeviceKind, TipDeviceConfig> = {
  none: NO_TIP_DEVICE,
  'canted-winglet': {
    kind: 'canted-winglet',
    size: 0.06,
    cantDeg: 30,
    sweepDeg: 60,
    toeDeg: -2,
    taper: 0.35,
  },
  'blended-winglet': {
    kind: 'blended-winglet',
    size: 0.14,
    cantDeg: 15,
    sweepDeg: 50,
    toeDeg: -2,
    taper: 0.3,
  },
  'raked-tip': { kind: 'raked-tip', size: 0.06, cantDeg: 90, sweepDeg: 55, toeDeg: 0, taper: 0.25 },
  'split-winglet': {
    kind: 'split-winglet',
    size: 0.13,
    cantDeg: 20,
    sweepDeg: 55,
    toeDeg: -2,
    taper: 0.3,
  },
  'wingtip-fence': {
    kind: 'wingtip-fence',
    size: 0.04,
    cantDeg: 0,
    sweepDeg: 50,
    toeDeg: 0,
    taper: 0.5,
  },
};

/** A simple straight, untwisted teaching wing (NACA 2412). */
export const DEFAULT_WING: WingConfig = {
  span: 10,
  rootChord: 1.5,
  taperRatio: 1,
  sweepDeg: 0,
  dihedralDeg: 0,
  rootIncidenceDeg: 0,
  washoutDeg: 0,
  yehudi: { spanFrac: 0, chordFrac: 0 },
  airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
  supercritical: false,
  tipDevice: NO_TIP_DEVICE,
  flaps: { deflectionDeg: 0, chordFrac: 0.25, spanFrac: 0.6 },
  slats: false,
};

export const DEFAULT_FLOW: FlowConditions = { alphaDeg: 5, airspeed: 60, altitude: 0 };

/**
 * First impression: smoke (a sheet across the span plus the tips) and a vertical smoke rake at
 * 35% of the right semispan, coloured by pressure, on a pressure-coloured wing. 18 rake lines
 * are enough to show the bending over the airfoil without becoming a wall of lines.
 */
export const DEFAULT_VIEW: ViewSettings = {
  flowMode: 'both',
  colorBy: 'pressure',
  showSurfacePressure: true,
  showForces: true,
  showSpanLoad: false,
  rake: { mode: 'vertical', eta: 0.35, height: 0, count: 18 },
  particleDensity: 1,
  playbackSpeed: 1,
  paused: false,
  sectionEta: 0.35,
  units: 'aviation',
  engineerMode: false,
  camera: 'overview',
  sectionBackdrop: 'tint',
  sectionFrame: 'wing',
  sectionProbe: null,
};

/** The id of the preset loaded on first visit (see presets.ts). */
export const INITIAL_PRESET_ID = 'b737-800';

export const DEFAULT_STATE: AppState = {
  presetId: null,
  wing: DEFAULT_WING,
  flow: DEFAULT_FLOW,
  view: DEFAULT_VIEW,
  lesson: { lessonId: null, step: 0 },
  compare: null,
};

/* ------------------------------------------------------------------------------------------ */
/* Parameter specs — drive slider generation, validation and help text                        */
/* ------------------------------------------------------------------------------------------ */

export type ParamGroup = 'flight' | 'planform' | 'airfoil' | 'tip' | 'high-lift';

/** Dotted path into AppState, e.g. "wing.span" or "wing.tipDevice.cantDeg". */
export type ParamPath = string;

export interface ParamSpec {
  path: ParamPath;
  group: ParamGroup;
  label: string;
  /** Unit of the stored value (SI / degrees). Display conversion is done by the UI. */
  unit: 'deg' | 'm' | 'm/s' | 'ratio' | 'percent-chord' | 'fraction';
  min: number;
  max: number;
  step: number;
  /** One or two plain-language sentences for a curious adult. */
  help: string;
  /** Only shown in engineer mode. */
  advanced?: boolean;
}

export const PARAM_SPECS: readonly ParamSpec[] = [
  // Flight
  {
    path: 'flow.alphaDeg',
    group: 'flight',
    label: 'Angle of attack',
    unit: 'deg',
    min: -10,
    max: 25,
    step: 0.1,
    help: 'How steeply the wing meets the oncoming air. More angle turns more air downward and makes more lift, until the flow can no longer follow the upper surface and the wing stalls.',
  },
  {
    path: 'flow.airspeed',
    group: 'flight',
    label: 'Airspeed',
    unit: 'm/s',
    min: 5,
    max: 280,
    step: 1,
    help: 'Lift grows with the square of speed: twice as fast means four times the lift.',
  },
  {
    path: 'flow.altitude',
    group: 'flight',
    label: 'Altitude',
    unit: 'm',
    min: 0,
    max: 13000,
    step: 50,
    help: 'Air gets thinner as you climb. Thinner air pushes less, so airliners must fly much faster at cruise altitude to make the same lift.',
  },
  // Planform
  {
    path: 'wing.span',
    group: 'planform',
    label: 'Wingspan',
    unit: 'm',
    min: 4,
    max: 90,
    step: 0.1,
    help: 'Tip-to-tip width. Longer wings disturb a wider stream of air more gently, which wastes less energy in wingtip vortices.',
  },
  {
    path: 'wing.rootChord',
    group: 'planform',
    label: 'Root chord',
    unit: 'm',
    min: 0.3,
    max: 20,
    step: 0.05,
    help: 'Front-to-back depth of the wing where it meets the body.',
  },
  {
    path: 'wing.taperRatio',
    group: 'planform',
    label: 'Taper',
    unit: 'ratio',
    min: 0.1,
    max: 1,
    step: 0.01,
    help: 'Tip chord divided by root chord. Tapering puts the lift where the structure is strongest and brings the lift distribution closer to the efficient elliptical shape.',
  },
  {
    path: 'wing.sweepDeg',
    group: 'planform',
    label: 'Sweep',
    unit: 'deg',
    min: -10,
    max: 60,
    step: 0.5,
    help: 'Swinging the wing back lets jets fly close to the speed of sound before shock waves form, at the cost of some low-speed lift.',
  },
  {
    path: 'wing.dihedralDeg',
    group: 'planform',
    label: 'Dihedral',
    unit: 'deg',
    min: -10,
    max: 15,
    step: 0.5,
    help: 'Upward tilt of the wings, which makes the aircraft naturally roll back to level.',
  },
  {
    path: 'wing.washoutDeg',
    group: 'planform',
    label: 'Washout (tip twist)',
    unit: 'deg',
    min: -5,
    max: 10,
    step: 0.1,
    help: 'Twisting the tips nose-down so the inner wing stalls first and the ailerons keep working.',
  },
  {
    path: 'wing.rootIncidenceDeg',
    group: 'planform',
    label: 'Root incidence',
    unit: 'deg',
    min: -5,
    max: 8,
    step: 0.1,
    help: 'Built-in angle of the wing root relative to the tunnel.',
    advanced: true,
  },
  {
    path: 'wing.yehudi.spanFrac',
    group: 'planform',
    label: 'Inboard trailing-edge kink',
    unit: 'fraction',
    min: 0,
    max: 0.5,
    step: 0.01,
    help: 'Most airliners add extra chord near the body (a "Yehudi") to fit the landing gear and give the root more depth.',
    advanced: true,
  },
  {
    path: 'wing.yehudi.chordFrac',
    group: 'planform',
    label: 'Kink chord extension',
    unit: 'fraction',
    min: 0,
    max: 0.6,
    step: 0.01,
    help: 'How much extra chord the inboard trailing-edge extension adds at the root.',
    advanced: true,
  },
  // Airfoil
  {
    path: 'wing.airfoil.camber',
    group: 'airfoil',
    label: 'Camber',
    unit: 'percent-chord',
    min: 0,
    max: 0.09,
    step: 0.001,
    help: 'How curved the wing section is. A cambered wing makes lift even at zero angle of attack.',
  },
  {
    path: 'wing.airfoil.camberPos',
    group: 'airfoil',
    label: 'Camber position',
    unit: 'fraction',
    min: 0.1,
    max: 0.9,
    step: 0.01,
    help: 'Where along the chord the curve is highest.',
    advanced: true,
  },
  {
    path: 'wing.airfoil.thickness',
    group: 'airfoil',
    label: 'Thickness',
    unit: 'percent-chord',
    min: 0.04,
    max: 0.24,
    step: 0.001,
    help: 'Thicker sections stall more gently and hold more fuel and structure, but make shock waves sooner at high speed.',
  },
  // Tip devices
  {
    path: 'wing.tipDevice.size',
    group: 'tip',
    label: 'Tip device size',
    unit: 'fraction',
    min: 0,
    max: 0.2,
    step: 0.005,
    help: 'Height of the winglet, or length of the raked extension, as a fraction of the half-span.',
  },
  {
    path: 'wing.tipDevice.cantDeg',
    group: 'tip',
    label: 'Cant angle',
    unit: 'deg',
    min: 0,
    max: 90,
    step: 1,
    help: 'How far the winglet leans out from vertical. At 90° it becomes a flat span extension.',
  },
  {
    path: 'wing.tipDevice.sweepDeg',
    group: 'tip',
    label: 'Tip device sweep',
    unit: 'deg',
    min: 0,
    max: 70,
    step: 1,
    help: 'Leading-edge sweep of the tip device.',
    advanced: true,
  },
  {
    path: 'wing.tipDevice.toeDeg',
    group: 'tip',
    label: 'Toe angle',
    unit: 'deg',
    min: -8,
    max: 8,
    step: 0.1,
    help: 'Small twist that lets the winglet use the swirl around the tip to make a little forward thrust.',
    advanced: true,
  },
  {
    path: 'wing.tipDevice.taper',
    group: 'tip',
    label: 'Tip device taper',
    unit: 'ratio',
    min: 0.1,
    max: 1,
    step: 0.01,
    help: 'Chord at the top of the device compared with the wing tip chord.',
    advanced: true,
  },
  // High lift
  {
    path: 'wing.flaps.deflectionDeg',
    group: 'high-lift',
    label: 'Flaps',
    unit: 'deg',
    min: 0,
    max: 40,
    step: 1,
    help: 'Flaps add camber to the back of the wing for slow flight. They add a lot of lift and a lot of drag, which suits landing.',
  },
  {
    path: 'wing.flaps.chordFrac',
    group: 'high-lift',
    label: 'Flap chord',
    unit: 'fraction',
    min: 0.1,
    max: 0.4,
    step: 0.01,
    help: 'Depth of the flap as a fraction of the local chord.',
    advanced: true,
  },
  {
    path: 'wing.flaps.spanFrac',
    group: 'high-lift',
    label: 'Flap span',
    unit: 'fraction',
    min: 0.1,
    max: 0.9,
    step: 0.01,
    help: 'Flaps run from the root to this fraction of the half-span. The outer part is left for the ailerons.',
    advanced: true,
  },
];

export const PARAM_SPEC_BY_PATH: ReadonlyMap<ParamPath, ParamSpec> = new Map(
  PARAM_SPECS.map((s) => [s.path, s]),
);
