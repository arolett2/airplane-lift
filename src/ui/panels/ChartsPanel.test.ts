// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STATE, type AppState } from '../../state/params';
import { EMPTY_RESULTS, type ResultsState } from '../../state/results';
import { Store } from '../../state/store';
import {
  installFakeCanvas,
  installFixedResizeObserver,
  nextFrames,
  type FakeCanvas,
} from '../charts/testCanvas';
import { DEG, makeAero, makeGeometry, makePolar, makeSection } from '../charts/testFixtures';
import { ChartsPanel } from './ChartsPanel';

let fake: FakeCanvas;
let restoreObserver: () => void;
let root: HTMLElement;
let state: Store<AppState>;
let results: Store<ResultsState>;
let panel: ChartsPanel;

beforeEach(() => {
  fake = installFakeCanvas();
  restoreObserver = installFixedResizeObserver(320, 190);
  root = document.createElement('div');
  document.body.appendChild(root);
  state = new Store<AppState>(DEFAULT_STATE);
  results = new Store<ResultsState>(EMPTY_RESULTS);
  panel = new ChartsPanel(root, state, results);
});

afterEach(() => {
  panel.destroy();
  fake.restore();
  restoreObserver();
  root.remove();
});

const tabs = (): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];
const activePane = (): HTMLElement =>
  root.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;

function fillResults(): void {
  results.set({
    geometry: makeGeometry({}),
    aero: makeAero(),
    section: makeSection(),
    polar: makePolar(),
  });
}

describe('ChartsPanel', () => {
  it('has the four tabs, with the lift curve selected first', () => {
    expect(tabs().map((t) => t.textContent)).toEqual([
      'Lift curve',
      'Along the span',
      'Pressure',
      'Drag',
    ]);
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('false');
    expect(root.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
  });

  it('shows an empty state while data is missing, then the chart', async () => {
    const empty = activePane().querySelector<HTMLElement>('.viz-empty')!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toMatch(/lift curve/i);
    results.set({ pending: ['aero', 'polar'] });
    expect(activePane().querySelector<HTMLElement>('.viz-empty')!.textContent).toContain(
      'Working out',
    );

    fillResults();
    await nextFrames();
    expect(activePane().querySelector<HTMLElement>('.viz-empty')!.hidden).toBe(true);
    expect(fake.texts).toContain('Your wing');
    expect(fake.texts).toContain('Endless wing (2D)');
    expect(fake.texts).toContain('Stall');
    expect(fake.texts).toContain('You are here');
  });

  it('explains the finite-wing effect in the lift curve caption', () => {
    const caption = activePane().querySelector('.viz-caption')!.textContent!;
    expect(caption).toMatch(/finite wing/);
    expect(caption).toMatch(/tip vortices/);
  });

  it('gives every chart a caption', () => {
    for (const pane of root.querySelectorAll('[role="tabpanel"]')) {
      const figures = pane.querySelectorAll('figure');
      expect(figures.length).toBeGreaterThan(0);
      for (const fig of figures) {
        expect(fig.querySelector('.viz-caption')!.textContent!.length).toBeGreaterThan(30);
      }
    }
  });

  it('switches tabs, drawing the span, pressure and drag charts from the data', async () => {
    fillResults();
    tabs()[1]!.click();
    await nextFrames();
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(activePane().querySelectorAll('figure')).toHaveLength(2);
    expect(fake.texts).toContain('Ideal ellipse');
    expect(fake.texts).toContain('Stall limit');
    expect([...activePane().querySelectorAll('.viz-note')].pop()!.textContent).toMatch(
      /Closest to stalling/,
    );

    fake.reset();
    tabs()[2]!.click();
    await nextFrames();
    expect(fake.texts).toContain('Top surface');
    expect(fake.texts).toContain('Underside');
    expect(activePane().querySelector('.viz-note')!.textContent).toContain('35% of the way out');

    fake.reset();
    tabs()[3]!.click();
    await nextFrames();
    expect(fake.texts.some((t) => t.startsWith('Best glide'))).toBe(true);
    expect(fake.texts).toContain('You are here');
  });

  it('supports arrow-key navigation between tabs', () => {
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel.getActiveTab()).toBe('span');
    tabs()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(panel.getActiveTab()).toBe('lift');
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(panel.getActiveTab()).toBe('drag');
  });

  it('moves the current-point marker when the angle slider moves', async () => {
    fillResults();
    await nextFrames();
    const note = (): string => activePane().querySelector('.viz-note')!.textContent!;
    expect(note()).toContain('5.0°');
    state.set((s) => ({ ...s, flow: { ...s.flow, alphaDeg: 8 } }));
    expect(note()).toContain('8.0°');
  });

  it('dims charts while the data is being recomputed', () => {
    fillResults();
    results.set({ pending: ['polar'] });
    expect(activePane().querySelector('figure')!.classList.contains('is-stale')).toBe(true);
    results.set({ pending: [] });
    expect(activePane().querySelector('figure')!.classList.contains('is-stale')).toBe(false);
  });

  it('shows a helpful message when there is almost no lift', () => {
    results.set({
      geometry: makeGeometry({}),
      aero: makeAero({
        alpha: 0 * DEG,
        strips: makeAero().strips.map((s) => ({ ...s, liftPerSpan: 0 })),
      }),
    });
    tabs()[1]!.click();
    expect(activePane().querySelector('.viz-empty')!.textContent).toMatch(/almost no lift/);
  });

  it('reports a solver error instead of a blank chart', () => {
    results.set({ error: 'boom' });
    expect(activePane().querySelector('.viz-empty')!.textContent).toContain('boom');
  });

  it('cleans up on destroy and ignores later updates', () => {
    panel.destroy();
    expect(root.querySelector('.viz-charts')).toBeNull();
    expect(() => results.set({ pending: ['aero'] })).not.toThrow();
    panel = new ChartsPanel(root, state, results); // keep afterEach happy
  });
});
