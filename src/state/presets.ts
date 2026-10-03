/**
 * Aircraft wing presets. Values are approximate public figures, chosen so the wind tunnel
 * reproduces each aircraft's planform, reference area and typical flight conditions.
 * Sources for every number live in docs/AIRCRAFT_DATA.md, which also says which values are
 * published and which are engineering estimates (taper, yehudi, washout, airfoil stand-ins,
 * cruise angle of attack).
 *
 * OWNER: content agent.
 *
 * How the numbers were derived (see docs/AIRCRAFT_DATA.md for the full table):
 *  - `span` is the BASE wing span. With winglets it is the published overall span minus the
 *    sideways reach of the winglets (2 * height * sin(cant)); with raked tips it is the published
 *    span divided by (1 + size), because the rake adds in-plane span.
 *  - `rootChord` comes from the published reference area S, so that the base planform
 *    (reference trapezoid + inboard trailing-edge extension) plus any raked tip has area S:
 *        S_base = c_r * b / 2 * [(1 + taper) + yehudi.spanFrac * yehudi.chordFrac]
 *  - cruise `airspeed` = Mach * speed of sound (ISA); `alphaDeg` is the root angle (0.1 deg steps)
 *    at which the app's own solver (computeAero) makes lift equal to the typical cruise weight.
 *    src/physics/presets.e2e.test.ts keeps it within 3 % and checks the Mach margins and the
 *    maximum lift (clean, flaps + slats, and at cruise Mach).
 */
import type {
  AppState,
  FlowConditions,
  TipDeviceConfig,
  TipDeviceKind,
  WingConfig,
} from './params';
import { DEFAULT_FLOW, DEFAULT_WING, TIP_DEVICE_DEFAULTS } from './params';

export type PresetCategory = 'airliner' | 'general-aviation' | 'glider' | 'fighter' | 'teaching';

export interface AircraftPreset {
  id: string;
  /** e.g. "Boeing 747-400" */
  name: string;
  /** e.g. "747-400" for tight UI spots. */
  shortName: string;
  category: PresetCategory;
  /** One or two plain-language sentences about this wing. */
  blurb: string;
  wing: WingConfig;
  /** Typical cruise (alpha chosen so lift is about equal to a mid-mission weight). */
  cruise: FlowConditions;
  /** Typical final approach (flaps usually deployed separately by the lesson/user). */
  approach: FlowConditions;
  /** Maximum take-off mass (kg), for the "can this wing hold the aircraft up?" gauge. */
  maxTakeoffMassKg: number;
  /** Typical mid-cruise mass (kg). */
  typicalCruiseMassKg: number;
  /** Short fun facts shown in the compare view. */
  facts: string[];
}

/** Tip device of a given kind: the shared default shape with per-aircraft overrides. */
function tipDevice(kind: TipDeviceKind, overrides: Partial<TipDeviceConfig> = {}): TipDeviceConfig {
  return { ...TIP_DEVICE_DEFAULTS[kind], ...overrides };
}

/** Airliner flaps (retracted): deep Fowler-type flaps over the inboard ~60 % of the wing. */
function airlinerFlaps(chordFrac = 0.3, spanFrac = 0.62): WingConfig['flaps'] {
  return { deflectionDeg: 0, chordFrac, spanFrac };
}

