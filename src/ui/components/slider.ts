/**
 * Labelled slider with a typed value, unit conversion and a help bubble.
 *
 * - The native `<input type="range">` works in SI units; the number shown (and typed) is in the
 *   chosen unit system, converted via shared/units.
 * - `onInput` fires continuously while dragging (callers should throttle store writes);
 *   `onCommit` fires when a drag ends, a key press settles, or a value is typed.
 * - Double-click the track or label (or press Delete/Backspace on the focused slider) to reset
 *   to the default value.
 */
import type { UnitSystem } from '../../state/params';
import { clamp, h, setHidden, uid } from '../dom';
import { formatNumber, unitFor } from '../../shared/units';
import type { QuantityKind } from '../../shared/units';
import type { Control } from './control';
import { createInfoPopover } from './infoPopover';
import type { InfoPopover } from './infoPopover';

/** Thousands grouped with commas: "10,000", "-1,234,567". */
const COMMA_GROUPED = /^[-+]?\d{1,3}(,\d{3})+$/;

/**
 * Read a number typed into a slider's field, or null if it is not one. Spaces are ignored. A
 * comma is a decimal comma ("7,5" is 7.5) unless it groups thousands ("10,000"); with both
 * separators, the last one is the decimal mark ("1,234.5", "1.234,5").
 */
