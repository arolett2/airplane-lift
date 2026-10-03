/**
 * Physics Web Worker (module worker). Runs the solvers off the main thread and streams results
 * back stage by stage, cheapest first (see protocol.ts).
 * OWNER: integration.
 *
 * The message handling is the pure, testable `handleRequest`; the `self.onmessage` glue at the
 * bottom only runs inside a real worker.
 */
import type { AeroResult, Streamline3D, WingGeometry } from '../physics/types';
import type { AeroCache } from '../physics/aero';
import type {
  CompareRequest,
  ComputeRequest,
  PhysicsRequest,
  PhysicsResponse,
  PhysicsStage,
} from './protocol';
import { STAGE_ORDER } from './protocol';
import {
  computeAero,
  computePolarSweep,
  computeSection,
  createAeroCache,
  stableKey,
} from '../physics/aero';
import { buildFlowFieldGrid, seedStreamlines, traceStreamlines } from '../physics/flow/index';
import { domainForGeometry } from '../physics/domain';

/** Flow-field grid node budget at fieldQuality = 1 (the flow module's default). */
export const DEFAULT_FIELD_NODES = 120_000;

/**
 * Time budget per stage (ms). A slower stage makes the tunnel lag behind a dragged slider, so it
 * is reported with console.warn (all stages also report their time in the 'done' message).
 */
export const STAGE_BUDGET_MS = 600;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Posts one response; `transfer` lists ArrayBuffers the worker gives away (zero-copy). */
export type PostFn = (msg: PhysicsResponse, transfer?: Transferable[]) => void;

/** True once a newer compute request has arrived, so the current one should stop. */
export type IsStaleFn = () => boolean;

/** What the worker keeps between requests. */
export interface WorkerState {
  /** Memoised geometry / VLM models / solves for the live wing. */
  cache: AeroCache;
  /** Separate cache for the compare view so comparing presets never evicts the live wing. */
  compareCache: AeroCache;
  /** Last solved live state; reused when wing and flow are unchanged (e.g. only the rake moved). */
  last: { key: string; geometry: WingGeometry; aero: AeroResult } | null;
}

export function createWorkerState(): WorkerState {
  return { cache: createAeroCache(), compareCache: createAeroCache(), last: null };
}

/**
 * Grid node budget for a quality multiplier. Scales the node COUNT linearly (not per axis): the
 * Biot-Savart cost is proportional to the node count, and this keeps the slowest setting ~2x.
 */
export function fieldTargetNodes(fieldQuality: number): number {
  const q = Number.isFinite(fieldQuality) ? Math.min(2, Math.max(0.1, fieldQuality)) : 1;
  return Math.round(DEFAULT_FIELD_NODES * q);
}

/** Distinct transferable ArrayBuffers behind a set of typed arrays. */
export function transferablesOf(arrays: Iterable<ArrayBufferView>): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const a of arrays) {
    if (a.buffer instanceof ArrayBuffer && a.buffer.byteLength > 0) buffers.add(a.buffer);
  }
  return [...buffers];
}

