// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE } from '../../state/params';
import type { AppState } from '../../state/params';
import { Store } from '../../state/store';
import { decodeState } from '../urlState';
import { TOAST_EVENT, TOP_BAR_TITLE, TopBar } from './TopBar';

let shell: HTMLElement;
let host: HTMLElement;
let store: Store<AppState>;
const actions = { onPulse: vi.fn(), onOpenLessons: vi.fn(), onOpenCompare: vi.fn() };

function setup() {
  shell = document.createElement('div');
  shell.dataset.shell = 'true';
  shell.dataset.panel = 'none';
  host = document.createElement('header');
  shell.append(host);
  document.body.append(shell);
  store = new Store<AppState>(DEFAULT_STATE);
  return new TopBar(host, store, actions);
}

const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.getAttribute('aria-label')?.toLowerCase().includes(name.toLowerCase()),
  )!;

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TopBar', () => {
  it('renders the title as the page heading', () => {
    setup();
    const h1 = host.querySelector('h1');
    expect(h1?.textContent).toBe('Wind Tunnel — How Wings Lift');
    expect(TOP_BAR_TITLE).toBe('Wind Tunnel — How Wings Lift');
  });

  it('runs the lessons, compare and pulse actions', () => {
    setup();
    button('lessons').click();
    button('compare').click();
    button('smoke pulse').click();
    expect(actions.onOpenLessons).toHaveBeenCalledTimes(1);
    expect(actions.onOpenCompare).toHaveBeenCalledTimes(1);
    expect(actions.onPulse).toHaveBeenCalledTimes(1);
  });

  it('writes the camera shot to view.camera and follows external changes', () => {
    setup();
    const select = host.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('overview');
    expect([...select.options].map((o) => o.value)).toEqual([
      'overview',
      'side',
      'front',
      'top',
      'tip',
      'behind',
      'section',
    ]);
    select.value = 'tip';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().view.camera).toBe('tip');
    store.set((s) => ({ ...s, view: { ...s.view, camera: 'side' } }));
    expect(select.value).toBe('side');
  });

  it('copies a link that restores the current state and announces it', async () => {
    setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const toast = vi.fn();
    shell.addEventListener(TOAST_EVENT, (e) => toast((e as CustomEvent<string>).detail));
    store.set((s) => ({ ...s, flow: { ...s.flow, alphaDeg: 11 } }));

    button('copy a link').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const url = writeText.mock.calls[0]![0] as string;
    expect(url.startsWith(location.href.split('#')[0]!)).toBe(true);
    const hash = url.slice(url.indexOf('#'));
    expect(decodeState(hash, DEFAULT_STATE).flow.alphaDeg).toBe(11);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0]![0]).toContain('copied');
    expect(host.textContent).toContain('Copied');
  });

  it('falls back gracefully when the clipboard is unavailable', async () => {
    setup();
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const toast = vi.fn();
    shell.addEventListener(TOAST_EVENT, (e) => toast((e as CustomEvent<string>).detail));
    button('copy a link').click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  });

  it('toggles the drawers through the shell data-panel attribute', async () => {
    setup();
    const controls = host.querySelector<HTMLButtonElement>('.topbar__panel-toggle--left')!;
    const results = host.querySelector<HTMLButtonElement>('.topbar__panel-toggle--right')!;
    controls.click();
    expect(shell.dataset.panel).toBe('left');
    await vi.waitFor(() => expect(controls.getAttribute('aria-expanded')).toBe('true'));
    results.click();
    expect(shell.dataset.panel).toBe('right');
    await vi.waitFor(() => expect(controls.getAttribute('aria-expanded')).toBe('false'));
    expect(results.getAttribute('aria-expanded')).toBe('true');
    results.click();
    expect(shell.dataset.panel).toBe('none');
    // an outside change (scrim click, Escape) is reflected too
    shell.dataset.panel = 'left';
    await vi.waitFor(() => expect(controls.getAttribute('aria-expanded')).toBe('true'));
  });

  it('works without a shell ancestor', () => {
    const lone = document.createElement('header');
    document.body.append(lone);
    const bar = new TopBar(lone, new Store<AppState>(DEFAULT_STATE), actions);
    const toggle = lone.querySelector<HTMLButtonElement>('.topbar__panel-toggle--left')!;
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    bar.destroy();
    expect(lone.children).toHaveLength(0);
  });
});
