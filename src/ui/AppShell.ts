/**
 * Application shell: the full-viewport layout and the slots other modules render into.
 *
 *   >= 1100px   3D viewport full-bleed; controls card on the left (320px), results cards on the
 *               right (360px), floating over the viewport; lesson card bottom-centre.
 *   700-1099px  the two panels become slide-in drawers toggled from the top bar.
 *   < 700px     both become one bottom sheet with tabs (Controls / Numbers / Section / Charts).
 *
 * Layout is pure CSS driven by `data-*` attributes on the root `.shell` element:
 *   data-panel  "none" | "left" | "right"   which drawer is open (drawer layout)
 *   data-sheet  "closed" | "open"           bottom sheet state (phone layout)
 *   data-tab    "controls" | "numbers" | "charts" | "section"   sheet tab
 *   data-busy   "true" | "false"            physics is computing
 */
import { createCollapsible } from './components/collapsible';
import type { CollapsibleControl } from './components/collapsible';
import { icon } from './components/icons';
import type { IconName } from './components/icons';
import { Disposables, h } from './dom';
import { TOAST_EVENT } from './panels/TopBar';
import './styles/tokens.css';
import './styles/main.css';
import './styles/components.css';
import './styles/panels.css';

export interface ShellSlots {
  viewport: HTMLElement; // full-bleed 3D canvas container
  topBar: HTMLElement;
  controls: HTMLElement; // left panel
  readouts: HTMLElement; // right column, top
  charts: HTMLElement; // right column, bottom
  section: HTMLElement; // right column, middle: the 2D cross-section view
  lesson: HTMLElement; // bottom-centre overlay card
  compare: HTMLElement; // modal / drawer host
}

export interface AppShell extends ShellSlots {
  /** Show or hide the subtle "computing" shimmer along the top edge. */
  setBusy(on: boolean): void;
  /** Show a short message that fades away by itself. */
  toast(message: string): void;
  /** Remove the shell and every listener it added. */
  destroy(): void;
}

type SheetTab = 'controls' | 'numbers' | 'charts' | 'section';

const TABS: { id: SheetTab; label: string; icon: IconName }[] = [
  { id: 'controls', label: 'Controls', icon: 'sliders' },
  { id: 'numbers', label: 'Numbers', icon: 'numbers' },
  { id: 'section', label: 'Section', icon: 'section' },
  { id: 'charts', label: 'Charts', icon: 'charts' },
];

/** Width below which the layout is a bottom sheet with tabs. */
const PHONE_QUERY = '(max-width: 699.98px)';
/** Width below which the panels are drawers. */
const DRAWER_QUERY = '(max-width: 1099.98px)';

const TOAST_MS = 3600;
const TOAST_EXIT_MS = 260;
const MAX_TOASTS = 3;

