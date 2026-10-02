/**
 * A small "i" button that explains something in plain language. Opens on hover (mouse), focus
 * + Enter/Space, or tap; closes on Escape, outside click or scroll.
 *
 * The bubble is appended to <body> while open and positioned with `position: fixed`, so it is
 * never clipped by a scrolling panel and works inside translucent (backdrop-filter) cards.
 */
import { clamp, h, uid } from '../dom';
import { icon } from './icons';

export interface InfoPopoverOptions {
  /** What the help is about; used in the button's accessible name ("About Airspeed"). */
  label: string;
  /** The explanation. */
  text: string;
}

export interface InfoPopover {
  readonly el: HTMLButtonElement;
  close(): void;
  destroy(): void;
}

/** Only one bubble is open at a time. */
let activeClose: (() => void) | null = null;

const BUBBLE_WIDTH = 264;
const MARGIN = 8;

export function createInfoPopover(options: InfoPopoverOptions): InfoPopover {
  const bubbleId = uid('info');
  const button = h(
    'button',
    {
      class: 'info-btn',
      type: 'button',
      'aria-label': `About ${options.label}`,
      'aria-expanded': 'false',
    },
    icon('info', 14),
  );

  let bubble: HTMLElement | null = null;
  let pinned = false;
  /** Listeners that only matter while the bubble is open. */
  let openListeners: AbortController | null = null;
  const controller = new AbortController();
  const { signal } = controller;

  const position = () => {
    if (!bubble) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(BUBBLE_WIDTH, window.innerWidth - 2 * MARGIN);
    const left = clamp(
      rect.left + rect.width / 2 - width / 2,
      MARGIN,
      Math.max(MARGIN, window.innerWidth - width - MARGIN),
    );
    bubble.style.width = `${width}px`;
    bubble.style.left = `${left}px`;
    const height = bubble.offsetHeight;
    const below = rect.bottom + 8;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    const top = fitsBelow || rect.top - height - 8 < MARGIN ? below : rect.top - height - 8;
    bubble.style.top = `${Math.max(MARGIN, top)}px`;
  };

  const close = () => {
    pinned = false;
    if (!bubble) return;
    bubble.remove();
    bubble = null;
    openListeners?.abort();
    openListeners = null;
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-controls');
    if (activeClose === close) activeClose = null;
  };

  const open = () => {
    if (bubble) return;
    activeClose?.();
    bubble = h('div', { class: 'popover-bubble', id: bubbleId, role: 'note' }, options.text);
    document.body.append(bubble);
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', bubbleId);
    activeClose = close;
    position();

    // Outside tap, Escape anywhere, scrolling and resizing all dismiss the bubble.
    openListeners = new AbortController();
    const opts = { signal: openListeners.signal };
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target instanceof Node && !button.contains(e.target)) close();
      },
      opts,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') close();
      },
      opts,
    );
    window.addEventListener('scroll', close, { ...opts, capture: true, passive: true });
    window.addEventListener('resize', close, opts);
  };

  button.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      if (bubble && pinned) {
        close();
      } else {
        open();
        pinned = true;
      }
    },
    { signal },
  );
  button.addEventListener(
    'pointerenter',
    (e) => {
      if (e.pointerType === 'mouse') open();
    },
    { signal },
  );
  button.addEventListener(
    'pointerleave',
    (e) => {
      if (e.pointerType === 'mouse' && !pinned) close();
    },
    { signal },
  );
  button.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && bubble) {
        e.stopPropagation();
        close();
      }
    },
    { signal },
  );
  return {
    el: button,
    close,
    destroy() {
      close();
      controller.abort();
    },
  };
}
