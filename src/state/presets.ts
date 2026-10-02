/**
 * Aircraft wing presets. Values are approximate public figures, chosen so the wind tunnel
 * reproduces each aircraft's planform, reference area and typical flight conditions.
 * Sources for every number live in docs/AIRCRAFT_DATA.md.
 *
 * OWNER: content agent. Contract only — the list is filled in by that agent.
 */
import type { FlowConditions, WingConfig } from './params';
import { DEFAULT_FLOW, DEFAULT_WING } from './params';

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
    maxTakeoffMassKg: 1000,
    typicalCruiseMassKg: 900,
    facts: [],
  },
];

export function getPreset(id: string): AircraftPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