export function createAppShell(root: HTMLElement): AppShell {
  const disposables = new Disposables();

  const viewport = h('main', { class: 'shell__viewport', 'aria-label': '3D wind tunnel view' });
  const topBar = h('header', { class: 'shell__topbar' });
  const lesson = h('section', { class: 'shell__lesson', 'aria-label': 'Lesson' });
  const compare = h('div', { class: 'shell__compare' });
  const busy = h('div', { class: 'shell__busy', 'aria-hidden': 'true' });
  const scrim = h('div', { class: 'shell__scrim', 'aria-hidden': 'true' });
  const toasts = h('div', {
    class: 'shell__toasts',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'false',
  });

  // Left panel -------------------------------------------------------------------------------
  const controls = h('div', { class: 'panel__content' });
  const left = h(
    'aside',
    { class: 'panel panel--left', id: 'panel-left', 'aria-label': 'Controls', tabindex: -1 },
    controls,
  );

  // Right column: three collapsible cards -----------------------------------------------------
  const cards: CollapsibleControl[] = [];
  const makeCard = (id: 'numbers' | 'charts' | 'section', title: string, iconName: IconName) => {
    const card = createCollapsible({
      title,
      icon: iconName,
      level: 2,
      storageKey: `card.${id}`,
      class: 'card',
      card: id,
    });
    card.body.classList.add('card__body');
    cards.push(card);
    return card;
  };
  const numbersCard = makeCard('numbers', 'Numbers', 'numbers');
  const chartsCard = makeCard('charts', 'Charts', 'charts');
  const sectionCard = makeCard('section', 'Cross-section', 'section');
  const right = h(
    'aside',
    { class: 'panel panel--right', id: 'panel-right', 'aria-label': 'Results', tabindex: -1 },
    numbersCard.el,
    sectionCard.el,
    chartsCard.el,
  );

  // Bottom-sheet tab bar (phone layout only; hidden by CSS otherwise) ---------------------------
  const tabButtons = new Map<SheetTab, HTMLButtonElement>();
  const tabBar = h('nav', { class: 'shell__tabs', 'aria-label': 'Panels' });
  for (const tab of TABS) {
    const button = h(
      'button',
      { class: 'shell__tab', type: 'button', 'aria-pressed': 'false' },
      icon(tab.icon, 18),
      h('span', null, tab.label),
    );
    tabButtons.set(tab.id, button);
    tabBar.append(button);
  }

  const panels = h('div', { class: 'shell__panels' }, tabBar, left, right);

  const shell = h(
    'div',
    {
      class: 'shell',
      dataset: { shell: true, panel: 'none', sheet: 'closed', tab: 'controls', busy: 'false' },
    },
    viewport,
    busy,
    topBar,
    scrim,
    panels,
    lesson,
    compare,
    toasts,
  );
  root.replaceChildren(shell);

  // State helpers ----------------------------------------------------------------------------
  const closePanels = () => {
    shell.dataset.panel = 'none';
    shell.dataset.sheet = 'closed';
  };

  const syncTabs = () => {
    const open = shell.dataset.sheet === 'open';
    for (const [id, button] of tabButtons) {
      button.setAttribute('aria-pressed', String(open && shell.dataset.tab === id));
    }
  };
  syncTabs();

  for (const [id, button] of tabButtons) {
    disposables.listen(button, 'click', () => {
      const open = shell.dataset.sheet === 'open';
      if (open && shell.dataset.tab === id) {
        shell.dataset.sheet = 'closed';
      } else {
        shell.dataset.tab = id;
        shell.dataset.sheet = 'open';
      }
      syncTabs();
    });
  }

  disposables.listen(scrim, 'click', closePanels);
  disposables.listen(document, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (shell.dataset.panel !== 'none' || shell.dataset.sheet === 'open') {
      closePanels();
      syncTabs();
    }
  });

  // Move focus into a drawer when it opens so keyboard users land inside it.
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
      const panel = shell.dataset.panel;
      if (!window.matchMedia?.(DRAWER_QUERY).matches) return;
      if (panel === 'left') left.focus({ preventScroll: true });
      else if (panel === 'right') right.focus({ preventScroll: true });
    });
    observer.observe(shell, { attributes: true, attributeFilter: ['data-panel'] });
    disposables.add(() => observer.disconnect());
    const sheetObserver = new MutationObserver(syncTabs);
    sheetObserver.observe(shell, { attributes: true, attributeFilter: ['data-sheet', 'data-tab'] });
    disposables.add(() => sheetObserver.disconnect());
  }

  // Layout changes: in the phone layout cards cannot be collapsed (tabs replace that), and any
  // open drawer / sheet is dismissed when the layout switches.
  if (typeof matchMedia === 'function') {
    const phone = matchMedia(PHONE_QUERY);
    const applyLayout = () => {
      for (const card of cards) card.setForceOpen(phone.matches);
    };
    applyLayout();
    const onChange = () => {
      applyLayout();
      closePanels();
      syncTabs();
    };
    phone.addEventListener?.('change', onChange);
    disposables.add(() => phone.removeEventListener?.('change', onChange));
    const drawer = matchMedia(DRAWER_QUERY);
    drawer.addEventListener?.('change', onChange);
    disposables.add(() => drawer.removeEventListener?.('change', onChange));
  }

  // Toasts -----------------------------------------------------------------------------------
  const toastTimers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      toastTimers.delete(t);
      fn();
    }, ms);
    toastTimers.add(t);
  };

  const toast = (message: string) => {
    const el = h('div', { class: 'toast' }, message);
    toasts.append(el);
    while (toasts.children.length > MAX_TOASTS) toasts.firstElementChild?.remove();
    later(() => {
      el.classList.add('is-leaving');
      later(() => el.remove(), TOAST_EXIT_MS);
    }, TOAST_MS);
  };
  disposables.listen(shell, TOAST_EVENT, (e) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (typeof detail === 'string') toast(detail);
  });

  return {
    viewport,
    topBar,
    controls,
    readouts: numbersCard.body,
    charts: chartsCard.body,
    section: sectionCard.body,
    lesson,
    compare,
    setBusy(on) {
      shell.dataset.busy = String(on);
      viewport.setAttribute('aria-busy', String(on));
    },
    toast,
    destroy() {
      disposables.dispose();
      for (const t of toastTimers) clearTimeout(t);
      toastTimers.clear();
      for (const card of cards) card.destroy();
      root.replaceChildren();
    },
  };
}
