/**
 * Wingtip devices: winglets, raked tips and fences, built as extra lifting surfaces that hang off
 * the base wing's tip section.
 * OWNER: physics-geometry agent.
 *
 * Everything here is BODY frame, metres, radians, and builds the RIGHT-hand side only; the caller
 * (`buildWingGeometry`) mirrors the surfaces for the left side. See `WingSection` in
 * `physics/types.ts` for the meaning of `roll` and `twist`.
 *
 * SIZE CONVENTION. `TipDeviceConfig.size` is a fraction of the base semispan and `h = size *
 * semispan` is the length of the device measured ALONG ITS SPAN (arc length from the wing tip to
 * the device tip). A vertical winglet therefore rises exactly `h`; a canted winglet rises `h cos
 * (cant)` and leans out by `h sin(cant)`; at 90 deg cant the device is a flat span extension of
 * length `h`. The raked tip is the one exception: its in-plane extension is exactly `h` in y, so
 * the overall span grows by exactly 2 h.
 *
 * TOE. `toeDeg > 0` turns a device's leading edge OUTBOARD on both sides. Twist is rotation about
 * the section's span tangent with positive = nose toward the surface normal. On a vertical right
 * surface (roll +90 deg) the normal points inboard, so turning the LE outboard is NEGATIVE twist;
 * on a downward fin (roll -90 deg) the normal points outboard, so it is POSITIVE twist. For any
 * roll the twist that gives `toe` is `-toe * sin(roll)`; it vanishes on a flat (in-plane)
 * surface, where toe has no meaning. The left side is an exact mirror (twist and roll values are
 * unchanged), so the same sign turns the left LE outboard too.
 */
import type { LiftingSurface, Naca4Params, Vec3, WingSection } from '../types';
import type { TipDeviceConfig } from '../../state/params';

const DEG = Math.PI / 180;
const EPS = 1e-9;

/** Lower bound for any device chord relative to the tip chord, so geometry never degenerates. */
const MIN_CHORD_FRACTION = 0.02;
/** Leading-edge sweep is clamped to this range (rad) so tan() stays finite. */
const MAX_SWEEP = 80 * DEG;

/** sin(x)/x, safe near zero. */
function sinc(x: number): number {
  return Math.abs(x) < 1e-6 ? 1 - (x * x) / 6 : Math.sin(x) / x;
}

/**
 * Description of one device surface as a path in the (y, z) plane.
 *
 * The surface is parameterised by arc length `s` along its span tangent, 0 at the root (on the
 * wing tip) to `length` at the device tip. The roll angle changes linearly from `roll0` to
 * `roll1` over the first `blendLength` of that path (constant curvature, i.e. a circular arc in
 * the y-z plane) and stays at `roll1` afterwards.
 */
interface DeviceSpec {
  /** Leading edge of the root section. */
  le0: Vec3;
  chordRoot: number;
  chordTip: number;
  roll0: number;
  roll1: number;
  /** Arc length over which the roll turns from roll0 to roll1 (0 = no blend). */
  blendLength: number;
  /** Number of equal pieces the blend arc is cut into (sections = pieces + 1 on the arc). */
  blendPieces: number;
  /** Extra section stations on the straight part, as fractions of `length`. */
  interiorStations: readonly number[];
  /** Total path length (m). */
  length: number;
  /** Leading-edge sweep (rad): x advance per metre of span path. */
  sweep: number;
  /** Maps u = s/length in [0, 1] to the fraction of the total LE x-advance reached at u. */
  sweepProfile: (u: number) => number;
  /** Incidence inherited from the wing tip, fading out as the roll turns to its final value. */
  twistRoot: number;
  /** Toe (rad), positive = LE outboard. */
  toe: number;
  airfoil: Naca4Params;
}

/** Section stations (arc length from the root) for a device. */
function deviceStations(spec: DeviceSpec): number[] {
  const stations = [0];
  const blend = Math.min(Math.max(spec.blendLength, 0), spec.length);
  if (blend > EPS) {
    for (let k = 1; k <= spec.blendPieces; k++) stations.push((blend * k) / spec.blendPieces);
  }
  for (const u of spec.interiorStations) {
    const s = u * spec.length;
    if (s > stations[stations.length - 1]! + EPS * spec.length && s < spec.length) stations.push(s);
  }
  if (spec.length > stations[stations.length - 1]! + EPS) stations.push(spec.length);
  return stations;
}

