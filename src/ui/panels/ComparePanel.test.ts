// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE, DEFAULT_WING, type AppState } from '../../state/params';
import { Store } from '../../state/store';
import { makeAero, makeGeometry } from '../charts/testFixtures';
import { ComparePanel, type CompareRequester } from './ComparePanel';

// Only a demo preset exists until the content module merges, so the tests bring their own.
vi.mock('../../state/presets', async () => {
  const { makePreset: make } = await import('../charts/testFixtures');
  const {
    NO_TIP_DEVICE,
    TIP_DEVICE_DEFAULTS,
    DEFAULT_WING: wing,
  } = await import('../../state/params');
  const presets = [
    make({
      id: 'big-jet',
      name: 'Big Jet 900',
      shortName: 'Big Jet',
      category: 'airliner',
      blurb: 'A large swept wing.',
      facts: ['Carries hundreds of passengers.'],
      wing: { ...wing, tipDevice: TIP_DEVICE_DEFAULTS['blended-winglet'] },
      maxTakeoffMassKg: 400000,
      typicalCruiseMassKg: 300000,
    }),
    make({
      id: 'twin-jet',
      name: 'Twin Jet 300',
      shortName: 'Twin Jet',
      category: 'airliner',
      wing: { ...wing, tipDevice: NO_TIP_DEVICE },
    }),
    make({
      id: 'trainer',
      name: 'Light Trainer',
      shortName: 'Trainer',
      category: 'general-aviation',
      maxTakeoffMassKg: 1100,
      typicalCruiseMassKg: 1000,
    }),
  ];
  return {
    PRESETS: presets,
    getPreset: (id: string) => presets.find((p) => p.id === id),
  };
});

let root: HTMLElement;
let store: Store<AppState>;
let panel: ComparePanel;
let requester: ReturnType<typeof vi.fn<CompareRequester>>;

const SPANS: Record<string, number> = { 'big-jet': 60, 'twin-jet': 35, trainer: 11 };

const respond: CompareRequester = async (cases) =>
  cases.map((c) => {
    const key = c.id.split(':')[1]!;
    return {
      id: c.id,
      geometry: makeGeometry({ span: SPANS[key] ?? 10, winglet: key === 'big-jet' }),
      aero: makeAero({ mach: key === 'trainer' ? 0.17 : 0.8, dynamicPressure: 8000 }),
    };
  });

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const el = (): HTMLElement => root.querySelector<HTMLElement>('.viz-compare')!;
const select = (slot: 'a' | 'b'): HTMLSelectElement =>
  root.querySelector<HTMLSelectElement>(`select[data-slot="${slot}"]`)!;
const open = (pair: [string, string] = ['big-jet', 'trainer']): void =>
  store.set((s) => ({ ...s, compare: pair }));

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  store = new Store<AppState>(DEFAULT_STATE);
  requester = vi.fn<CompareRequester>(respond);
  panel = new ComparePanel(root, store, requester);
});

afterEach(() => {
  panel.destroy();
  root.remove();
});

