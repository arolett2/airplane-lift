// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE, type AppState } from '../../state/params';
import { EMPTY_RESULTS, type ResultsState } from '../../state/results';
import { Store } from '../../state/store';
import {
  installFakeCanvas,
  installFixedResizeObserver,
  type FakeCanvas,
} from '../charts/testCanvas';
import { DEG, ellipseCp, makeSection } from '../charts/testFixtures';
import { SectionView } from './SectionView';

let fake: FakeCanvas;
let restoreObserver: () => void;
let root: HTMLElement;
let state: Store<AppState>;
let results: Store<ResultsState>;
let view: SectionView;

// A manual animation-frame queue so tests control time.
let queue: { id: number; cb: (t: number) => void }[] = [];
let nextId = 1;
let now = 0;

function runFrames(count: number, stepMs = 16): void {
  for (let i = 0; i < count; i++) {
    now += stepMs;
    const batch = queue;
    queue = [];
    for (const item of batch) item.cb(now);
  }
}

beforeEach(() => {
  queue = [];
  nextId = 1;
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter((q) => q.id !== id);
  });
  fake = installFakeCanvas();
  restoreObserver = installFixedResizeObserver(340, 190);
  root = document.createElement('div');
  document.body.appendChild(root);
  state = new Store<AppState>(DEFAULT_STATE);
  results = new Store<ResultsState>(EMPTY_RESULTS);
  view = new SectionView(root, state, results);
});

afterEach(() => {
  view.destroy();
  fake.restore();
  restoreObserver();
  root.remove();
  vi.unstubAllGlobals();
});

const section = (over = {}) =>
  makeSection({
    alphaEffective: 6 * DEG,
    alphaGeometric: 7.5 * DEG,
    alphaInduced: 1.5 * DEG,
    cp: ellipseCp(6 * DEG),
    cl: 0.9,
    stagnation: [0.004, -0.012],
    ...over,
  });

const slider = (): HTMLInputElement => root.querySelector('input[type="range"]')!;
const label = (): string => root.querySelector('.viz-slider label')!.textContent!;

describe('SectionView controls', () => {
  it('shows the station slider bound to view.sectionEta', () => {
    expect(label()).toBe('Slice at 35% of the half-span');
    expect(slider().value).toBe('0.35');
    slider().value = '0.8';
    slider().dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.get().view.sectionEta).toBeCloseTo(0.8, 9);
    expect(label()).toBe('Slice at 80% of the half-span');
  });

  it('follows changes made elsewhere (lessons, URL state)', () => {
    state.set((s) => ({ ...s, view: { ...s.view, sectionEta: 1 } }));
    expect(slider().value).toBe('1');
    expect(label()).toContain('wingtip');
    state.set((s) => ({ ...s, view: { ...s.view, sectionEta: 0 } }));
    expect(label()).toContain('body');
  });

  it('explains what to notice in a caption', () => {
    const caption = root.querySelector('.viz-caption')!.textContent!;
    expect(caption).toMatch(/low pressure/);
    expect(caption).toMatch(/high pressure/);
  });
});

describe('SectionView drawing', () => {
  it('shows a placeholder until the first section arrives', () => {
    runFrames(1);
    expect(fake.texts).toContain('The cross-section appears after the first calculation.');
    fake.reset();
    results.set({ pending: ['section'] });
    runFrames(1);
    expect(fake.texts).toContain('Working out the flow…');
  });

  it('draws the lift arrow, stagnation point and the angle inset', () => {
    results.set({ section: section() });
    runFrames(1);
    expect(fake.texts).toContain('Lift');
    expect(fake.texts).toContain('Stagnation point');
    expect(fake.texts).toContain('Wing tilt');
    expect(fake.texts).toContain('− Downwash');
    expect(fake.texts).toContain('= Air feels');
    expect(fake.texts).toContain('7.5°');
    expect(fake.texts).toContain('1.5°');
    expect(fake.texts).toContain('6.0°');
    expect(fake.counts.putImageData).toBeGreaterThan(0); // pressure field was rendered
    expect(fake.counts.drawImage).toBeGreaterThan(0);
  });

  it('draws the separated region only for a stalled section', () => {
    results.set({ section: section() });
    runFrames(1);
    expect(fake.texts).not.toContain('Separated air (stall)');
    fake.reset();
    results.set({ section: section({ stalled: true, attachedFraction: 0.3 }) });
    runFrames(1);
    expect(fake.texts).toContain('Separated air (stall)');
  });

  it('toggles the surface pressure arrows', () => {
    results.set({ section: section() });
    runFrames(1);
    const withArrows = fake.counts.closePath ?? 0;
    const toggle = root.querySelector<HTMLInputElement>('.viz-toggle input')!;
    expect(toggle.checked).toBe(true);
    fake.reset();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    runFrames(1);
    expect(fake.counts.closePath ?? 0).toBeLessThan(withArrows);
  });

  it('re-renders the field when the colour mode changes', () => {
    results.set({ section: section() });
    runFrames(1);
    fake.reset();
    state.set((s) => ({ ...s, view: { ...s.view, colorBy: 'speed' } }));
    runFrames(1);
    expect(fake.counts.putImageData).toBe(1);
  });

  it('hides the inset on very small canvases', () => {
    view.destroy();
    restoreObserver();
    restoreObserver = installFixedResizeObserver(200, 110);
    view = new SectionView(root, state, results);
    results.set({ section: section() });
    runFrames(1);
    expect(fake.texts).not.toContain('Wing tilt');
  });
});

