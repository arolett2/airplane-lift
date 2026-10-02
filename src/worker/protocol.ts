/**
 * Typed message protocol between the main thread (PhysicsClient) and the physics Web Worker.
 *
 * The client sends one `compute` request describing the full input plus the stages it wants.
 * The worker answers stage by stage, cheapest first (aero -> section -> polar -> streamlines ->
 * field), each tagged with the requestId. When a newer request arrives the worker abandons the
 * remaining stages of the older one. The worker caches the solved wing, so a request whose wing
 * and flow are unchanged (e.g. only the rake moved) skips straight to the requested stages.
 */
import type {
  AeroResult,
  FlowFieldGrid,
  PolarSweep,
  SectionFlow,
  Streamline3D,
  WingGeometry,
} from '../physics/types';
import type { FlowConditions, RakeConfig, WingConfig } from '../state/params';

export type PhysicsStage = 'aero' | 'section' | 'polar' | 'streamlines' | 'field';

export const STAGE_ORDER: readonly PhysicsStage[] = [
  'aero',
  'section',
  'polar',
  'streamlines',
  'field',
];

export interface ComputeRequest {
  type: 'compute';
  requestId: number;
  wing: WingConfig;
  flow: FlowConditions;
  rake: RakeConfig;
  /** 0..1 along the right semispan. */
  sectionEta: number;
  stages: PhysicsStage[];
  /** Flow-field grid resolution multiplier (0.5 .. 1.5) for adaptive quality. */
  fieldQuality: number;
}

/** Solve several wings at once for the comparison view (aero stage only). */
export interface CompareRequest {
  type: 'compare';
  requestId: number;
  cases: { id: string; wing: WingConfig; flow: FlowConditions }[];
}

export type PhysicsRequest = ComputeRequest | CompareRequest;

export type PhysicsResponse =
  | { type: 'aero'; requestId: number; geometry: WingGeometry; aero: AeroResult }
  | { type: 'section'; requestId: number; section: SectionFlow }
  | { type: 'polar'; requestId: number; polar: PolarSweep }
  | { type: 'streamlines'; requestId: number; streamlines: Streamline3D[] }
  | { type: 'field'; requestId: number; field: FlowFieldGrid }
  | {
      type: 'compare';
      requestId: number;
      results: { id: string; geometry: WingGeometry; aero: AeroResult }[];
    }
  | { type: 'done'; requestId: number }
  | { type: 'error'; requestId: number; stage: PhysicsStage | 'compare'; message: string };
