/**
 * Guided-lesson content model. Lessons drive the same AppState the user controls, so every
 * lesson step is "set up the tunnel like this, then look at that".
 */
import type {
  AppState,
  CameraShot,
  FlowConditions,
  ViewSettings,
  WingConfig,
} from '../state/params';
import type { DeepPartial } from '../state/store';

export interface LessonStep {
  id: string;
  title: string;
  /** Short HTML (paragraphs, <strong>, <em>, lists). Plain language for a curious adult. */
  body: string;
  /** What to try with the controls on this step. */
  tryIt?: string;
  /** State changes applied when the step opens. `preset` loads first, then the patches. */
  apply?: {
    preset?: string;
    wing?: DeepPartial<WingConfig>;
    flow?: Partial<FlowConditions>;
    view?: DeepPartial<ViewSettings>;
    /** Open the side-by-side comparison of two preset ids, or close it with null. */
    compare?: [string, string] | null;
  };
  camera?: CameraShot;
  /** ParamSpec paths to highlight in the controls panel. */
  highlight?: string[];
}

export interface Lesson {
  id: string;
  title: string;
  /** One-line teaser for the lesson picker. */
  summary: string;
  /** Rough minutes to complete. */
  minutes: number;
  steps: LessonStep[];
}

export interface GlossaryEntry {
  term: string;
  /** One or two sentences. */
  definition: string;
}

/** Applies a lesson step to app state (pure; used by the lesson panel and tests). */
export type ApplyStep = (state: AppState, step: LessonStep) => AppState;
