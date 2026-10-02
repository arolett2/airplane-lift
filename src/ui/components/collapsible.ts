/**
 * Collapsible section: a heading button that shows/hides its body. The open state can be
 * remembered across visits (localStorage, best effort) via `storageKey`.
 *
 * Closed content is `inert` so it cannot be tabbed into, and the height animation is a CSS
 * grid-rows transition that `prefers-reduced-motion` switches off.
 */
import { h, readStored, uid, writeStored } from '../dom';
import type { Control } from './control';
import { icon } from './icons';
import type { IconName } from './icons';

export interface CollapsibleOptions {
  title: string;
  /** Initial state when nothing is remembered. Default true. */
  open?: boolean;
  /** Leading icon in the header. */
  icon?: IconName;
  /** Remember the open state under this key. */
  storageKey?: string;
  /** Heading level for the title, 2..4. Default 3. */
  level?: 2 | 3 | 4;
  /** Extra class on the root (e.g. 'card'). */
  class?: string;
  /** Written to the root as `data-card`. */
  card?: string;
  onToggle?(open: boolean): void;
}

export interface CollapsibleControl extends Control<boolean> {
  /** Put your content here. */
  readonly body: HTMLElement;
  readonly header: HTMLElement;
  readonly button: HTMLButtonElement;
  isOpen(): boolean;
  /**
   * Keep the content visible regardless of the user's open/closed choice (used when the layout
   * has no room for collapsing, e.g. a bottom-sheet tab). The remembered choice is untouched.
   */
  setForceOpen(on: boolean): void;
}

const STORAGE_PREFIX = 'wt.open.';

export function createCollapsible(options: CollapsibleOptions): CollapsibleControl {
  const bodyId = uid('collapsible-body');
  let open = options.open ?? true;
  if (options.storageKey) {
    const saved = readStored(STORAGE_PREFIX + options.storageKey);
    if (saved === '1') open = true;
    else if (saved === '0') open = false;
  }
  let forced = false;

  const button = h(
    'button',
    { class: 'collapsible__button', type: 'button', 'aria-controls': bodyId },
    options.icon ? h('span', { class: 'collapsible__icon' }, icon(options.icon, 18)) : null,
    h('span', { class: 'collapsible__title' }, options.title),
    h('span', { class: 'collapsible__chevron' }, icon('chevron', 18)),
  );
  const headingTag = ({ 2: 'h2', 3: 'h3', 4: 'h4' } as const)[options.level ?? 3];
  const header = h(headingTag, { class: 'collapsible__header' }, button);

  const body = h('div', { class: 'collapsible__body' });
  const clip = h(
    'div',
    { class: 'collapsible__clip', id: bodyId, role: 'region', 'aria-label': options.title },
    body,
  );
  const wrap = h('div', { class: 'collapsible__content' }, clip);

  const el = h(
    'section',
    {
      class: `collapsible${options.class ? ` ${options.class}` : ''}`,
      dataset: { card: options.card },
    },
    header,
    wrap,
  );

  const render = () => {
    const visible = open || forced;
    el.classList.toggle('is-open', visible);
    button.setAttribute('aria-expanded', String(visible));
    clip.toggleAttribute('inert', !visible);
  };
  render();

  const setOpen = (next: boolean, notify: boolean) => {
    if (next === open) return;
    open = next;
    if (options.storageKey) writeStored(STORAGE_PREFIX + options.storageKey, open ? '1' : '0');
    render();
    if (notify) options.onToggle?.(open);
  };

  const controller = new AbortController();
  button.addEventListener(
    'click',
    () => {
      if (!forced) setOpen(!open, true);
    },
    { signal: controller.signal },
  );

  return {
    el,
    body,
    header,
    button,
    set: (value) => setOpen(value, false),
    isOpen: () => open || forced,
    setForceOpen(on) {
      forced = on;
      render();
    },
    destroy: () => controller.abort(),
  };
}
