import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AeroResult, WingGeometry } from '../physics/types';
import type { ComputeRequest, PhysicsRequest, PhysicsResponse } from './protocol';
import { DEFAULT_FLOW, DEFAULT_VIEW, DEFAULT_WING } from '../state/params';
import { COMPARE_TIMEOUT_MS, PhysicsClient } from './PhysicsClient';

/** Minimal stand-in for a Web Worker: records posts, lets tests push replies. */
class FakeWorker extends EventTarget {
  posted: PhysicsRequest[] = [];
  terminated = false;
  postMessage(msg: PhysicsRequest): void {
    this.posted.push(structuredClone(msg));
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(msg: PhysicsResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data: msg }));
  }
  crash(message: string): void {
    const event = new Event('error');
    Object.defineProperty(event, 'message', { value: message });
    this.dispatchEvent(event);
  }
}

function setup(): { worker: FakeWorker; client: PhysicsClient; received: PhysicsResponse[] } {
  const worker = new FakeWorker();
  const client = new PhysicsClient(() => worker as unknown as Worker);
  const received: PhysicsResponse[] = [];
  client.onResponse((m) => received.push(m));
  return { worker, client, received };
}

const input: Omit<ComputeRequest, 'type' | 'requestId'> = {
  wing: DEFAULT_WING,
  flow: DEFAULT_FLOW,
  rake: DEFAULT_VIEW.rake,
  sectionEta: 0.35,
  stages: ['aero', 'section'],
  fieldQuality: 1,
};

const fakeResult = (id: string) => ({
  id,
  geometry: {} as WingGeometry,
  aero: { requestId: 0 } as AeroResult,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PhysicsClient.compute', () => {
  it('posts compute requests with increasing ids', () => {
    const { worker, client } = setup();
    expect(client.compute(input)).toBe(1);
    expect(client.compute({ ...input, sectionEta: 0.5 })).toBe(2);
    expect(worker.posted).toEqual([
      { type: 'compute', requestId: 1, ...input },
      { type: 'compute', requestId: 2, ...input, sectionEta: 0.5 },
    ]);
  });

  it('sends only protocol fields', () => {
    const { worker, client } = setup();
    client.compute({ ...input, extra: 'big state' } as typeof input);
    expect(Object.keys(worker.posted[0]!).sort()).toEqual(
      ['type', 'requestId', ...Object.keys(input)].sort(),
    );
  });
});

describe('PhysicsClient.onResponse', () => {
  it('delivers responses until unsubscribed', () => {
    const { worker, client } = setup();
    const got: PhysicsResponse[] = [];
    const off = client.onResponse((m) => got.push(m));
    worker.reply({ type: 'done', requestId: 1 });
    off();
    worker.reply({ type: 'done', requestId: 2 });
    expect(got).toEqual([{ type: 'done', requestId: 1 }]);
  });

  it('drops stage responses older than the newest delivered for that stage', () => {
    const { worker, received } = setup();
    worker.reply({ type: 'polar', requestId: 2, polar: {} as never });
    worker.reply({ type: 'polar', requestId: 1, polar: {} as never }); // stale: dropped
    worker.reply({ type: 'section', requestId: 1, section: {} as never }); // other stage: kept
    worker.reply({ type: 'error', requestId: 1, stage: 'polar', message: 'old' }); // dropped
    worker.reply({ type: 'error', requestId: 3, stage: 'polar', message: 'new' }); // kept
    worker.reply({ type: 'polar', requestId: 2, polar: {} as never }); // older than error 3
    worker.reply({ type: 'done', requestId: 3 });
    worker.reply({ type: 'done', requestId: 2 }); // dropped
    expect(received.map((m) => `${m.type}:${m.requestId}`)).toEqual([
      'polar:2',
      'section:1',
      'error:3',
      'done:3',
    ]);
  });

  it('keeps delivering when one listener throws', () => {
    const { worker, client, received } = setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.onResponse(() => {
      throw new Error('listener bug');
    });
    const after: PhysicsResponse[] = [];
    client.onResponse((m) => after.push(m));
    worker.reply({ type: 'done', requestId: 1 });
    expect(received).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reports a worker crash against the latest compute request', () => {
    const { worker, client, received } = setup();
    client.compute(input);
    client.compute(input);
    worker.crash('boom');
    expect(received).toEqual([{ type: 'error', requestId: 2, stage: 'aero', message: 'boom' }]);
  });
});