/** Sections of one right-hand device surface, ordered root -> tip. */
function buildDeviceSections(spec: DeviceSpec): WingSection[] {
  const blend = Math.min(Math.max(spec.blendLength, 0), spec.length);
  const rollAt = (s: number): number =>
    blend > EPS && s < blend ? spec.roll0 + ((spec.roll1 - spec.roll0) * s) / blend : spec.roll1;
  const rollSpan = spec.roll1 - spec.roll0;
  const tanSweep = Math.tan(spec.sweep);

  const sections: WingSection[] = [];
  let y = spec.le0[1];
  let z = spec.le0[2];
  let prevS = 0;
  let prevRoll = rollAt(0);

  for (const s of deviceStations(spec)) {
    const roll = rollAt(s);
    if (s > prevS) {
      // Exact displacement along a circular arc whose tangent turns from prevRoll to roll.
      const step = (s - prevS) * sinc((roll - prevRoll) / 2);
      const meanRoll = (roll + prevRoll) / 2;
      y += step * Math.cos(meanRoll);
      z += step * Math.sin(meanRoll);
    }
    const u = spec.length > 0 ? s / spec.length : 0;
    const rollProgress = Math.abs(rollSpan) > 1e-6 ? (roll - spec.roll0) / rollSpan : 0;
    sections.push({
      le: [spec.le0[0] + spec.length * tanSweep * spec.sweepProfile(u), y, z],
      chord: spec.chordRoot + (spec.chordTip - spec.chordRoot) * u,
      twist: spec.twistRoot * (1 - rollProgress) - spec.toe * Math.sin(roll),
      roll,
      airfoil: { ...spec.airfoil },
      flap: null,
      slat: false,
    });
    prevS = s;
    prevRoll = roll;
  }
  return sections;
}

const identityProfile = (u: number): number => u;
/** Raked-tip LE profile: the sweep angle grows toward the tip, so the LE reads as a curve. */
const rakedProfile = (u: number): number => Math.pow(u, 1.6);

/** Device parameters converted to radians and clamped to values that keep the geometry valid. */
interface NormalisedDevice {
  size: number;
  /** Roll (rad) of a canted surface: 90 deg - cant. */
  cantRoll: number;
  sweep: number;
  toe: number;
  /** Device tip chord as a fraction of the wing tip chord. */
  taper: number;
}

function normalise(device: TipDeviceConfig): NormalisedDevice {
  const cant = Math.min(90, Math.max(0, device.cantDeg));
  return {
    size: device.size,
    cantRoll: (90 - cant) * DEG,
    sweep: Math.min(MAX_SWEEP, Math.max(-MAX_SWEEP, device.sweepDeg * DEG)),
    toe: device.toeDeg * DEG,
    taper: Math.max(MIN_CHORD_FRACTION, device.taper),
  };
}

function makeSurface(id: string, name: string, sections: WingSection[]): LiftingSurface {
  return { id, name, side: 'right', role: 'tip-device', sections };
}

/**
 * Upper winglet that grows out of the wing tip along a smooth arc (blended / sharklet style).
 * The arc turns the roll from the wing's own roll to `90 deg - cant` with radius
 * `blendRadiusFrac * h`, then the winglet continues straight to a total length of `h`.
 */
function blendedWinglet(
  tip: WingSection,
  d: NormalisedDevice,
  h: number,
  blendRadiusFrac: number,
  id: string,
  name: string,
): LiftingSurface {
  const roll0 = tip.roll;
  const roll1 = d.cantRoll;
  const turn = Math.abs(roll1 - roll0);
  const blendLength = turn > 0.02 ? Math.min(blendRadiusFrac * h * turn, 0.8 * h) : 0;
  return makeSurface(
    id,
    name,
    buildDeviceSections({
      le0: [...tip.le] as Vec3,
      chordRoot: tip.chord,
      chordTip: d.taper * tip.chord,
      roll0,
      roll1,
      blendLength,
      blendPieces: 3,
      interiorStations: [],
      length: h,
      sweep: d.sweep,
      sweepProfile: identityProfile,
      twistRoot: tip.twist,
      toe: d.toe,
      airfoil: tip.airfoil,
    }),
  );
}

