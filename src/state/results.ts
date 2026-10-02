/**
 * Latest physics outputs received from the worker. Each field may lag the AppState while a
 * computation is in flight; `pending` lists the stages still being computed.
 */
import type {
  AeroResult,
  FlowFieldGrid,
  PolarSweep,
  SectionFlow,
  Streamline3D,
  WingGeometry,
} from '../physics/types';
import type { PhysicsStage } from '../worker/protocol';

export interface ResultsState {
  geometry: WingGeometry | null;
  aero: AeroResult | null;
  section: SectionFlow | null;
  polar: PolarSweep | null;
  streamlines: Streamline3D[] | null;
  field: FlowFieldGrid | null;
  pending: PhysicsStage[];
  error: string | null;
}

export const EMPTY_RESULTS: ResultsState = {
  geometry: null,
  aero: null,
  section: null,
  polar: null,
  streamlines: null,
  field: null,
  pending: [],
  error: null,
};