function streamlineArrays(lines: Streamline3D[]): ArrayBufferView[] {
  const out: ArrayBufferView[] = [];
  for (const l of lines) out.push(l.points, l.speed, l.time);
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let defaultState: WorkerState | null = null;

/**
 * Handle one request. For 'compute', runs the requested stages in STAGE_ORDER, posting each
 * result as soon as it is ready and yielding to the event loop between stages; abandons the
 * request (no 'done') once `isStale()` turns true. A failing stage posts 'error' and the rest
 * continue; 'done' ends a completed request. For 'compare', solves every case and replies once.
 */
export async function handleRequest(
  req: PhysicsRequest,
  post: PostFn,
  isStale: IsStaleFn,
  state: WorkerState = (defaultState ??= createWorkerState()),
): Promise<void> {
  if (req.type === 'compare') {
    handleCompare(req, post, state);
    return;
  }
  await handleCompute(req, post, isStale, state);
}

function handleCompare(req: CompareRequest, post: PostFn, state: WorkerState): void {
  try {
    const results = req.cases.map((c) => {
      const { geometry, aero } = computeAero(c.wing, c.flow, req.requestId, state.compareCache);
      return { id: c.id, geometry, aero };
    });
    post({ type: 'compare', requestId: req.requestId, results });
  } catch (err) {
    post({ type: 'error', requestId: req.requestId, stage: 'compare', message: errorMessage(err) });
  }
}

async function handleCompute(
  req: ComputeRequest,
  post: PostFn,
  isStale: IsStaleFn,
  state: WorkerState,
): Promise<void> {
  const { requestId } = req;
  const wanted = new Set<PhysicsStage>(req.stages);
  const stages = STAGE_ORDER.filter((s) => wanted.has(s));

  // The 3D solve is shared by aero, streamlines and field; computed at most once per request.
  let solved: { geometry: WingGeometry; aero: AeroResult } | null = null;
  const ensureSolved = (): { geometry: WingGeometry; aero: AeroResult } => {
    if (solved) return solved;
    const key = `${stableKey(req.wing)}|${stableKey(req.flow)}`;
    const last = state.last;
    if (last && last.key === key) {
      const aero =
        last.aero.requestId === requestId ? last.aero : { ...last.aero, requestId: requestId };
      solved = { geometry: last.geometry, aero };
    } else {
      const result = computeAero(req.wing, req.flow, requestId, state.cache);
      state.last = { key, geometry: result.geometry, aero: result.aero };
      solved = result;
    }
    return solved;
  };

  const timingsMs: Partial<Record<PhysicsStage, number>> = {};
  for (let k = 0; k < stages.length; k++) {
    const stage = stages[k]!;
    // Yield before every stage (including the first) so requests queued behind this one get
    // dispatched and this one can be abandoned without doing any work.
    await yieldToEventLoop();
    if (isStale()) return;
    const t0 = now();
    try {
      runStage(stage, req, post, state, ensureSolved);
    } catch (err) {
      post({ type: 'error', requestId, stage, message: errorMessage(err) });
    }
    const ms = now() - t0;
    timingsMs[stage] = ms;
    if (ms > STAGE_BUDGET_MS) {
      console.warn(`physics worker: stage "${stage}" took ${Math.round(ms)} ms`);
    }
  }
  if (isStale()) return;
  post({ type: 'done', requestId, timingsMs });
}

function runStage(
  stage: PhysicsStage,
  req: ComputeRequest,
  post: PostFn,
  state: WorkerState,
  ensureSolved: () => { geometry: WingGeometry; aero: AeroResult },
): void {
  const { requestId } = req;
  switch (stage) {
    case 'aero': {
      // Structured-cloned: the worker keeps this result for reuse.
      const { geometry, aero } = ensureSolved();
      post({ type: 'aero', requestId, geometry, aero });
      return;
    }
    case 'section': {
      const section = computeSection(req.wing, req.flow, req.sectionEta, state.cache);
      post({ type: 'section', requestId, section });
      return;
    }
    case 'polar': {
      const polar = computePolarSweep(req.wing, req.flow, requestId, state.cache);
      post({ type: 'polar', requestId, polar });
      return;
    }
    case 'streamlines': {
      const { geometry, aero } = ensureSolved();
      const domain = domainForGeometry(geometry);
      const seeds = seedStreamlines(geometry, aero.alpha, req.rake, domain);
      const streamlines = traceStreamlines(
        aero.lattice,
        aero.velocity,
        seeds,
        domain,
        geometry,
        aero.alpha,
      );
      post(
        { type: 'streamlines', requestId, streamlines },
        transferablesOf(streamlineArrays(streamlines)),
      );
      return;
    }
    case 'field': {
      const { geometry, aero } = ensureSolved();
      const domain = domainForGeometry(geometry);
      const field = buildFlowFieldGrid(
        aero.lattice,
        aero.velocity,
        geometry,
        aero.alpha,
        { domain, targetNodes: fieldTargetNodes(req.fieldQuality) },
        requestId,
      );
      post({ type: 'field', requestId, field }, transferablesOf([field.velocity, field.solid]));
      return;
    }
  }
}

/**
 * Message dispatcher with stale tracking: a compute request becomes stale as soon as a compute
 * request with a higher id arrives. Returned promise settles when the request is finished.
 */
export function createMessageHandler(
  post: PostFn,
  state: WorkerState = createWorkerState(),
): (req: PhysicsRequest) => Promise<void> {
  let newestCompute = -Infinity;
  return (req) => {
    if (req.type === 'compute') newestCompute = Math.max(newestCompute, req.requestId);
    const isStale: IsStaleFn =
      req.type === 'compute' ? () => req.requestId < newestCompute : () => false;
    return handleRequest(req, post, isStale, state);
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Worker glue (only inside a real DedicatedWorkerGlobalScope)                                 */
/* ------------------------------------------------------------------------------------------ */

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
  const handle = createMessageHandler((msg, transfer) => scope.postMessage(msg, transfer ?? []));
  scope.onmessage = (event: MessageEvent<PhysicsRequest>) => {
    handle(event.data).catch((err: unknown) => console.error('physics worker:', err));
  };
}
