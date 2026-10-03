/**
 * Worker message handling with the physics mocked: stage order, streaming, staleness, errors,
 * caching and transfer lists. End-to-end runs against the real solvers are in
 * src/physics/aero.e2e.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AeroResult, FlowFieldGrid, Streamline3D, WingGeometry } from '../physics/types';
import type { WingConfig, FlowConditions } from '../state/params';
import type { ComputeRequest, PhysicsResponse, PhysicsStage } from './protocol';
import type * as AeroModule from '../physics/aero';
import { DEFAULT_FLOW, DEFAULT_VIEW, DEFAULT_WING } from '../state/params';
import { STAGE_ORDER } from './protocol';
import { tunnelDomain } from '../physics/domain';

const fakes = vi.hoisted(() => {
  const geometry = {
    surfaces: [
      { sections: [{ chord: 2 }, { chord: 1 }] },
      { sections: [{ chord: 2 }, { chord: 0.5 }] },
      { sections: [{ chord: 3 }, { chord: 0.5 }] }, // e.g. a yehudi root
    ],
    overallSpan: 12,
  } as unknown as WingGeometry;

  const computeAero = vi.fn((_w: WingConfig, flow: FlowConditions, requestId: number) => ({
    geometry,
    aero: {
      requestId,
      alpha: (flow.alphaDeg * Math.PI) / 180,
      velocity: flow.airspeed,
      lattice: { count: 1 },
    } as unknown as AeroResult,
  }));

  const line = (): Streamline3D => ({
    points: new Float32Array(9),
    speed: new Float32Array(3),
    time: new Float32Array(3),
    group: 'rake',
  });

  return {
    geometry,
    computeAero,
    computePolarSweep: vi.fn((_w: WingConfig, _f: FlowConditions, requestId: number) => ({
      requestId,
    })),
    computeSection: vi.fn(() => ({ eta: 0.35 })),
    seedStreamlines: vi.fn(() => [{ points: new Float32Array(3), group: 'rake' as const }]),
    traceStreamlines: vi.fn(() => [line(), line()]),
    buildFlowFieldGrid: vi.fn(
      (..._args: unknown[]) =>
        ({
          requestId: 0,
          velocity: new Float32Array(24),
          solid: new Uint8Array(8),
        }) as unknown as FlowFieldGrid,
    ),
  };
});

vi.mock('../physics/aero', async (importOriginal) => ({
  ...(await importOriginal<typeof AeroModule>()),
  computeAero: fakes.computeAero,
  computePolarSweep: fakes.computePolarSweep,
  computeSection: fakes.computeSection,
}));
vi.mock('../physics/flow/index', () => ({
  seedStreamlines: fakes.seedStreamlines,
  traceStreamlines: fakes.traceStreamlines,
  buildFlowFieldGrid: fakes.buildFlowFieldGrid,
}));

import {
  createMessageHandler,
  createWorkerState,
  DEFAULT_FIELD_NODES,
  fieldTargetNodes,
  handleRequest,
  transferablesOf,
} from './physics.worker';

interface Posted {
  msg: PhysicsResponse;
  transfer: Transferable[] | undefined;
}

function recorder(): { posted: Posted[]; post: (m: PhysicsResponse, t?: Transferable[]) => void } {
  const posted: Posted[] = [];
  return { posted, post: (msg, transfer) => posted.push({ msg, transfer }) };
}

function request(requestId: number, stages: PhysicsStage[], extra: Partial<ComputeRequest> = {}) {
  return {
    type: 'compute' as const,
    requestId,
    wing: DEFAULT_WING,
    flow: DEFAULT_FLOW,
    rake: DEFAULT_VIEW.rake,
    sectionEta: 0.35,
    stages,
    fieldQuality: 1,
    ...extra,
  } satisfies ComputeRequest;
}

const never = () => false;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleRequest (compute)', () => {
  it('runs the requested stages in STAGE_ORDER, then posts done', async () => {
    const { posted, post } = recorder();
    await handleRequest(request(1, ['field', 'aero', 'polar']), post, never, createWorkerState());
    expect(posted.map((p) => p.msg.type)).toEqual(['aero', 'polar', 'field', 'done']);
    expect(posted.every((p) => p.msg.requestId === 1)).toBe(true);
  });

  it('streams each stage as soon as it is ready, yielding in between', async () => {
    const { posted, post } = recorder();
    const done = handleRequest(request(1, [...STAGE_ORDER]), post, never, createWorkerState());
    // The first stage runs synchronously; the rest wait for the event loop.
    expect(posted.map((p) => p.msg.type)).toEqual(['aero']);
    await done;
    expect(posted.map((p) => p.msg.type)).toEqual([...STAGE_ORDER, 'done']);
  });

  it('abandons the remaining stages once a newer request makes it stale', async () => {
    const { posted, post } = recorder();
    let stale = false;
    const run = handleRequest(request(1, [...STAGE_ORDER]), post, () => stale, createWorkerState());
    stale = true;
    await run;
    expect(posted.map((p) => p.msg.type)).toEqual(['aero']);
    expect(fakes.computePolarSweep).not.toHaveBeenCalled();
  });

  it('reports a failing stage and carries on with the others', async () => {
    fakes.computePolarSweep.mockImplementationOnce(() => {
      throw new Error('polar exploded');
    });
    const { posted, post } = recorder();
    await handleRequest(request(4, ['aero', 'polar', 'field']), post, never, createWorkerState());
    expect(posted.map((p) => p.msg.type)).toEqual(['aero', 'error', 'field', 'done']);
    expect(posted[1]!.msg).toEqual({
      type: 'error',
      requestId: 4,
      stage: 'polar',
      message: 'polar exploded',
    });
  });

  it('passes the section station and the polar request id through', async () => {
    const { posted, post } = recorder();
    const req = request(5, ['section', 'polar'], { sectionEta: 0.8 });
    await handleRequest(req, post, never, createWorkerState());
    expect(fakes.computeSection).toHaveBeenCalledWith(req.wing, req.flow, 0.8, expect.anything());
    expect(posted[0]!.msg).toEqual({ type: 'section', requestId: 5, section: { eta: 0.35 } });
    expect(posted[1]!.msg).toMatchObject({ type: 'polar', requestId: 5, polar: { requestId: 5 } });
    // Neither section nor polar needs the 3D solve.
    expect(fakes.computeAero).not.toHaveBeenCalled();
  });

  it('reuses the cached solve when wing and flow are unchanged', async () => {
    const state = createWorkerState();
    const { posted, post } = recorder();
    await handleRequest(request(1, ['aero']), post, never, state);
    const moved = { ...DEFAULT_VIEW.rake, eta: 0.7 };
    await handleRequest(request(2, ['aero', 'streamlines'], { rake: moved }), post, never, state);
    expect(fakes.computeAero).toHaveBeenCalledTimes(1);
    const aeroMsgs = posted.filter((p) => p.msg.type === 'aero');
    expect(aeroMsgs.map((p) => p.msg.requestId)).toEqual([1, 2]);
    const second = aeroMsgs[1]!.msg as Extract<PhysicsResponse, { type: 'aero' }>;
    expect(second.aero.requestId).toBe(2);
    // A changed flow solves again.
    const faster = { ...DEFAULT_FLOW, airspeed: 80 };
    await handleRequest(request(3, ['aero'], { flow: faster }), post, never, state);
    expect(fakes.computeAero).toHaveBeenCalledTimes(2);
  });

  it('solves once per request even when aero itself is not requested', async () => {
    const { posted, post } = recorder();
    await handleRequest(request(1, ['streamlines', 'field']), post, never, createWorkerState());
    expect(fakes.computeAero).toHaveBeenCalledTimes(1);
    expect(posted.map((p) => p.msg.type)).toEqual(['streamlines', 'field', 'done']);
  });

  it('traces streamlines in the tunnel domain and transfers their buffers', async () => {
    const { posted, post } = recorder();
    const req = request(2, ['streamlines']);
    await handleRequest(req, post, never, createWorkerState());
    const domain = tunnelDomain(12, 3); // overall span, longest section chord
    const alpha = (DEFAULT_FLOW.alphaDeg * Math.PI) / 180;
    expect(fakes.seedStreamlines).toHaveBeenCalledWith(fakes.geometry, alpha, req.rake, domain);
    const seeds = fakes.seedStreamlines.mock.results[0]!.value;
    expect(fakes.traceStreamlines).toHaveBeenCalledWith(
      { count: 1 },
      DEFAULT_FLOW.airspeed,
      seeds,
      domain,
      fakes.geometry,
      alpha,
    );
    const msg = posted[0]!;
    expect(msg.msg.type).toBe('streamlines');
    expect(msg.transfer).toHaveLength(6); // 2 lines x (points, speed, time)
  });

  it('builds the field grid with a quality-scaled node budget and transfers it', async () => {
    const { posted, post } = recorder();
    await handleRequest(
      request(3, ['field'], { fieldQuality: 0.5 }),
      post,
      never,
      createWorkerState(),
    );
    const [lattice, vInf, geometry, alpha, options, requestId] =
      fakes.buildFlowFieldGrid.mock.calls[0]!;
    expect(lattice).toEqual({ count: 1 });
    expect(vInf).toBe(DEFAULT_FLOW.airspeed);
    expect(geometry).toBe(fakes.geometry);
    expect(alpha).toBeCloseTo((DEFAULT_FLOW.alphaDeg * Math.PI) / 180, 12);
    expect(options).toEqual({ domain: tunnelDomain(12, 3), targetNodes: DEFAULT_FIELD_NODES / 2 });
    expect(requestId).toBe(3);
    const field = (posted[0]!.msg as Extract<PhysicsResponse, { type: 'field' }>).field;
    expect(posted[0]!.transfer).toEqual([field.velocity.buffer, field.solid.buffer]);
  });

  it('structured-clones (never transfers) what the worker keeps', async () => {
    const { posted, post } = recorder();
    await handleRequest(request(1, ['aero', 'section', 'polar']), post, never, createWorkerState());
    for (const p of posted) expect(p.transfer).toBeUndefined();
  });
});

describe('handleRequest (compare)', () => {
  it('solves every case and replies once', async () => {
    const { posted, post } = recorder();
    const wingB = { ...DEFAULT_WING, span: 20 };
    await handleRequest(
      {
        type: 'compare',
        requestId: 9,
        cases: [
          { id: 'a', wing: DEFAULT_WING, flow: DEFAULT_FLOW },
          { id: 'b', wing: wingB, flow: DEFAULT_FLOW },
        ],
      },
      post,
      never,
      createWorkerState(),
    );
    expect(posted).toHaveLength(1);
    const msg = posted[0]!.msg as Extract<PhysicsResponse, { type: 'compare' }>;
    expect(msg.type).toBe('compare');
    expect(msg.requestId).toBe(9);
    expect(msg.results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(fakes.computeAero.mock.calls[1]![0]).toBe(wingB);
  });

  it('replies with a compare error when a case fails', async () => {
    fakes.computeAero.mockImplementationOnce(() => {
      throw new Error('bad wing');
    });
    const { posted, post } = recorder();
    await handleRequest(
      {
        type: 'compare',
        requestId: 2,
        cases: [{ id: 'a', wing: DEFAULT_WING, flow: DEFAULT_FLOW }],
      },
      post,
      never,
      createWorkerState(),
    );
    expect(posted.map((p) => p.msg)).toEqual([
      { type: 'error', requestId: 2, stage: 'compare', message: 'bad wing' },
    ]);
  });
});

describe('createMessageHandler', () => {
  it('abandons an older compute request when a newer one arrives', async () => {
    const { posted, post } = recorder();
    const handle = createMessageHandler(post);
    const first = handle(request(1, [...STAGE_ORDER]));
    const second = handle(request(2, [...STAGE_ORDER], { flow: { ...DEFAULT_FLOW, alphaDeg: 7 } }));
    await Promise.all([first, second]);
    const forOne = posted.filter((p) => p.msg.requestId === 1).map((p) => p.msg.type);
    const forTwo = posted.filter((p) => p.msg.requestId === 2).map((p) => p.msg.type);
    expect(forOne).toEqual(['aero']);
    expect(forTwo).toEqual([...STAGE_ORDER, 'done']);
  });

  it('never treats compare requests as stale', async () => {
    const { posted, post } = recorder();
    const handle = createMessageHandler(post);
    const run = handle({ type: 'compare', requestId: 1, cases: [] });
    await handle(request(5, ['aero']));
    await run;
    expect(posted.map((p) => p.msg.type)).toEqual(['compare', 'aero', 'done']);
  });
});

describe('helpers', () => {
  it('scales the field node budget linearly and clamps silly values', () => {
    expect(fieldTargetNodes(1)).toBe(DEFAULT_FIELD_NODES);
    expect(fieldTargetNodes(1.5)).toBe(1.5 * DEFAULT_FIELD_NODES);
    expect(fieldTargetNodes(100)).toBe(2 * DEFAULT_FIELD_NODES);
    expect(fieldTargetNodes(0)).toBe(0.1 * DEFAULT_FIELD_NODES);
    expect(fieldTargetNodes(NaN)).toBe(DEFAULT_FIELD_NODES);
  });

  it('lists each underlying buffer once', () => {
    const shared = new Float32Array(10);
    const views = [shared.subarray(0, 5), shared.subarray(5), new Uint8Array(3), new Uint8Array(0)];
    const buffers = transferablesOf(views);
    expect(buffers).toHaveLength(2);
    expect(buffers[0]).toBe(shared.buffer);
  });
});
