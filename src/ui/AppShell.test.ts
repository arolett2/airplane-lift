// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE } from '../state/params';
import type { AppState } from '../state/params';
import { Store } from '../state/store';
import { createAppShell } from './AppShell';
import type { AppShell } from './AppShell';
import { TopBar } from './panels/TopBar';

let root: HTMLElement;
let shell: AppShell;

const shellEl = () => root.querySelector<HTMLElement>('.shell')!;

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  root = document.createElement('div');
  root.textContent = 'Wind tunnel loading…';
  document.body.append(root);
  shell = createAppShell(root);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAppShell slots', () => {
  it('replaces the loading text with eight distinct, attached slots', () => {
    expect(root.textContent).not.toContain('loading');
    const slots = [
      shell.viewport,
      shell.topBar,
      shell.controls,
      shell.readouts,
      shell.charts,
      shell.section,
      shell.lesson,
      shell.compare,
    ];
    expect(new Set(slots).size).toBe(8);
    for (const slot of slots) {
      expect(slot).toBeInstanceOf(HTMLElement);
      expect(root.contains(slot)).toBe(true);
    }
  });

  it('uses landmarks and puts the three result slots in collapsible cards', () => {
    expect(shell.viewport.tagName).toBe('MAIN');
    expect(shell.topBar.tagName).toBe('HEADER');
    expect(root.querySelectorAll('aside')).toHaveLength(2);
    const cards = [...root.querySelectorAll<HTMLElement>('.card')];
    expect(cards.map((c) => c.dataset.card)).toEqual(['numbers', 'section', 'charts']);
    expect(shell.readouts.closest('.card')).toBe(cards[0]);
    expect(shell.section.closest('.card')).toBe(cards[1]);
    expect(shell.charts.closest('.card')).toBe(cards[2]);
    expect(shell.controls.closest('#panel-left')).not.toBeNull();
  });

  it('lets a result card collapse and expand', () => {
    const button = root.querySelector<HTMLButtonElement>('.card .collapsible__button')!;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('has a phone tab bar with the four tabs', () => {
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('.shell__tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Controls', 'Numbers', 'Section', 'Charts']);
  });
});

describe('createAppShell behaviour', () => {
  it('setBusy toggles the busy marker', () => {
    expect(shellEl().dataset.busy).toBe('false');
    shell.setBusy(true);
    expect(shellEl().dataset.busy).toBe('true');
    expect(shell.viewport.getAttribute('aria-busy')).toBe('true');
    shell.setBusy(false);
    expect(shellEl().dataset.busy).toBe('false');
  });

  it('shows toasts in a live region and removes them after a while', () => {
    vi.useFakeTimers();
    shell.toast('Link copied');
    const region = root.querySelector('.shell__toasts')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('Link copied');
    vi.advanceTimersByTime(3700);
    expect(region.querySelector('.toast')?.classList.contains('is-leaving')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(region.children).toHaveLength(0);
  });

  it('keeps at most three toasts', () => {
    for (let i = 0; i < 5; i++) shell.toast(`m${i}`);
    const texts = [...root.querySelectorAll('.toast')].map((t) => t.textContent);
    expect(texts).toEqual(['m2', 'm3', 'm4']);
  });

  it('shows toasts requested by child components through the shell:toast event', () => {
    shell.topBar.dispatchEvent(new CustomEvent('shell:toast', { detail: 'Hello', bubbles: true }));
    expect(root.querySelector('.toast')?.textContent).toBe('Hello');
  });

  it('switches phone tabs and collapses the sheet on a second tap', () => {
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('.shell__tab')];
    expect(shellEl().dataset.sheet).toBe('closed');
    tabs[1]!.click();
    expect(shellEl().dataset.sheet).toBe('open');
    expect(shellEl().dataset.tab).toBe('numbers');
    expect(tabs[1]!.getAttribute('aria-pressed')).toBe('true');
    tabs[2]!.click();
    expect(shellEl().dataset.tab).toBe('section');
    expect(tabs[1]!.getAttribute('aria-pressed')).toBe('false');
    tabs[2]!.click();
    expect(shellEl().dataset.sheet).toBe('closed');
    expect(tabs[2]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('closes drawers and the sheet on Escape and on a scrim click', () => {
    shellEl().dataset.panel = 'left';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shellEl().dataset.panel).toBe('none');

    shellEl().dataset.panel = 'right';
    root.querySelector<HTMLElement>('.shell__scrim')!.click();
    expect(shellEl().dataset.panel).toBe('none');

    root.querySelectorAll<HTMLButtonElement>('.shell__tab')[0]!.click();
    expect(shellEl().dataset.sheet).toBe('open');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shellEl().dataset.sheet).toBe('closed');
  });

  it('works with the real top bar: panel toggles drive the drawers', () => {
    const store = new Store<AppState>(DEFAULT_STATE);
    const bar = new TopBar(shell.topBar, store, {
      onPulse() {},
      onOpenLessons() {},
      onOpenCompare() {},
    });
    shell.topBar.querySelector<HTMLButtonElement>('.topbar__panel-toggle--left')!.click();
    expect(shellEl().dataset.panel).toBe('left');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shellEl().dataset.panel).toBe('none');
    bar.destroy();
  });

  it('destroy removes everything', () => {
    shell.destroy();
    expect(root.children).toHaveLength(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
});

describe('view insets', () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect;

  it('reports how much of the viewport the floating panels cover', () => {
    const rects = new Map<Element, DOMRect>([
      [shell.viewport, rect(0, 0, 1440, 900)],
      [shell.topBar, rect(12, 12, 1416, 52)],
      [root.querySelector('#panel-left')!, rect(12, 76, 320, 800)],
      [root.querySelector('#panel-right')!, rect(1068, 76, 360, 800)],
    ]);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return rects.get(this) ?? rect(0, 0, 0, 0);
    });
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      return (rects.has(this) ? [rects.get(this)] : []) as unknown as DOMRectList;
    });
    expect(shell.getViewInsets()).toEqual({ top: 64, right: 372, bottom: 0, left: 332 });
  });

  it('notifies listeners once per frame and stops after unsubscribe', async () => {
    const seen: unknown[] = [];
    const off = shell.onViewInsetsChange((insets) => seen.push(insets));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(seen).toHaveLength(1);
    off();
    shellEl().dataset.panel = 'left';
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(seen).toHaveLength(1);
  });
});
