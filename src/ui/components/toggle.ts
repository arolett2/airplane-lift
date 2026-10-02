/** Switch built on a native checkbox (`role="switch"`), with an optional help bubble. */
import { h, uid } from '../dom';
import type { Control } from './control';
import { createInfoPopover } from './infoPopover';
import type { InfoPopover } from './infoPopover';

export interface ToggleOptions {
  label: string;
  checked: boolean;
  /** Plain-language explanation shown in the "i" bubble. */
  help?: string;
  /** Written to the wrapper as `data-param`. */
  param?: string;
  onChange?(checked: boolean): void;
}

export interface ToggleControl extends Control<boolean> {
  readonly input: HTMLInputElement;
}

export function createToggle(options: ToggleOptions): ToggleControl {
  const id = uid('toggle');
  const input = h('input', {
    class: 'toggle__input',
    type: 'checkbox',
    role: 'switch',
    id,
  });
  input.checked = options.checked;

  const row = h(
    'label',
    { class: 'toggle__row', for: id },
    input,
    h(
      'span',
      { class: 'toggle__track', 'aria-hidden': 'true' },
      h('span', { class: 'toggle__thumb' }),
    ),
    h('span', { class: 'toggle__label' }, options.label),
  );

  let popover: InfoPopover | null = null;
  const el = h('div', { class: 'toggle', dataset: { param: options.param } }, row);
  if (options.help) {
    popover = createInfoPopover({ label: options.label, text: options.help });
    el.append(popover.el);
  }

  const controller = new AbortController();
  input.addEventListener('change', () => options.onChange?.(input.checked), {
    signal: controller.signal,
  });

  return {
    el,
    input,
    set(checked) {
      input.checked = checked;
    },
    destroy() {
      controller.abort();
      popover?.destroy();
    },
  };
}
