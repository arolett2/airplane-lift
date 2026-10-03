import { describe, expect, it } from 'vitest';
import { STAGE_ORDER, type PhysicsStage } from '../worker/protocol';
import { RequestScheduler } from './requestScheduler';

const IDLE_MS = 220;

/** Drives a RequestScheduler with a manual frame queue and clock. */
function harness(opts: { particles?: boolean } = {}) {
  let particles = opts.particles ?? true;
  let nextId = 1;
  let now = 0;
  const sent: { id: number; stages: PhysicsStage[] }[] = [];
  let frames: (() => void)[] = [];
  const timers = new Map<number, { at: number; cb: () => void }>();
  let timerId = 0;
  const pendingLog: PhysicsStage[][] = [];

  const scheduler = new RequestScheduler({
    send: (stages) => {
      const id = nextId++;
      sent.push({ id, stages: [...stages] });
      return id;
    },
    eligible: (s) => s !== 'field' || particles,
    onPending: (p) => pendingLog.push([...p]),
    requestFrame: (cb) => frames.push(cb),
    setTimeout: (cb, ms) => {
      timers.set(++timerId, { at: now + ms, cb });
      return timerId;
    },
    clearTimeout: (h) => timers.delete(h as number),
    idleDelayMs: IDLE_MS,
  });

  const frame = () => {
    const run = frames;
    frames = [];
    for (const cb of run) cb();
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].cb();
    }
    now = until;
  };
  /** Deliver a stage result from request `id`. */
  const deliver = (id: number, ...stages: PhysicsStage[]) => {
    for (const s of stages) scheduler.settle(s, id);
  };
  const last = () => sent[sent.length - 1]!;

  return {
    scheduler,
    sent,
    frame,
    advance,
    deliver,
    last,
    pending: () => scheduler.getPending(),
    pendingLog,
    setParticles: (on: boolean) => {
      particles = on;
      scheduler.refresh();
    },
  };
}

describe('RequestScheduler', () => {
  it('sends cheap stages on the next frame and expensive ones after an idle pause', () => {
    const h = harness();
    h.scheduler.invalidate(STAGE_ORDER);
    expect(h.sent).toEqual([]);
    h.frame();
    expect(h.sent).toEqual([{ id: 1, stages: ['aero', 'section', 'streamlines'] }]);
    expect(h.pending()).toEqual(['aero', 'section', 'streamlines']);
    h.deliver(1, 'aero', 'section');
    h.advance(IDLE_MS);
    // The idle request carries everything still owed (it cancels request 1's remaining stages).
    expect(h.last()).toEqual({ id: 2, stages: ['polar', 'streamlines', 'field'] });
    h.deliver(2, 'streamlines', 'polar', 'field');
    expect(h.pending()).toEqual([]);
    h.advance(10 * IDLE_MS);
    h.frame();
    expect(h.sent).toHaveLength(2);
  });

  it('re-requests the field when particles come back after the inputs changed', () => {
    const h = harness();
    h.scheduler.invalidate(STAGE_ORDER);
    h.frame();
    h.advance(IDLE_MS);
    h.deliver(2, ...STAGE_ORDER);
    h.setParticles(false);
    // Alpha changes while particles are hidden: the field is skipped, not forgotten.
    h.scheduler.invalidate(STAGE_ORDER);
    h.frame();
    h.advance(IDLE_MS);
    expect(h.last().stages).not.toContain('field');
    h.deliver(h.last().id, ...h.last().stages);
    expect(h.pending()).toEqual([]);
    const before = h.sent.length;
    h.setParticles(true);
    h.frame();
    h.advance(IDLE_MS);
    expect(h.sent).toHaveLength(before + 1);
    expect(h.last().stages).toEqual(['field']);
    expect(h.pending()).toEqual(['field']);
  });

  it('carries expensive stages forward when a cheap request cancels the idle one', () => {
    const h = harness();
    h.scheduler.invalidate(STAGE_ORDER); // flaps change
    h.frame();
    h.deliver(1, 'aero', 'section', 'streamlines');
    h.advance(IDLE_MS);
    expect(h.last()).toEqual({ id: 2, stages: ['polar', 'field'] });
    expect(h.pending()).toEqual(['polar', 'field']);
    // Section slider scrubbed: request 3 makes the worker drop request 2's polar and field.
    h.scheduler.invalidate(['section']);
    h.frame();
    expect(h.last()).toEqual({ id: 3, stages: ['section'] });
    h.deliver(3, 'section');
    // Nothing is left being computed, so nothing claims to be pending ...
    expect(h.pending()).toEqual([]);
    // ... but polar and field are still owed and go out again once the scrub stops.
    h.advance(IDLE_MS);
    expect(h.last()).toEqual({ id: 4, stages: ['polar', 'field'] });
    expect(h.pending()).toEqual(['polar', 'field']);
    h.deliver(4, 'polar', 'field');
    expect(h.pending()).toEqual([]);
  });

  it('keeps every owed expensive stage when another idle request arrives first', () => {
    const h = harness({ particles: false });
    h.scheduler.invalidate(STAGE_ORDER);
    h.frame();
    h.advance(IDLE_MS);
    h.deliver(2, 'aero', 'section', 'polar', 'streamlines');
    h.scheduler.invalidate(STAGE_ORDER); // flaps 25
    h.advance(100);
    h.setParticles(true); // flow view switched to 'both' within the idle delay
    h.frame();
    h.advance(IDLE_MS);
    expect(h.last().stages).toEqual(expect.arrayContaining(['polar', 'field']));
  });

  it("does not let an older request's results settle stages owed to newer inputs", () => {
    const h = harness();
    h.scheduler.invalidate(STAGE_ORDER);
    h.frame();
    h.advance(IDLE_MS);
    h.deliver(2, 'aero', 'section', 'polar', 'streamlines');
    expect(h.pending()).toEqual(['field']);
    // Smoke-line count changed while request 2 is still computing the field.
    h.scheduler.invalidate(['streamlines']);
    h.frame();
    expect(h.last()).toEqual({ id: 3, stages: ['streamlines'] });
    expect(h.pending()).toEqual(['streamlines']);
    h.deliver(2, 'field'); // the field was already running, so request 2 still posts it
    h.deliver(2, 'streamlines'); // late/out-of-date: does not count
    expect(h.pending()).toEqual(['streamlines']);
    h.deliver(3, 'streamlines');
    expect(h.pending()).toEqual([]);
  });

  it('does not resend stages the newest request is already computing', () => {
    const h = harness();
    h.scheduler.invalidate(STAGE_ORDER);
    h.frame();
    h.advance(IDLE_MS);
    expect(h.sent).toHaveLength(2);
    h.setParticles(true); // no eligibility change, nothing new
    h.frame();
    h.advance(IDLE_MS);
    expect(h.sent).toHaveLength(2);
  });

  it('stops scheduling after dispose', () => {
    const h = harness();
    h.scheduler.invalidate(STAGE_ORDER);
    h.scheduler.dispose();
    h.frame();
    h.advance(IDLE_MS);
    expect(h.sent).toEqual([]);
  });
});
