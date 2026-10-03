/**
 * Main-thread side of the physics worker: assigns request ids, filters stale stage responses and
 * turns 'compare' round trips into promises.
 * OWNER: integration.
 */
import type { AeroResult, WingGeometry } from '../physics/types';
import type { FlowConditions, WingConfig } from '../state/params';
import type {
  CompareRequest,
  ComputeRequest,
  FlowProbeSample,
  PhysicsResponse,
  ProbeRequest,
} from './protocol';

/** Give up on a compare request after this long (ms). */
export const COMPARE_TIMEOUT_MS = 20_000;

export interface CompareCase {
  id: string;
  wing: WingConfig;
  flow: FlowConditions;
}

export interface CompareResult {
  id: string;
  geometry: WingGeometry;
  aero: AeroResult;
}

/** Same shape as ui/panels/ComparePanel's CompareRequester (structurally compatible). */
export type CompareRequester = (cases: CompareCase[]) => Promise<CompareResult[]>;

export type ResponseListener = (msg: PhysicsResponse) => void;

interface PendingCompare {
  resolve: (results: CompareResult[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createPhysicsWorker(): Worker {
  return new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
}

export class PhysicsClient {
  private readonly worker: Worker;
  private nextRequestId = 1;
  private latestComputeId = 0;
  private disposed = false;
  private readonly listeners = new Set<ResponseListener>();
  /** Newest requestId delivered per stage (errors count toward their stage). */
  private readonly newestDelivered = new Map<string, number>();
  private readonly pendingCompares = new Map<number, PendingCompare>();
  private readonly pendingProbes = new Map<
    number,
    { resolve: (s: FlowProbeSample | null) => void; reject: (err: Error) => void }
  >();

  constructor(createWorker: () => Worker = createPhysicsWorker) {
    this.worker = createWorker();
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
  }

  /** Send a compute request; returns its requestId. Responses arrive via onResponse. */
  compute(input: Omit<ComputeRequest, 'type' | 'requestId'>): number {
    const requestId = this.nextRequestId++;
    if (this.disposed) return requestId;
    this.latestComputeId = requestId;
    // Copy only protocol fields so callers can pass larger objects without cloning them.
    const req: ComputeRequest = {
      type: 'compute',
      requestId,
      wing: input.wing,
      flow: input.flow,
      rake: input.rake,
      sectionEta: input.sectionEta,
      stages: input.stages,
      fieldQuality: input.fieldQuality,
    };
    this.worker.postMessage(req);
    return requestId;
  }

  /**
   * Subscribe to stage responses ('aero', 'section', ..., 'done', 'error'). Responses older than
   * the newest already delivered for the same stage are dropped. Returns an unsubscribe function.
   */
  onResponse(listener: ResponseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Solve several wings for the comparison view. Rejects on worker error or after 20 s. */
  compare: CompareRequester = (cases) =>
    new Promise<CompareResult[]>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('PhysicsClient has been disposed'));
        return;
      }
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pendingCompares.delete(requestId);
        reject(new Error(`Comparison timed out after ${COMPARE_TIMEOUT_MS / 1000} s`));
      }, COMPARE_TIMEOUT_MS);
      this.pendingCompares.set(requestId, { resolve, reject, timer });
      const req: CompareRequest = { type: 'compare', requestId, cases };
      try {
        this.worker.postMessage(req);
      } catch (err) {
        this.settleCompare(requestId, err instanceof Error ? err : new Error(String(err)));
      }
    });

  /**
   * Evaluate the exact 3D flow at a tunnel-frame point around the latest solved wing (the 3D
   * probe). Resolves with null before the first solve; rejects on a worker error.
   */
  probe(point: [number, number, number]): Promise<FlowProbeSample | null> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('PhysicsClient has been disposed'));
        return;
      }
      const requestId = this.nextRequestId++;
      this.pendingProbes.set(requestId, { resolve, reject });
      const req: ProbeRequest = { type: 'probe', requestId, point: [point[0], point[1], point[2]] };
      try {
        this.worker.postMessage(req);
      } catch (err) {
        this.pendingProbes.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    this.worker.terminate();
    this.rejectAllCompares(new Error('PhysicsClient has been disposed'));
    this.rejectAllProbes(new Error('PhysicsClient has been disposed'));
    this.listeners.clear();
  }

  private readonly handleMessage = (event: MessageEvent<PhysicsResponse>): void => {
    this.route(event.data);
  };

  private readonly handleWorkerError = (event: Event): void => {
    const message = (event as Partial<ErrorEvent>).message || 'The physics worker crashed';
    this.failEverything(message);
  };

  private readonly handleMessageError = (): void => {
    this.failEverything('A physics result could not be received');
  };

  private route(msg: PhysicsResponse): void {
    if (this.disposed) return;
    if (msg.type === 'compare') {
      this.settleCompare(msg.requestId, msg.results);
      return;
    }
    if (msg.type === 'error' && msg.stage === 'compare') {
      this.settleCompare(msg.requestId, new Error(msg.message));
      return;
    }
    if (msg.type === 'probe' || (msg.type === 'error' && msg.stage === 'probe')) {
      const pending = this.pendingProbes.get(msg.requestId);
      if (!pending) return;
      this.pendingProbes.delete(msg.requestId);
      if (msg.type === 'probe') pending.resolve(msg.sample);
      else pending.reject(new Error(msg.message));
      return;
    }
    const stage = msg.type === 'error' ? msg.stage : msg.type;
    const newest = this.newestDelivered.get(stage);
    if (newest !== undefined && msg.requestId < newest) return;
    this.newestDelivered.set(stage, msg.requestId);
    this.emit(msg);
  }

  private emit(msg: PhysicsResponse): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(msg);
      } catch (err) {
        console.error('PhysicsClient listener failed:', err);
      }
    }
  }

  private settleCompare(requestId: number, outcome: CompareResult[] | Error): void {
    const pending = this.pendingCompares.get(requestId);
    if (!pending) return;
    this.pendingCompares.delete(requestId);
    clearTimeout(pending.timer);
    if (outcome instanceof Error) pending.reject(outcome);
    else pending.resolve(outcome);
  }

  private rejectAllCompares(err: Error): void {
    for (const id of [...this.pendingCompares.keys()]) this.settleCompare(id, err);
  }

  private rejectAllProbes(err: Error): void {
    const all = [...this.pendingProbes.values()];
    this.pendingProbes.clear();
    for (const p of all) p.reject(err);
  }

  /** A worker-level failure: fail pending compares and report it against the latest compute. */
  private failEverything(message: string): void {
    if (this.disposed) return;
    this.rejectAllCompares(new Error(message));
    this.rejectAllProbes(new Error(message));
    if (this.latestComputeId > 0) {
      this.emit({ type: 'error', requestId: this.latestComputeId, stage: 'aero', message });
    }
  }
}