describe('PhysicsClient.compare', () => {
  it('resolves each compare with its own response, without broadcasting it', async () => {
    const { worker, client, received } = setup();
    const p1 = client.compare([{ id: 'a', wing: DEFAULT_WING, flow: DEFAULT_FLOW }]);
    const p2 = client.compare([{ id: 'b', wing: DEFAULT_WING, flow: DEFAULT_FLOW }]);
    const [r1, r2] = worker.posted as Extract<PhysicsRequest, { type: 'compare' }>[];
    expect(r1!.type).toBe('compare');
    expect(r1!.cases.map((c) => c.id)).toEqual(['a']);
    worker.reply({ type: 'compare', requestId: r2!.requestId, results: [fakeResult('b')] });
    worker.reply({ type: 'compare', requestId: r1!.requestId, results: [fakeResult('a')] });
    expect((await p1).map((r) => r.id)).toEqual(['a']);
    expect((await p2).map((r) => r.id)).toEqual(['b']);
    expect(received).toEqual([]);
  });

  it('shares the id counter with compute requests', () => {
    const { worker, client } = setup();
    client.compute(input);
    void client.compare([]);
    expect(client.compute(input)).toBe(3);
    expect(worker.posted.map((r) => r.requestId)).toEqual([1, 2, 3]);
  });

  it('rejects when the worker reports a compare error', async () => {
    const { worker, client, received } = setup();
    const p = client.compare([]);
    worker.reply({ type: 'error', requestId: 1, stage: 'compare', message: 'bad wing' });
    await expect(p).rejects.toThrow('bad wing');
    expect(received).toEqual([]);
  });

  it('rejects after the timeout and ignores a late reply', async () => {
    vi.useFakeTimers();
    const { worker, client } = setup();
    const p = client.compare([]);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(COMPARE_TIMEOUT_MS + 1);
    await assertion;
    expect(() => worker.reply({ type: 'compare', requestId: 1, results: [] })).not.toThrow();
  });

  it('rejects pending compares when the worker crashes', async () => {
    const { worker, client } = setup();
    const p = client.compare([]);
    worker.crash('worker died');
    await expect(p).rejects.toThrow('worker died');
  });
});

describe('PhysicsClient.probe', () => {
  it('resolves with its own sample, without broadcasting it', async () => {
    const { worker, client, received } = setup();
    const p = client.probe([1, 2, 3]);
    const req = worker.posted[0] as Extract<PhysicsRequest, { type: 'probe' }>;
    expect(req).toEqual({ type: 'probe', requestId: 1, point: [1, 2, 3] });
    worker.reply({ type: 'probe', requestId: 1, sample: null });
    await expect(p).resolves.toBeNull();
    expect(received).toEqual([]);
  });

  it('rejects on a probe error and when the worker crashes', async () => {
    const { worker, client, received } = setup();
    const p1 = client.probe([0, 0, 0]);
    worker.reply({ type: 'error', requestId: 1, stage: 'probe', message: 'nope' });
    await expect(p1).rejects.toThrow('nope');
    expect(received).toEqual([]);
    const p2 = client.probe([0, 0, 0]);
    worker.crash('worker died');
    await expect(p2).rejects.toThrow('worker died');
  });
});

describe('PhysicsClient.dispose', () => {
  it('terminates the worker, rejects pending compares and goes quiet', async () => {
    const { worker, client, received } = setup();
    const p = client.compare([]);
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(p).rejects.toThrow(/disposed/);
    worker.reply({ type: 'done', requestId: 1 });
    expect(received).toEqual([]);
    client.compute(input);
    expect(worker.posted).toHaveLength(1); // only the compare sent before dispose
    await expect(client.compare([])).rejects.toThrow(/disposed/);
    expect(() => client.dispose()).not.toThrow();
  });
});
