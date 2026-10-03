/**
 * Tiny DOM helpers shared by the vanilla-TypeScript UI. No framework: elements are created
 * once and updated in place, so dragging a slider never rebuilds the page.
 */

type Primitive = string | number | boolean | null | undefined;

/** Event handlers by name, typed from the DOM event map: `on: { click: (e) => ... }`. */
export type Handlers = {
  [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
};

export interface ElProps {
  /** CSS class string. */
  class?: string | null | false;
  /** Inline styles. Keys starting with `--` set custom properties. */
  style?: Record<string, string | number>;
  /** `data-*` attributes, written as camelCase keys (`paramName` -> `data-param-name`). */
  dataset?: Record<string, string | number | boolean | null | undefined>;
  on?: Handlers;
  /** Any other key is set as an attribute: `true` -> empty attribute, false/null/undefined skipped. */
  [attribute: string]:
    | Primitive
    | Record<string, string | number>
    | Record<string, string | number | boolean | null | undefined>
    | Handlers;
}

export type Child = Node | string | number | false | null | undefined;

function applyProps(el: Element, props: ElProps | null | undefined): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      el.setAttribute('class', String(value));
    } else if (key === 'style') {
      const target = (el as HTMLElement | SVGElement).style;
      for (const [name, v] of Object.entries(value as Record<string, string | number>)) {
        if (name.startsWith('--')) target.setProperty(name, String(v));
        else
          target.setProperty(
            name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
            String(v),
          );
      }
    } else if (key === 'dataset') {
      for (const [name, v] of Object.entries(value as Record<string, Primitive>)) {
        if (v === undefined || v === null || v === false) continue;
        el.setAttribute(`data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(v));
      }
    } else if (key === 'on') {
      for (const [type, handler] of Object.entries(value as Handlers)) {
        if (handler) el.addEventListener(type, handler as EventListener);
      }
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function appendChildren(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }
}

/** Create an HTML element: `h('button', { class: 'btn', type: 'button', on: { click } }, 'Go')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element in the SVG namespace. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

let uidCounter = 0;
/** Unique, stable-per-session element id: `uid('slider')` -> "slider-12". */
export function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Remove all children of an element. */
export function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Show or hide an element with the `hidden` attribute (styled `display: none !important`). */
export function setHidden(el: HTMLElement | SVGElement, hidden: boolean): void {
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

/* ------------------------------------------------------------------------------------------ */
/* Cleanup                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Collects cleanup callbacks so `destroy()` is one line. Disposal runs in reverse order. */
export class Disposables {
  private readonly fns: (() => void)[] = [];

  add(fn: () => void): void {
    this.fns.push(fn);
  }

  /** addEventListener that is automatically removed on dispose. */
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    handler: (event: never) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler as EventListener, options);
    this.fns.push(() => target.removeEventListener(type, handler as EventListener, options));
  }

  dispose(): void {
    for (let i = this.fns.length - 1; i >= 0; i--) this.fns[i]!();
    this.fns.length = 0;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Frame throttle                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface FrameThrottle<T> {
  /** Remember the latest value; it is applied at most once per animation frame. */
  push(value: T): void;
  /** Apply the pending value right now (e.g. when a drag ends). No-op when nothing is pending. */
  flush(): void;
  /** Drop the pending value. */
  cancel(): void;
  readonly pending: boolean;
}

const nextFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;
const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (h2) => cancelAnimationFrame(h2)
    : (h2) => clearTimeout(h2);

/**
 * Coalesce rapid updates (a dragged slider fires `input` many times per frame) so the store,
 * and therefore the physics worker, is written at most once per animation frame.
 */
export function createFrameThrottle<T>(apply: (value: T) => void): FrameThrottle<T> {
  let latest: T | undefined;
  let has = false;
  let handle: number | null = null;

  const run = () => {
    if (handle !== null) {
      cancelFrame(handle);
      handle = null;
    }
    if (!has) return;
    const value = latest as T;
    has = false;
    latest = undefined;
    apply(value);
  };

  return {
    push(value) {
      latest = value;
      has = true;
      handle ??= nextFrame(() => {
        handle = null;
        run();
      });
    },
    flush: run,
    cancel() {
      if (handle !== null) cancelFrame(handle);
      handle = null;
      has = false;
      latest = undefined;
    },
    get pending() {
      return has;
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Storage                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** localStorage read that never throws (private windows, blocked storage). */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference simply is not remembered */
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Misc                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** True when the person asked the OS to minimise motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scroll `el` into view inside its nearest scrollable panel ONLY — never the page or the app
 * shell. Does nothing when that panel is not on screen (e.g. a closed drawer or bottom sheet),
 * which is exactly when the browser's own scrollIntoView would drag the whole app off-screen.
 */
export function scrollWithinPanel(el: HTMLElement, smooth = false): void {
  let panel = el.parentElement;
  while (panel) {
    const style = getComputedStyle(panel);
    if (/(auto|scroll)/.test(style.overflowY) && panel.scrollHeight > panel.clientHeight) break;
    panel = panel.parentElement;
  }
  if (!panel || panel === document.body || panel === document.documentElement) return;
  const box = panel.getBoundingClientRect();
  const onScreen =
    box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
  if (!onScreen) return;
  const r = el.getBoundingClientRect();
  let delta = 0;
  if (r.top < box.top) delta = r.top - box.top - 8;
  else if (r.bottom > box.bottom) delta = Math.min(r.bottom - box.bottom + 8, r.top - box.top - 8);
  if (delta === 0) return;
  panel.scrollTo({ top: panel.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
}

/** Keep a full-viewport container pinned: programmatic scrolls of it are undone at once. */
export function pinScroll(el: HTMLElement | Element): () => void {
  const reset = () => {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  };
  el.addEventListener('scroll', reset);
  return () => el.removeEventListener('scroll', reset);
}
