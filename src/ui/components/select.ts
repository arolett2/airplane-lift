/** Native `<select>` with optional groups and a placeholder shown when no option matches. */
import { h, uid } from '../dom';
import type { Control } from './control';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectGroup {
  /** Group heading (rendered as an `<optgroup>`); omit for a flat list. */
  label?: string;
  options: readonly SelectOption[];
}

export interface SelectOptions {
  label: string;
  groups: readonly SelectGroup[];
  value: string;
  /**
   * Text of a disabled first option shown while `value` matches nothing (e.g. "Custom").
   * Without it an unmatched value leaves the select on its first real option.
   */
  placeholder?: string;
  hideLabel?: boolean;
  /** Written to the wrapper as `data-param`. */
  param?: string;
  onChange?(value: string): void;
}

export interface SelectControl extends Control<string> {
  readonly select: HTMLSelectElement;
}

export function createSelect(options: SelectOptions): SelectControl {
  const id = uid('select');
  const select = h('select', { class: 'select__input', id });

  const known = new Set<string>();
  if (options.placeholder !== undefined) {
    select.append(h('option', { value: '', disabled: true }, options.placeholder));
  }
  for (const group of options.groups) {
    const parent = group.label ? h('optgroup', { label: group.label }) : select;
    for (const opt of group.options) {
      known.add(opt.value);
      parent.append(h('option', { value: opt.value }, opt.label));
    }
    if (parent !== select) select.append(parent);
  }

  const show = (value: string) => {
    select.value = known.has(value) ? value : options.placeholder !== undefined ? '' : select.value;
  };
  show(options.value);

  const el = h(
    'div',
    { class: 'field select', dataset: { param: options.param } },
    h('label', { class: options.hideLabel ? 'sr-only' : 'field__label', for: id }, options.label),
    h('div', { class: 'select__wrap' }, select),
  );

  const controller = new AbortController();
  select.addEventListener('change', () => options.onChange?.(select.value), {
    signal: controller.signal,
  });

  return { el, select, set: show, destroy: () => controller.abort() };
}