/** A straight planar fin that starts at the wing tip: the shared shape of fences and fins. */
function straightFin(
  tip: WingSection,
  d: NormalisedDevice,
  fin: {
    id: string;
    name: string;
    /** x of the fin's leading edge relative to the wing tip LE, in tip chords. */
    leOffset: number;
    chordRoot: number;
    chordTip: number;
    roll: number;
    length: number;
  },
): LiftingSurface {
  return makeSurface(
    fin.id,
    fin.name,
    buildDeviceSections({
      le0: [tip.le[0] + fin.leOffset * tip.chord, tip.le[1], tip.le[2]],
      chordRoot: fin.chordRoot,
      chordTip: fin.chordTip,
      roll0: fin.roll,
      roll1: fin.roll,
      blendLength: 0,
      blendPieces: 1,
      interiorStations: [],
      length: fin.length,
      sweep: d.sweep,
      sweepProfile: identityProfile,
      twistRoot: 0,
      toe: d.toe,
      airfoil: tip.airfoil,
    }),
  );
}

/**
 * Build the RIGHT-hand tip-device surfaces for a base wing whose right tip section is `tip`.
 * Returns an empty list for kind 'none' or a non-positive size.
 *
 * Surface ids (the caller mirrors them to `...-left`):
 *   canted-winglet  -> winglet-right
 *   blended-winglet -> winglet-right
 *   raked-tip       -> raked-tip-right
 *   split-winglet   -> winglet-right (upper), winglet-lower-right (ventral fin)
 *   wingtip-fence   -> fence-right (upper), fence-lower-right (lower)
 *
 * @param tip       right tip section of the base wing (LE, chord, twist, roll, airfoil)
 * @param device    user configuration (degrees)
 * @param semispan  base semispan (m); the device length is `device.size * semispan`
 */
export function buildTipDeviceSurfaces(
  tip: WingSection,
  device: TipDeviceConfig,
  semispan: number,
): LiftingSurface[] {
  const h = device.size * semispan;
  if (device.kind === 'none' || !Number.isFinite(h) || h <= EPS) return [];
  const d = normalise(device);
  const ct = tip.chord;

  switch (device.kind) {
    case 'canted-winglet': {
      // A separate fin, TE-aligned with the wing tip and leaning out by `cant` from vertical.
      const chordRoot = 0.9 * ct;
      return [
        straightFin(tip, d, {
          id: 'winglet-right',
          name: 'Right winglet',
          leOffset: (ct - chordRoot) / ct,
          chordRoot,
          chordTip: d.taper * ct,
          roll: d.cantRoll,
          length: h,
        }),
      ];
    }

    case 'blended-winglet':
      return [blendedWinglet(tip, d, h, 0.3, 'winglet-right', 'Right winglet')];

    case 'raked-tip': {
      // In-plane extension: the wing's own roll, exactly `h` further out in y, LE sweeping
      // progressively further back toward the tip.
      const cosRoll = Math.max(0.5, Math.cos(tip.roll));
      const length = h / cosRoll;
      return [
        makeSurface(
          'raked-tip-right',
          'Right raked tip',
          buildDeviceSections({
            le0: [...tip.le] as Vec3,
            chordRoot: ct,
            chordTip: d.taper * ct,
            roll0: tip.roll,
            roll1: tip.roll,
            blendLength: 0,
            blendPieces: 1,
            interiorStations: [0.5],
            length,
            sweep: d.sweep,
            sweepProfile: rakedProfile,
            twistRoot: tip.twist,
            toe: d.toe,
            airfoil: tip.airfoil,
          }),
        ),
      ];
    }

    case 'split-winglet': {
      const ventralRoot = 0.55 * ct;
      return [
        blendedWinglet(tip, d, h, 0.2, 'winglet-right', 'Right winglet (upper)'),
        straightFin(tip, d, {
          id: 'winglet-lower-right',
          name: 'Right winglet (lower)',
          leOffset: 0.3,
          chordRoot: ventralRoot,
          chordTip: 0.3 * ventralRoot,
          roll: -(90 - 25) * DEG,
          length: 0.4 * h,
        }),
      ];
    }

    case 'wingtip-fence': {
      // Fences straddle the tip, a little ahead of its leading edge.
      const chordRoot = 0.8 * ct;
      const chordTip = Math.min(d.taper * ct, chordRoot);
      return [
        straightFin(tip, d, {
          id: 'fence-right',
          name: 'Right fence (upper)',
          leOffset: -0.15,
          chordRoot,
          chordTip,
          roll: 90 * DEG,
          length: 0.6 * h,
        }),
        straightFin(tip, d, {
          id: 'fence-lower-right',
          name: 'Right fence (lower)',
          leOffset: -0.15,
          chordRoot,
          chordTip,
          roll: -90 * DEG,
          length: 0.4 * h,
        }),
      ];
    }
  }
}