describe('SectionView animation', () => {
  it('animates only while visible, unpaused and with data', () => {
    expect(view.isAnimating()).toBe(false); // nothing to animate yet
    results.set({ section: section() });
    expect(view.isAnimating()).toBe(true);
    runFrames(3);
    expect(view.isAnimating()).toBe(true);

    state.set((s) => ({ ...s, view: { ...s.view, paused: true } }));
    expect(view.isAnimating()).toBe(false);
    const before = view.getClock().clock;
    runFrames(5);
    expect(view.getClock().clock).toBe(before);

    state.set((s) => ({ ...s, view: { ...s.view, paused: false } }));
    expect(view.isAnimating()).toBe(true);
  });

  it('stops when the page is hidden and resumes when it comes back', () => {
    results.set({ section: section() });
    expect(view.isAnimating()).toBe(true);
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(view.isAnimating()).toBe(false);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(view.isAnimating()).toBe(true);
  });

  it('stops when scrolled out of view', () => {
    view.destroy();
    let callback: IntersectionObserverCallback = () => {};
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    view = new SectionView(root, state, results);
    results.set({ section: section() });
    expect(view.isAnimating()).toBe(true);
    callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(view.isAnimating()).toBe(false);
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(view.isAnimating()).toBe(true);
  });

  it('advances the smoke clock with the playback speed', () => {
    results.set({ section: section() });
    view.advance(1, 1);
    const one = view.getClock().clock;
    expect(one).toBeGreaterThan(0.5);
    view.advance(1, 0.5);
    expect(view.getClock().clock - one).toBeCloseTo(one / 2, 9);
  });

  it('draws puffs every frame without redrawing the static layer', () => {
    results.set({ section: section() });
    runFrames(1);
    fake.reset();
    runFrames(3);
    expect(fake.counts.arc).toBeGreaterThan(100); // many smoke puffs
    expect(fake.counts.putImageData ?? 0).toBe(0);
    expect(fake.counts.drawImage).toBe(3); // just blitting the cached layer
  });
});

describe('SectionView timing pulse', () => {
  it('releases markers, labels them and finishes', () => {
    results.set({ section: section() });
    view.firePulse();
    expect(view.isPulseActive()).toBe(true);
    runFrames(1);
    expect(fake.texts).toContain('Same start, different arrival');
    expect(fake.texts).toContain('over the top');
    expect(fake.texts).toContain('underneath');

    for (let i = 0; i < 40; i++) view.advance(0.1, 1);
    expect(view.getClock().pulseAge).not.toBeNull();
    fake.reset();
    runFrames(1);
    expect(fake.texts).toContain('The air over the top gets there first.');

    for (let i = 0; i < 30; i++) view.advance(0.1, 1); // hold time passes
    expect(view.isPulseActive()).toBe(false);
  });

  it('is frozen while paused', () => {
    results.set({ section: section() });
    state.set((s) => ({ ...s, view: { ...s.view, paused: true } }));
    view.firePulse();
    expect(view.isPulseActive()).toBe(true);
    expect(view.isAnimating()).toBe(false);
    runFrames(5);
    expect(view.getClock().pulseAge).toBe(0);
  });

  it('does nothing without a section, and is dropped when the section changes', () => {
    view.firePulse();
    expect(view.isPulseActive()).toBe(false);
    results.set({ section: section() });
    view.firePulse();
    results.set({ section: section({ eta: 0.5 }) });
    expect(view.isPulseActive()).toBe(false);
  });

  it('can be started from the button', () => {
    results.set({ section: section() });
    root.querySelector<HTMLButtonElement>('.viz-button')!.click();
    expect(view.isPulseActive()).toBe(true);
  });
});

describe('SectionView lifecycle', () => {
  it('cleans up and ignores later updates', () => {
    results.set({ section: section() });
    expect(view.isAnimating()).toBe(true);
    view.destroy();
    expect(root.querySelector('.viz-section')).toBeNull();
    expect(view.isAnimating()).toBe(false);
    expect(() => results.set({ section: section({ eta: 0.9 }) })).not.toThrow();
    expect(() => state.set((s) => ({ ...s, view: { ...s.view, paused: true } }))).not.toThrow();
    view = new SectionView(root, state, results); // keep afterEach happy
  });
});