export function parseTypedNumber(text: string): number | null {
  let t = text.replace(/[\s\u00a0\u202f]/g, '');
  if (t === '') return null;
  const comma = t.lastIndexOf(',');
  const dot = t.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    t = comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (comma >= 0) {
    t = COMMA_GROUPED.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  const value = Number(t);
  return Number.isFinite(value) ? value : null;
}

export interface SliderOptions {
  label: string;
  /** Range and step in SI units (degrees for angles), exactly as stored in the state. */
  min: number;
  max: number;
  step: number;
  value: number;
  /** Value restored by double-click. A function lets the owner compute it lazily. */
  defaultValue?: number | (() => number);
  /** What the number measures; decides the displayed unit. Default 'ratio'. */
  quantity?: QuantityKind;
  system?: UnitSystem;
  /** Plain-language explanation shown in the "i" bubble and read by screen readers. */
  help?: string;
  /** Written to the wrapper as `data-param` so lessons can highlight it. */
  param?: string;
  /** Fires continuously while the value changes (SI units). */
  onInput?(value: number): void;
  /** Fires once the change is settled (SI units). */
  onCommit?(value: number): void;
}

export interface SliderControl extends Control<number> {
  readonly input: HTMLInputElement;
  /** Switch the displayed unit system. */
  setSystem(system: UnitSystem): void;
  /** Change what double-click resets to. */
  setDefault(value: number | (() => number)): void;
  /** Grey the slider out (e.g. a setting the current mode ignores); `reason` becomes a tooltip. */
  setDisabled(disabled: boolean, reason?: string): void;
}

/** Decimals needed so one slider step is visible in the displayed unit. */
function digitsForStep(displayStep: number): number {
  if (!(displayStep > 0)) return 2;
  return clamp(Math.ceil(-Math.log10(displayStep) - 1e-9), 0, 4);
}

export function createSlider(options: SliderOptions): SliderControl {
  const { min, max, step } = options;
  const quantity = options.quantity ?? 'ratio';
  let unit = unitFor(quantity, options.system ?? 'metric');
  let digits = 0;
  let current = clamp(options.value, min, max);
  let defaultValue = options.defaultValue;

  const rangeId = uid('slider');
  const valueId = uid('slider-value');
  const helpId = uid('slider-help');

  const range = h('input', {
    class: 'slider__range',
    type: 'range',
    id: rangeId,
    min,
    max,
    step,
    value: current,
    'aria-describedby': options.help ? helpId : null,
  });
  const number = h('input', {
    class: 'slider__number',
    id: valueId,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': `${options.label}, value`,
  });
  const unitEl = h('span', { class: 'slider__unit', 'aria-hidden': 'true' });
  const label = h('label', { class: 'slider__label', for: rangeId }, options.label);

  let popover: InfoPopover | null = null;
  const head = h('div', { class: 'slider__head' }, label);
  if (options.help) {
    popover = createInfoPopover({ label: options.label, text: options.help });
    head.append(popover.el);
  }
  head.append(h('span', { class: 'slider__value' }, number, unitEl));

  const el = h(
    'div',
    { class: 'slider', dataset: { param: options.param } },
    head,
    range,
    options.help ? h('span', { class: 'sr-only', id: helpId }, options.help) : null,
  );

  const fromRange = () => clamp(Number(range.value), min, max);

  const render = () => {
    const display = unit.toDisplay(current);
    if (document.activeElement !== number)
      number.value = formatNumber(display, digits, { grouping: false });
    unitEl.textContent = unit.symbol;
    range.value = String(current);
    const pct = max > min ? ((current - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--fill', `${clamp(pct, 0, 100)}%`);
    range.setAttribute(
      'aria-valuetext',
      `${formatNumber(display, digits, { grouping: false })}${unit.symbol ? ` ${unit.name || unit.symbol}` : ''}`,
    );
  };

  const recomputeUnits = (system: UnitSystem) => {
    unit = unitFor(quantity, system);
    digits = digitsForStep(Math.abs(unit.toDisplay(step) - unit.toDisplay(0)));
    setHidden(unitEl, unit.symbol === '');
  };
  recomputeUnits(options.system ?? 'metric');
  render();

  const emitInput = (value: number) => options.onInput?.(value);
  const emitCommit = (value: number) => options.onCommit?.(value);

  const resolveDefault = (): number | undefined =>
    typeof defaultValue === 'function' ? defaultValue() : defaultValue;

  const reset = () => {
    const d = resolveDefault();
    if (d === undefined) return;
    current = clamp(d, min, max);
    render();
    emitInput(current);
    emitCommit(current);
  };

  const controller = new AbortController();
  const { signal } = controller;

  range.addEventListener(
    'input',
    () => {
      current = fromRange();
      render();
      emitInput(current);
    },
    { signal },
  );
  range.addEventListener('change', () => emitCommit(fromRange()), { signal });
  range.addEventListener('dblclick', reset, { signal });
  label.addEventListener('dblclick', reset, { signal });
  range.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        reset();
      }
    },
    { signal },
  );

  // Typed value: commit on Enter/blur (the native `change` event), revert on Escape.
  number.addEventListener(
    'change',
    () => {
      const parsed = parseTypedNumber(number.value);
      if (parsed !== null) {
        current = clamp(unit.fromDisplay(parsed), min, max);
        emitInput(current);
        emitCommit(current);
      }
      number.value = formatNumber(unit.toDisplay(current), digits, { grouping: false });
      render();
    },
    { signal },
  );
  number.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        const shown = formatNumber(unit.toDisplay(current), digits, { grouping: false });
        // Reverting a typed value is all this Escape does (it must not also close a drawer).
        if (number.value !== shown) e.stopPropagation();
        number.value = shown;
        number.blur();
      }
    },
    { signal },
  );
  number.addEventListener('focus', () => number.select(), { signal });

  return {
    el,
    input: range,
    set(value) {
      const next = clamp(value, min, max);
      if (next === current && document.activeElement !== number) return;
      current = next;
      render();
    },
    setSystem(system) {
      recomputeUnits(system);
      render();
    },
    setDefault(value) {
      defaultValue = value;
    },
    setDisabled(disabled, reason) {
      range.disabled = disabled;
      number.disabled = disabled;
      el.classList.toggle('is-disabled', disabled);
      if (disabled && reason) el.setAttribute('title', reason);
      else el.removeAttribute('title');
    },
    destroy() {
      controller.abort();
      popover?.destroy();
    },
  };
}