describe('ComparePanel visibility', () => {
  it('is hidden until state.compare is set, and hides again when it is cleared', () => {
    expect(el().hidden).toBe(true);
    expect(panel.isOpen()).toBe(false);
    expect(requester).not.toHaveBeenCalled();
    open();
    expect(el().hidden).toBe(false);
    expect(el().getAttribute('role')).toBe('dialog');
    expect(el().getAttribute('aria-modal')).toBe('true');
    store.set((s) => ({ ...s, compare: null }));
    expect(el().hidden).toBe(true);
  });

  it('shows immediately when constructed with a comparison already requested', () => {
    panel.destroy();
    store.set((s) => ({ ...s, compare: ['twin-jet', 'trainer'] }));
    panel = new ComparePanel(root, store, requester);
    expect(el().hidden).toBe(false);
    expect(select('a').value).toBe('twin-jet');
    expect(select('b').value).toBe('trainer');
  });

  it('closing sets state.compare to null (button, backdrop and Escape)', () => {
    open();
    root.querySelector<HTMLButtonElement>('.viz-close')!.click();
    expect(store.get().compare).toBeNull();
    expect(el().hidden).toBe(true);

    open();
    root.querySelector<HTMLElement>('.viz-compare-backdrop')!.click();
    expect(store.get().compare).toBeNull();

    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.get().compare).toBeNull();
    // Escape while closed does nothing.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.get().compare).toBeNull();
  });

  it('moves focus into the dialog and gives it back on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    open();
    expect(document.activeElement).toBe(root.querySelector('.viz-close'));
    store.set((s) => ({ ...s, compare: null }));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('ComparePanel pickers', () => {
  it('lists the presets grouped by category and defaults to the pair in state', () => {
    open(['twin-jet', 'trainer']);
    expect(select('a').value).toBe('twin-jet');
    expect(select('b').value).toBe('trainer');
    const groups = [...select('a').querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual(['Airliners', 'General aviation']);
    expect(select('a').querySelectorAll('option')).toHaveLength(3);
  });

  it('falls back to known presets when state holds unknown ids', () => {
    open(['nope', 'also-nope']);
    expect(select('a').value).toBe('big-jet');
    expect(select('b').value).toBe('twin-jet');
  });

  it('changing a picker updates state.compare and recomputes', async () => {
    open(['big-jet', 'trainer']);
    await flush();
    requester.mockClear();
    select('b').value = 'twin-jet';
    select('b').dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().compare).toEqual(['big-jet', 'twin-jet']);
    expect(requester).toHaveBeenCalledTimes(1);
    await flush();
    expect(root.querySelector('thead .viz-col-b')!.textContent).toBe('Twin Jet');
  });
});

describe('ComparePanel computing', () => {
  it('requests both wings at their cruise conditions', async () => {
    open(['big-jet', 'trainer']);
    expect(requester).toHaveBeenCalledTimes(1);
    const cases = requester.mock.calls[0]![0];
    expect(cases).toHaveLength(2);
    expect(cases[0]!.id).not.toBe(cases[1]!.id);
    expect(cases[0]!.wing.tipDevice.kind).toBe('blended-winglet');
    expect(cases[0]!.flow).toEqual({ alphaDeg: 3, airspeed: 230, altitude: 10668 });
    expect(cases[1]!.wing).toBe(DEFAULT_WING);
    await flush();
  });

  it('can compare an aircraft with itself', async () => {
    open(['trainer', 'trainer']);
    await flush();
    expect(root.querySelectorAll('tbody tr').length).toBeGreaterThan(5);
    expect(root.querySelector('.viz-compare-why li')!.textContent).toMatch(/same aircraft/);
  });

  it('shows a working message, then planforms, table and explanations', async () => {
    open();
    expect(root.querySelector<HTMLElement>('.viz-compare-status')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('.viz-compare-status')!.textContent).toContain(
      'Working out',
    );
    expect(root.querySelector<HTMLElement>('.viz-compare-table')!.hidden).toBe(true);

    await flush();
    expect(root.querySelector<HTMLElement>('.viz-compare-status')!.hidden).toBe(true);
    const svg = root.querySelector('svg.viz-planform')!;
    expect(svg).not.toBeNull();
    // big jet: 2 wings + 2 winglets; trainer: 2 wings
    expect(svg.querySelectorAll('polygon')).toHaveLength(6);
    expect(svg.textContent).toContain('60.0 m');
    expect(svg.textContent).toContain('11.0 m');

    const rows = [...root.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows).toHaveLength(11);
    const span = root.querySelector('tr[data-row="span"]')!;
    expect(span.querySelector('.viz-col-a')!.textContent).toBe('60.0 m');
    expect(span.querySelector('.viz-col-b')!.textContent).toBe('11.0 m');
    expect(root.querySelector('thead .viz-col-a')!.textContent).toBe('Big Jet');
    const bar = span.querySelector<HTMLElement>('.viz-col-b .viz-bar')!;
    expect(Number(bar.style.getPropertyValue('--frac'))).toBeCloseTo(11 / 60, 2);

    const why = [...root.querySelectorAll('.viz-compare-why li')].map((li) => li.textContent);
    expect(why.length).toBeGreaterThan(0);
    expect(why.some((t) => /larger wing/.test(t!))).toBe(true);
    expect(root.querySelector('.viz-compare-blurbs')!.textContent).toContain(
      'Carries hundreds of passengers.',
    );
  });

  it('switches table and drawing to imperial units', async () => {
    open();
    await flush();
    store.set((s) => ({ ...s, view: { ...s.view, units: 'imperial' } }));
    expect(root.querySelector('tr[data-row="span"] .viz-col-a')!.textContent).toBe('197 ft');
    expect(root.querySelector('svg.viz-planform')!.textContent).toContain('ft');
  });

  it('ignores a slow answer for an old pair', async () => {
    let releaseFirst: (v: Awaited<ReturnType<CompareRequester>>) => void = () => {};
    requester.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)));
    open(['big-jet', 'trainer']);
    const stale = await respond([
      { id: 'a:big-jet', wing: DEFAULT_WING, flow: DEFAULT_STATE.flow },
      { id: 'b:trainer', wing: DEFAULT_WING, flow: DEFAULT_STATE.flow },
    ]);
    open(['twin-jet', 'trainer']);
    await flush();
    releaseFirst(stale);
    await flush();
    expect(root.querySelector('thead .viz-col-a')!.textContent).toBe('Twin Jet');
    expect(root.querySelector('tr[data-row="span"] .viz-col-a')!.textContent).toBe('35.0 m');
  });

  it('ignores answers that arrive after closing', async () => {
    let release: (v: Awaited<ReturnType<CompareRequester>>) => void = () => {};
    requester.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    open();
    store.set((s) => ({ ...s, compare: null }));
    release(
      await respond([
        { id: 'a:big-jet', wing: DEFAULT_WING, flow: DEFAULT_STATE.flow },
        { id: 'b:trainer', wing: DEFAULT_WING, flow: DEFAULT_STATE.flow },
      ]),
    );
    await flush();
    expect(root.querySelector('svg.viz-planform')).toBeNull();
  });

  it('shows an error instead of a table when the calculation fails', async () => {
    requester.mockRejectedValueOnce(new Error('solver exploded'));
    open();
    await flush();
    const status = root.querySelector<HTMLElement>('.viz-compare-status')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('solver exploded');
    expect(root.querySelector<HTMLElement>('.viz-compare-table')!.hidden).toBe(true);
  });

  it('offers a retry after an error', async () => {
    requester.mockRejectedValueOnce(new Error('flaky'));
    open();
    await flush();
    const retry = root.querySelector<HTMLButtonElement>('.viz-compare-status .viz-button')!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await flush();
    expect(requester).toHaveBeenCalledTimes(2);
    expect(root.querySelector<HTMLElement>('.viz-compare-table')!.hidden).toBe(false);
    expect(retry.hidden).toBe(true);
    expect(root.querySelector('.viz-compare-planform + .viz-caption')!.textContent).toMatch(
      /same scale/,
    );
  });

  it('handles a synchronous throw and an incomplete answer', async () => {
    requester.mockImplementationOnce(() => {
      throw new Error('no worker');
    });
    open();
    expect(root.querySelector('.viz-compare-status')!.textContent).toContain('no worker');
    requester.mockResolvedValueOnce([]);
    open(['twin-jet', 'trainer']);
    await flush();
    expect(root.querySelector('.viz-compare-status')!.textContent).toContain('did not return both');
  });
});

describe('ComparePanel lifecycle', () => {
  it('removes itself and stops reacting on destroy', () => {
    panel.destroy();
    expect(root.querySelector('.viz-compare')).toBeNull();
    expect(() => open()).not.toThrow();
    expect(requester).not.toHaveBeenCalled();
    panel = new ComparePanel(root, store, requester); // keep afterEach happy
  });
});
