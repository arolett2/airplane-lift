/**
 * Button with an icon and, optionally, a visible text label. Icon-only buttons take their
 * accessible name from `label`. Passing `pressed` turns it into a toggle button (`aria-pressed`).
 */
import { h } from '../dom';
import type { Control } from './control';
import { icon } from './icons';
import type { IconName } from './icons';

export interface IconButtonOptions {
  icon: IconName;
  /** Accessible name; also the tooltip. */
  label: string;
  /** Visible text next to the icon (the icon-only look is used when omitted). */
  text?: string;
  variant?: 'ghost' | 'solid' | 'accent';
  /** Initial pressed state; presence makes this a toggle button. */
  pressed?: boolean;
  /** Extra class names. */
  class?: string;
  onClick?(event: MouseEvent): void;
}

export interface IconButtonControl extends Control<boolean, HTMLButtonElement> {
  /** Change the accessible name / visible text. */
  setLabel(label: string, text?: string): void;
  setDisabled(disabled: boolean): void;
}

export function createIconButton(options: IconButtonOptions): IconButtonControl {
  const textEl =
    options.text !== undefined ? h('span', { class: 'btn__text' }, options.text) : null;
  const el = h(
    'button',
    {
      class: `btn btn--${options.variant ?? 'ghost'}${textEl ? ' btn--with-text' : ' btn--icon'}${options.class ? ` ${options.class}` : ''}`,
      type: 'button',
      'aria-label': options.label,
      title: options.label,
      'aria-pressed': options.pressed === undefined ? null : String(options.pressed),
    },
    icon(options.icon, 18),
    textEl,
  );

  const controller = new AbortController();
  if (options.onClick) el.addEventListener('click', options.onClick, { signal: controller.signal });

  return {
    el,
    set(pressed) {
      el.setAttribute('aria-pressed', String(pressed));
    },
    setLabel(label, text) {
      el.setAttribute('aria-label', label);
      el.title = label;
      if (textEl && text !== undefined) textEl.textContent = text;
    },
    setDisabled(disabled) {
      el.disabled = disabled;
    },
    destroy: () => controller.abort(),
  };
}