export const PRESETS: readonly AircraftPreset[] = [
  {
    id: 'demo-rect',
    name: 'Simple rectangular wing',
    shortName: 'Demo wing',
    category: 'teaching',
    blurb: 'A plain, straight, untwisted wing: the easiest shape for seeing how lift works.',
    wing: DEFAULT_WING,
    cruise: DEFAULT_FLOW,
    approach: { alphaDeg: 8, airspeed: 35, altitude: 0 },
    // Sized so the default flight (60 m/s, 5 deg, sea level) holds it up: ~100% of weight.
    maxTakeoffMassKg: 2000,
    typicalCruiseMassKg: 1860,
    facts: [
      'Real wings are tapered and swept. This one is a plain rectangle so you can see the basic physics without any extras.',
      'Its section is a NACA 2412: 2% camber and 12% thickness, a classic light-aircraft profile.',
    ],
  },
  {
    id: 'b747-400',
    name: 'Boeing 747-400',
    shortName: '747-400',
    category: 'airliner',
    blurb:
      'The classic jumbo jet: a big wing swept back 37.5 degrees, finished with small canted winglets at the tips.',
    wing: {
      span: 62.7,
      rootChord: 11.7,
      taperRatio: 0.28,
      sweepDeg: 37.5,
      dihedralDeg: 7,
      rootIncidenceDeg: 0,
      washoutDeg: 3,
      yehudi: { spanFrac: 0.33, chordFrac: 0.45 },
      airfoil: { camber: 0.021, camberPos: 0.5, thickness: 0.1 },
      supercritical: false,
      tipDevice: tipDevice('canted-winglet', { size: 0.058, cantDeg: 29 }),
      flaps: airlinerFlaps(0.3, 0.65),
      slats: false,
    },
    cruise: { alphaDeg: 3.8, airspeed: 252, altitude: 10668 },
    approach: { alphaDeg: 7.5, airspeed: 80, altitude: 0 },
    maxTakeoffMassKg: 396890,
    typicalCruiseMassKg: 337000,
    facts: [
      'The wing covers 525 square metres, more than a basketball court. In cruise each square metre holds up about 640 kg.',
      'Sweeping the wing back 37.5 degrees lets it cruise at Mach 0.85, about 900 km/h, before the shock waves over the wing grow strong enough to make drag soar.',
      'The 1.8 m winglets were new on the -400. They weaken the swirl of air that spills around each wingtip.',
    ],
  },
  {
    id: 'b747-8',
    name: 'Boeing 747-8',
    shortName: '747-8',
    category: 'airliner',
    blurb:
      'The stretched jumbo: a thicker, redesigned wing with long raked tips instead of winglets, a shape borrowed from the 777 and 787.',
    wing: {
      span: 64.2,
      rootChord: 12,
      taperRatio: 0.27,
      sweepDeg: 37.5,
      dihedralDeg: 7,
      rootIncidenceDeg: 0,
      washoutDeg: 3,
      yehudi: { spanFrac: 0.33, chordFrac: 0.45 },
      airfoil: { camber: 0.022, camberPos: 0.5, thickness: 0.11 },
      supercritical: true,
      tipDevice: tipDevice('raked-tip', { size: 0.065 }),
      flaps: airlinerFlaps(0.3, 0.65),
      slats: false,
    },
    cruise: { alphaDeg: 3.8, airspeed: 253.5, altitude: 10668 },
    approach: { alphaDeg: 7, airspeed: 78, altitude: 0 },
    maxTakeoffMassKg: 442250,
    typicalCruiseMassKg: 376000,
    facts: [
      'The wing is 554 square metres, about 5 percent bigger than the 747-400 wing, and the span grows to 68.4 m.',
      'A raked tip is extra wing that sweeps back sharply. It stretches the span, which cuts drag from the tip vortex, without any vertical fin.',
      'At 76.3 m it is the longest passenger airliner flying. Its wing has to hold up to about 442 tonnes.',
    ],
  },
  {
    id: 'b737-800',
    name: 'Boeing 737-800',
    shortName: '737-800',
    category: 'airliner',
    blurb:
      'The workhorse of short and medium routes: a moderately swept wing (25 degrees) with 2.4 m blended winglets.',
    wing: {
      span: 34.4,
      rootChord: 5.2,
      taperRatio: 0.28,
      sweepDeg: 25,
      dihedralDeg: 6,
      rootIncidenceDeg: 0,
      washoutDeg: 3,
      yehudi: { spanFrac: 0.33, chordFrac: 0.35 },
      airfoil: { camber: 0.018, camberPos: 0.45, thickness: 0.11 },
      supercritical: false,
      tipDevice: tipDevice('blended-winglet', { size: 0.14, cantDeg: 17 }),
      flaps: airlinerFlaps(0.3, 0.6),
      slats: false,
    },
    cruise: { alphaDeg: 3.2, airspeed: 233.8, altitude: 10363 },
    approach: { alphaDeg: 7, airspeed: 72, altitude: 0 },
    maxTakeoffMassKg: 79016,
    typicalCruiseMassKg: 65000,
    facts: [
      'The wing is just 124.6 square metres, yet it can lift up to 79 tonnes at take-off.',
      'A blended winglet curves smoothly out of the wing tip. The 747-400 winglet meets the wing at a sharp corner instead.',
      'It cruises at about Mach 0.785, roughly 840 km/h, at around 10 to 11 km altitude.',
    ],
  },
  {
    id: 'b737-max8',
    name: 'Boeing 737 MAX 8',
    shortName: '737 MAX 8',
    category: 'airliner',
    blurb:
      'Almost the same wing as the 737-800, but with split "Advanced Technology" winglets: a tall upper blade and a smaller fin pointing down.',
    wing: {
      span: 34.4,
      rootChord: 5.15,
      taperRatio: 0.28,
      sweepDeg: 25,
      dihedralDeg: 6,
      rootIncidenceDeg: 0,
      washoutDeg: 3,
      yehudi: { spanFrac: 0.33, chordFrac: 0.35 },
      airfoil: { camber: 0.018, camberPos: 0.45, thickness: 0.11 },
      supercritical: false,
      tipDevice: tipDevice('split-winglet', { size: 0.14, cantDeg: 19 }),
      flaps: airlinerFlaps(0.3, 0.6),
      slats: false,
    },
    cruise: { alphaDeg: 3.2, airspeed: 234.9, altitude: 10058 },
    approach: { alphaDeg: 7, airspeed: 72, altitude: 0 },
    maxTakeoffMassKg: 82191,
    typicalCruiseMassKg: 67500,
    facts: [
      'The split winglet is about 2.9 m tall in total. Boeing credits it with roughly 1 to 1.5 percent less fuel burn.',
      'The winglet was sized to keep the span under 36 m, so the MAX still fits the same airport gates as the 737-800.',
      'The small downward fin works the air below the tip, as well as the upper blade working the air above it.',
    ],
  },
  {
    id: 'b787-9',
    name: 'Boeing 787-9 Dreamliner',
    shortName: '787-9',
    category: 'airliner',
    blurb:
      'A long, slender carbon-fibre wing swept 32 degrees, finished with raked tips. It bends upward noticeably in flight.',
    wing: {
      span: 56.7,
      rootChord: 9.7,
      taperRatio: 0.22,
      sweepDeg: 32.2,
      dihedralDeg: 5,
      rootIncidenceDeg: 0,
      washoutDeg: 3.5,
      yehudi: { spanFrac: 0.33, chordFrac: 0.4 },
      airfoil: { camber: 0.022, camberPos: 0.5, thickness: 0.105 },
      supercritical: true,
      tipDevice: tipDevice('raked-tip', { size: 0.06 }),
      flaps: airlinerFlaps(0.3, 0.65),
      slats: false,
    },
    cruise: { alphaDeg: 3.8, airspeed: 250.8, altitude: 11900 },
    approach: { alphaDeg: 7, airspeed: 74, altitude: 0 },
    maxTakeoffMassKg: 254011,
    typicalCruiseMassKg: 216000,
    facts: [
      'With an aspect ratio of about 9.6 the wing is long and narrow, much more so than the 747 at about 7.9.',
      'The wing is made of carbon-fibre composite, which is light and strong enough to flex upward a lot in flight.',
      'It cruises at Mach 0.85, around 39,000 ft, at which height the air is only a quarter as dense as at sea level.',
    ],
  },
  {
    id: 'a320neo',
    name: 'Airbus A320neo',
    shortName: 'A320neo',
    category: 'airliner',
    blurb:
      'Airbus\'s best-selling single-aisle jet. Its "sharklet" winglets, a blended-winglet design, come as standard.',
    wing: {
      span: 34.4,
      rootChord: 5.2,
      taperRatio: 0.25,
      sweepDeg: 25,
      dihedralDeg: 5,
      rootIncidenceDeg: 0,
      washoutDeg: 3,
      yehudi: { spanFrac: 0.35, chordFrac: 0.35 },
      airfoil: { camber: 0.018, camberPos: 0.45, thickness: 0.108 },
      supercritical: true,
      tipDevice: tipDevice('blended-winglet', { size: 0.14, cantDeg: 17 }),
      flaps: airlinerFlaps(0.3, 0.62),
      slats: false,
    },
    cruise: { alphaDeg: 3.9, airspeed: 230.2, altitude: 11000 },
    approach: { alphaDeg: 7, airspeed: 70, altitude: 0 },
    maxTakeoffMassKg: 79000,
    typicalCruiseMassKg: 67000,
    facts: [
      'Sharklets are about 2.4 m tall. Airbus quotes up to 3.5 percent less fuel on flights longer than 2,800 km.',
      'They add about 1.7 m to the span, which reaches 35.8 m, just inside the 36 m limit of a standard airport gate.',
      'The sharklets add about 200 kg of weight, yet the drag they save more than pays for it.',
    ],
  },
  {
    id: 'a380-800',
    name: 'Airbus A380-800',
    shortName: 'A380',
    category: 'airliner',
    blurb:
      'The largest airliner: an 845 m² wing spanning nearly 80 m, the widest allowed at most big airports, with wingtip fences.',
    wing: {
      span: 79.75,
      rootChord: 15.6,
      taperRatio: 0.22,
      sweepDeg: 33.5,
      dihedralDeg: 5.5,
      rootIncidenceDeg: 0,
      washoutDeg: 3.5,
      yehudi: { spanFrac: 0.35, chordFrac: 0.4 },
      airfoil: { camber: 0.019, camberPos: 0.5, thickness: 0.112 },
      supercritical: true,
      tipDevice: tipDevice('wingtip-fence'),
      flaps: airlinerFlaps(0.3, 0.65),
      slats: false,
    },
    cruise: { alphaDeg: 3.7, airspeed: 250.8, altitude: 11000 },
    approach: { alphaDeg: 7, airspeed: 72, altitude: 0 },
    maxTakeoffMassKg: 575000,
    typicalCruiseMassKg: 489000,
    facts: [
      'The wing area is 845 square metres. At take-off the wing flexes upward by more than 4 m.',
      'The 80 m airport limit forces a stubbier wing (aspect ratio about 7.5) than designers would choose for pure efficiency.',
      'The tip fences stick out above and below the tip, to break up the swirl as the air spills round the end of the wing.',
    ],
  },
  {
    id: 'cessna-172',
    name: 'Cessna 172 Skyhawk',
    shortName: 'Cessna 172',
    category: 'general-aviation',
    blurb:
      'The most common light aeroplane: a simple, straight wing with a classic NACA 2412 section. The support strut is not modelled.',
    wing: {
      span: 11,
      rootChord: 1.7,
      taperRatio: 0.72,
      sweepDeg: 0,
      dihedralDeg: 1.7,
      rootIncidenceDeg: 0,
      washoutDeg: 2,
      yehudi: { spanFrac: 0, chordFrac: 0 },
      airfoil: { camber: 0.02, camberPos: 0.4, thickness: 0.12 },
      supercritical: false,
      tipDevice: tipDevice('none'),
      flaps: { deflectionDeg: 0, chordFrac: 0.3, spanFrac: 0.5 },
      slats: false,
    },
    cruise: { alphaDeg: 2.7, airspeed: 62, altitude: 2438 },
    approach: { alphaDeg: 8, airspeed: 33, altitude: 0 },
    maxTakeoffMassKg: 1157,
    typicalCruiseMassKg: 1000,
    facts: [
      'More than 44,000 have been built, more than any other aircraft.',
      'At full weight the wing carries about 71 kg per square metre, roughly a tenth of a 747-400 at its maximum weight.',
      'With full flaps its stall speed is only about 47 knots (87 km/h).',
    ],
  },
  {
    id: 'glider-18m',
    name: '18 m racing glider (ASG 29)',
    shortName: 'Glider 18 m',
    category: 'glider',
    blurb:
      'A sailplane with a very long, very narrow wing: aspect ratio about 31. It glides 50 m forward for every metre of height lost.',
    wing: {
      span: 18,
      rootChord: 0.88,
      taperRatio: 0.33,
      sweepDeg: 0,
      dihedralDeg: 3,
      rootIncidenceDeg: 0,
      washoutDeg: 2,
      yehudi: { spanFrac: 0, chordFrac: 0 },
      airfoil: { camber: 0.018, camberPos: 0.5, thickness: 0.12 },
      supercritical: false,
      tipDevice: tipDevice('none'),
      flaps: { deflectionDeg: 0, chordFrac: 0.25, spanFrac: 0.55 },
      slats: false,
    },
    cruise: { alphaDeg: 4.7, airspeed: 36, altitude: 1500 },
    approach: { alphaDeg: 7, airspeed: 28, altitude: 0 },
    maxTakeoffMassKg: 600,
    typicalCruiseMassKg: 450,
    facts: [
      'From 1 km up, it can glide about 50 km in still air.',
      'The aspect ratio is about 31, roughly three times a 737 wing. That makes very weak wingtip vortices for the lift it creates.',
      'Pilots add up to about 200 kg of water ballast for racing. The extra weight makes it faster between thermals.',
    ],
  },
  {
    id: 'f16',
    name: 'General Dynamics F-16 Fighting Falcon',
    shortName: 'F-16',
    category: 'fighter',
    blurb:
      'A short, thin, swept wing built for speed and agility: aspect ratio of only 3.2 and a section just 4 percent thick.',
    wing: {
      span: 9.45,
      rootChord: 4.8,
      taperRatio: 0.227,
      sweepDeg: 32.7,
      dihedralDeg: 0,
      rootIncidenceDeg: 0,
      washoutDeg: 0,
      yehudi: { spanFrac: 0, chordFrac: 0 },
      airfoil: { camber: 0.004, camberPos: 0.5, thickness: 0.04 },
      supercritical: false,
      tipDevice: tipDevice('none'),
      flaps: { deflectionDeg: 0, chordFrac: 0.25, spanFrac: 0.7 },
      slats: false,
    },
    cruise: { alphaDeg: 3.4, airspeed: 258, altitude: 9000 },
    approach: { alphaDeg: 12, airspeed: 77, altitude: 0 },
    maxTakeoffMassKg: 19190,
    typicalCruiseMassKg: 12000,
    facts: [
      'The wing section is NACA 64A204, just 4 percent thick. By comparison, an airliner section is 10 to 12 percent.',
      'The leading edge is swept 40 degrees. Fuselage strakes ahead of the wing create vortices that keep air attached at high angles.',
      'Its wing is only 28 m² for up to 19 tonnes: about 690 kg per m² at maximum weight, against about 57 for the glider.',
    ],
  },
];

export function getPreset(id: string): AircraftPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/**
 * Load a preset's wing and one of its flight conditions into the app state.
 * Unknown ids leave the state unchanged.
 */
export function applyPreset(
  state: AppState,
  presetId: string,
  conditions: 'cruise' | 'approach' = 'cruise',
): AppState {
  const preset = getPreset(presetId);
  if (!preset) return state;
  return { ...state, presetId, wing: preset.wing, flow: preset[conditions] };
}
