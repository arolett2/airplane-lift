/**
 * Segmented control: a row of mutually exclusive choices, built on native radio inputs so
 * arrow keys, focus and screen-reader semantics come for free.
 */
import { h, uid } from '../dom';
import type { Control } from './control';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Longer explanation, shown as a tooltip. */
  title?: string;
}

export interface SegmentedOptions<T extends string> {
  /** Visible heading above the control (also its accessible name). */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  /** Hide the visible heading but keep it as the accessible name. */
  hideLabel?: boolean;
  /** Written to the wrapper as `data-param`. */
  param?: string;
  onChange?(value: T): void;
}

export function createSegmented<T extends string>(options: SegmentedOptions<T>): Control<T> {
  const name = uid('seg');
  const labelId = uid('seg-label');
  const radios = new Map<T, HTMLInputElement>();

  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': labelId });
  for (const opt of options.options) {
    const input = h('input', {
      class: 'segmented__input',
      type: 'radio',
      name,
      value: opt.value,
    });
    radios.set(opt.value, input);
    group.append(
      h(
        'label',
        { class: 'segmented__option', title: opt.title },
        input,
        h('span', { class: 'segmented__text' }, opt.label),
      ),
    );
  }

  const el = h(
    'div',
    { class: 'field', dataset: { param: options.param } },
    h('div', { class: options.hideLabel ? 'sr-only' : 'field__label', id: labelId }, options.label),
    group,
  );

  const select = (value: T | null) => {
    for (const [v, input] of radios) input.checked = v === value;
  };
  select(options.value);

  const controller = new AbortController();
  group.addEventListener(
    'change',
    (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement && target.checked) {
        options.onChange?.(target.value as T);
      }
    },
    { signal: controller.signal },
  );

  return {
    el,
    set: select,
    destroy: () => controller.abort(),
  };
}
