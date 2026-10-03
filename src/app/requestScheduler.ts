/**
 * Decides which physics stages to ask the worker for, and when, so that every result on screen
 * ends up matching the current inputs.
 * OWNER: integration.
 *
 * A stage is *owed* from the moment an input it depends on changes until a result (or an error)
 * for it arrives from a request sent after that change. Results from older requests may still be
 * shown, but they do not settle the debt. Cheap stages go out on the next animation frame;
 * expensive ones wait until the inputs have been quiet for `idleDelayMs`.
 *
 * The worker abandons the remaining stages of an older request as soon as a newer one arrives,
 * so only the newest request counts as in flight: every request carries all the owed cheap
 * stages, and owed expensive stages left out of one are sent again once things are quiet.
 * `pending` lists the owed stages the newest request is computing.
 */
import { STAGE_ORDER, type PhysicsStage } from '../worker/protocol';

/** Stages too slow to run while a slider is being dragged. */
export const IDLE_STAGES: readonly PhysicsStage[] = ['polar', 'field'];

export interface SchedulerHooks {
  /** Post a compute request for these stages (in STAGE_ORDER) with the current inputs; returns its id. */
  send(stages: PhysicsStage[]): number;
  /** Whether a stage may be computed now (e.g. the particle field only while particles show). */
  eligible(stage: PhysicsStage): boolean;
  /** The pending list changed. */
  onPending(pending: PhysicsStage[]): void;
  requestFrame(callback: () => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  idleDelayMs: number;
}

interface Debt {
  /** Only a request with a larger id was sent with the inputs that made this stage owed. */
  after: number;
  /** Carried by the newest request (which cancelled what older ones had left to do). */
  inFlight: boolean;
}

const isIdle = (s: PhysicsStage): boolean => IDLE_STAGES.includes(s);

export class RequestScheduler {
  private readonly owed = new Map<PhysicsStage, Debt>();
  private lastSentId = 0;
  private frameQueued = false;
  private idleTimer: unknown = undefined;
  private pending: PhysicsStage[] = [];
  private disposed = false;

  constructor(private readonly hooks: SchedulerHooks) {}

  /** Inputs these stages depend on have changed: their current results are out of date. */
  invalidate(stages: readonly PhysicsStage[]): void {
    if (this.disposed || stages.length === 0) return;
    for (const s of stages) this.owed.set(s, { after: this.lastSentId, inFlight: false });
    if (stages.some((s) => !isIdle(s))) this.queueFrame();
    if (stages.some(isIdle)) this.armIdle();
    this.publish();
  }

  /** Eligibility changed (e.g. particles turned on): send owed stages that may now be computed. */
  refresh(): void {
    if (this.disposed) return;
    const waiting = this.owedStages((_s, d) => !d.inFlight);
    if (waiting.some((s) => !isIdle(s))) this.queueFrame();
    if (waiting.some(isIdle)) this.armIdle();
    this.publish();
  }

  /** A result, or an error, for `stage` arrived from request `requestId`. */
  settle(stage: PhysicsStage, requestId: number): void {
    const debt = this.owed.get(stage);
    if (!debt || requestId <= debt.after) return;
    this.owed.delete(stage);
    this.publish();
  }

  /** Owed stages the newest request is computing. */
  getPending(): readonly PhysicsStage[] {
    return this.pending;
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer !== undefined) this.hooks.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Owed stages that may be computed now, in STAGE_ORDER, optionally filtered further. */
  private owedStages(filter: (s: PhysicsStage, d: Debt) => boolean = () => true): PhysicsStage[] {
    return STAGE_ORDER.filter((s) => {
      const d = this.owed.get(s);
      return d !== undefined && this.hooks.eligible(s) && filter(s, d);
    });
  }

  private queueFrame(): void {
    if (this.frameQueued) return;
    this.frameQueued = true;
    this.hooks.requestFrame(this.flushFrame);
  }

  /** (Re)start the quiet period after which the expensive stages go out. */
  private armIdle(): void {
    if (this.idleTimer !== undefined) this.hooks.clearTimeout(this.idleTimer);
    this.idleTimer = this.hooks.setTimeout(this.flushIdle, this.hooks.idleDelayMs);
  }

  private readonly flushFrame = (): void => {
    this.frameQueued = false;
    if (this.disposed) return;
    if (!this.sendIfNeeded(this.owedStages((s) => !isIdle(s)))) return;
    // That request cancels whatever an older one had left: expensive stages go again when quiet.
    if (this.owedStages(isIdle).length > 0) this.armIdle();
  };

  private readonly flushIdle = (): void => {
    this.idleTimer = undefined;
    if (this.disposed) return;
    this.sendIfNeeded(this.owedStages());
  };

  /** Send `stages` unless the newest request already carries all of them; true if sent. */
  private sendIfNeeded(stages: PhysicsStage[]): boolean {
    if (stages.every((s) => this.owed.get(s)!.inFlight)) return false;
    const id = this.hooks.send(stages);
    this.lastSentId = Math.max(this.lastSentId, id);
    for (const [s, d] of this.owed) d.inFlight = stages.includes(s);
    this.publish();
    return true;
  }

  private publish(): void {
    const next = this.owedStages((_s, d) => d.inFlight);
    if (next.length === this.pending.length && next.every((s, i) => s === this.pending[i])) return;
    this.pending = next;
    this.hooks.onPending(next);
  }
}
