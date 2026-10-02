// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollapsible } from './collapsible';
import { createIconButton } from './iconButton';
import { createInfoPopover } from './infoPopover';
import { createSegmented } from './segmented';
import { createSelect } from './select';
import { createSlider } from './slider';
import { createTipDevicePicker } from './tipDevicePicker';
import { createToggle } from './toggle';
import { createAirfoilThumb } from './airfoilThumb';

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function input(el: HTMLInputElement, value: string, type: 'input' | 'change' = 'input') {
  el.value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('slider', () => {
  const base = { label: 'Airspeed', min: 5, max: 280, step: 1, value: 60 };

  it('shows the value converted to the chosen unit and updates on set()', () => {
    const s = createSlider({ ...base, quantity: 'speed', system: 'aviation' });
    const number = s.el.querySelector<HTMLInputElement>('.slider__number')!;
    expect(number.value).toBe('117'); // 60 m/s in knots
    expect(s.el.querySelector('.slider__unit')?.textContent).toBe('kt');
    s.setSystem('metric');
    expect(number.value).toBe('216');
    expect(s.el.querySelector('.slider__unit')?.textContent).toBe('km/h');
    s.set(100);
    expect(number.value).toBe('360');
    expect(s.input.value).toBe('100');
  });

  it('emits continuous input events in SI units and commits on change', () => {
    const onInput = vi.fn();
    const onCommit = vi.fn();
    const s = createSlider({ ...base, quantity: 'speed', system: 'metric', onInput, onCommit });
    input(s.input, '90');
    input(s.input, '91');
    expect(onInput).toHaveBeenNthCalledWith(1, 90);
    expect(onInput).toHaveBeenNthCalledWith(2, 91);
    expect(onCommit).not.toHaveBeenCalled();
    s.input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledWith(91);
  });

  it('does not emit when set() is called programmatically', () => {
    const onInput = vi.fn();
    const s = createSlider({ ...base, onInput });
    s.set(70);
    expect(onInput).not.toHaveBeenCalled();
  });

  it('accepts a typed value in display units and clamps it', () => {
    const onCommit = vi.fn();
    const s = createSlider({ ...base, quantity: 'speed', system: 'metric', onCommit });
    const number = s.el.querySelector<HTMLInputElement>('.slider__number')!;
    input(number, '360', 'change'); // 360 km/h = 100 m/s
    expect(onCommit).toHaveBeenLastCalledWith(100);
    input(number, '99999', 'change');
    expect(onCommit).toHaveBeenLastCalledWith(280);
    expect(number.value).toBe('1008');
    input(number, 'abc', 'change');
    expect(onCommit).toHaveBeenCalledTimes(2); // garbage ignored
    expect(number.value).toBe('1008');
  });

  it('resets to the default on double-click and on Delete', () => {
    const onInput = vi.fn();
    const onCommit = vi.fn();
    const s = createSlider({ ...base, value: 120, defaultValue: 60, onInput, onCommit });
    s.input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onInput).toHaveBeenLastCalledWith(60);
    expect(onCommit).toHaveBeenLastCalledWith(60);
    expect(s.input.value).toBe('60');
    s.set(200);
    s.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(s.input.value).toBe('60');
    s.set(200);
    s.el.querySelector('label')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(s.input.value).toBe('60');
  });

  it('supports a lazily computed default', () => {
    let d = 10;
    const s = createSlider({ ...base, value: 100, defaultValue: () => d });
    d = 42;
    s.input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(s.input.value).toBe('42');
  });

  it('is labelled, carries data-param and exposes the help text', () => {
    const s = createSlider({
      ...base,
      help: 'Lift grows with speed squared.',
      param: 'flow.airspeed',
    });
    document.body.append(s.el);
    expect(s.el.dataset.param).toBe('flow.airspeed');
    const label = s.el.querySelector('label')!;
    expect(label.htmlFor).toBe(s.input.id);
    expect(s.input.getAttribute('aria-describedby')).toBeTruthy();
    const help = document.getElementById(s.input.getAttribute('aria-describedby')!);
    expect(help?.textContent).toBe('Lift grows with speed squared.');
    expect(s.el.querySelector('.info-btn')).not.toBeNull();
    expect(s.input.getAttribute('aria-valuetext')).toContain('60');
  });

  it('uses step-appropriate decimals and can be disabled', () => {
    const s = createSlider({
      label: 'Angle',
      min: -10,
      max: 25,
      step: 0.1,
      value: 5,
      quantity: 'angle',
    });
    expect(s.el.querySelector<HTMLInputElement>('.slider__number')!.value).toBe('5.0');
    s.setDisabled(true, 'Not used');
    expect(s.input.disabled).toBe(true);
    expect(s.el.title).toBe('Not used');
    s.setDisabled(false);
    expect(s.input.disabled).toBe(false);
  });

  it('keeps the fill proportional to the value', () => {
    const s = createSlider({ label: 'x', min: 0, max: 10, step: 1, value: 5 });
    expect(s.input.style.getPropertyValue('--fill')).toBe('50%');
    s.set(10);
    expect(s.input.style.getPropertyValue('--fill')).toBe('100%');
  });
});

describe('segmented', () => {
  it('selects, emits and syncs without emitting', () => {
    const onChange = vi.fn();
    const seg = createSegmented({
      label: 'Colour by',
      options: [
        { value: 'pressure', label: 'Pressure' },
        { value: 'speed', label: 'Speed' },
      ],
      value: 'pressure',
      param: 'view.colorBy',
      onChange,
    });
    document.body.append(seg.el);
    const radios = seg.el.querySelectorAll<HTMLInputElement>('input[type=radio]');
    expect(radios).toHaveLength(2);
    expect(radios[0]!.checked).toBe(true);
    expect(seg.el.dataset.param).toBe('view.colorBy');
    expect(seg.el.querySelector('[role=radiogroup]')?.getAttribute('aria-labelledby')).toBeTruthy();
    radios[1]!.checked = true;
    radios[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('speed');
    seg.set('pressure');
    expect(radios[0]!.checked).toBe(true);
    expect(radios[1]!.checked).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('select', () => {
  const groups = [
    {
      label: 'Airliners',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
    { label: 'Gliders', options: [{ value: 'g', label: 'G' }] },
  ];

  it('renders optgroups and emits changes', () => {
    const onChange = vi.fn();
    const sel = createSelect({ label: 'Aircraft', groups, value: 'b', onChange });
    expect(sel.el.querySelectorAll('optgroup')).toHaveLength(2);
    expect(sel.select.value).toBe('b');
    sel.select.value = 'g';
    sel.select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('g');
  });

  it('shows the placeholder when nothing matches', () => {
    const sel = createSelect({ label: 'Aircraft', groups, value: '', placeholder: 'Custom' });
    expect(sel.select.value).toBe('');
    expect(sel.select.selectedOptions[0]?.textContent).toBe('Custom');
    sel.set('a');
    expect(sel.select.value).toBe('a');
    sel.set('nope');
    expect(sel.select.value).toBe('');
  });
});

describe('toggle', () => {
  it('is a labelled switch that emits on change', () => {
    const onChange = vi.fn();
    const t = createToggle({ label: 'Slats', checked: false, param: 'wing.slats', onChange });
    document.body.append(t.el);
    expect(t.input.getAttribute('role')).toBe('switch');
    expect(t.el.dataset.param).toBe('wing.slats');
    t.input.checked = true;
    t.input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(true);
    t.set(false);
    expect(t.input.checked).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('collapsible', () => {
  it('toggles on click, reflects aria-expanded and makes closed content inert', () => {
    const onToggle = vi.fn();
    const c = createCollapsible({ title: 'Flight', open: false, onToggle });
    document.body.append(c.el);
    expect(c.button.getAttribute('aria-expanded')).toBe('false');
    expect(c.el.querySelector('.collapsible__clip')?.hasAttribute('inert')).toBe(true);
    c.button.click();
    expect(c.isOpen()).toBe(true);
    expect(c.button.getAttribute('aria-expanded')).toBe('true');
    expect(c.el.querySelector('.collapsible__clip')?.hasAttribute('inert')).toBe(false);
    expect(onToggle).toHaveBeenCalledWith(true);
    c.set(false);
    expect(c.isOpen()).toBe(false);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('remembers its state', () => {
    const a = createCollapsible({ title: 'X', open: true, storageKey: 'test.x' });
    a.button.click();
    const b = createCollapsible({ title: 'X', open: true, storageKey: 'test.x' });
    expect(b.isOpen()).toBe(false);
  });

  it('can be forced open without losing the remembered choice', () => {
    const c = createCollapsible({ title: 'X', open: false, storageKey: 'test.y' });
    c.setForceOpen(true);
    expect(c.isOpen()).toBe(true);
    c.button.click(); // ignored while forced
    expect(c.isOpen()).toBe(true);
    c.setForceOpen(false);
    expect(c.isOpen()).toBe(false);
  });
});

describe('iconButton', () => {
  it('has an accessible name, handles clicks and toggles pressed', () => {
    const onClick = vi.fn();
    const b = createIconButton({ icon: 'pulse', label: 'Smoke pulse', onClick, pressed: false });
    expect(b.el.getAttribute('aria-label')).toBe('Smoke pulse');
    expect(b.el.getAttribute('aria-pressed')).toBe('false');
    b.el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    b.set(true);
    expect(b.el.getAttribute('aria-pressed')).toBe('true');
    expect(b.el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows visible text when given', () => {
    const b = createIconButton({ icon: 'book', label: 'Open lessons', text: 'Lessons' });
    expect(b.el.textContent).toBe('Lessons');
    b.setLabel('Open lessons now', 'Go');
    expect(b.el.textContent).toBe('Go');
  });
});

describe('info popover', () => {
  it('opens on click into <body>, closes on Escape and outside click', () => {
    const p = createInfoPopover({ label: 'Airspeed', text: 'Lift grows with speed squared.' });
    document.body.append(p.el);
    expect(p.el.getAttribute('aria-label')).toBe('About Airspeed');
    p.el.click();
    const bubble = document.querySelector('.popover-bubble');
    expect(bubble?.textContent).toBe('Lift grows with speed squared.');
    expect(bubble?.parentElement).toBe(document.body);
    expect(p.el.getAttribute('aria-expanded')).toBe('true');
    expect(p.el.getAttribute('aria-controls')).toBe(bubble?.id);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.popover-bubble')).toBeNull();
    expect(p.el.getAttribute('aria-expanded')).toBe('false');

    p.el.click();
    expect(document.querySelector('.popover-bubble')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.popover-bubble')).toBeNull();
  });

  it('toggles closed on a second click and keeps only one bubble open', () => {
    const a = createInfoPopover({ label: 'A', text: 'aaa' });
    const b = createInfoPopover({ label: 'B', text: 'bbb' });
    document.body.append(a.el, b.el);
    a.el.click();
    b.el.click();
    expect(document.querySelectorAll('.popover-bubble')).toHaveLength(1);
    expect(document.querySelector('.popover-bubble')?.textContent).toBe('bbb');
    b.el.click();
    expect(document.querySelectorAll('.popover-bubble')).toHaveLength(0);
  });

  it('removes its bubble on destroy', () => {
    const p = createInfoPopover({ label: 'A', text: 'aaa' });
    document.body.append(p.el);
    p.el.click();
    p.destroy();
    expect(document.querySelector('.popover-bubble')).toBeNull();
  });
});

describe('tip device picker', () => {
  it('offers six illustrated devices and emits the chosen kind', () => {
    const onChange = vi.fn();
    const picker = createTipDevicePicker({ value: 'none', param: 'wing.tipDevice.kind', onChange });
    document.body.append(picker.el);
    const radios = picker.el.querySelectorAll<HTMLInputElement>('input[type=radio]');
    expect(radios).toHaveLength(6);
    expect(picker.el.querySelectorAll('svg')).toHaveLength(6);
    expect(picker.el.textContent).toContain('747-400');
    expect(picker.el.textContent).toContain('737NG / A320neo');
    expect(picker.el.textContent).toContain('747-8 / 787');
    expect(picker.el.textContent).toContain('737 MAX');
    expect(picker.el.textContent).toContain('A380');
    const split = [...radios].find((r) => r.value === 'split-winglet')!;
    split.checked = true;
    split.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('split-winglet');
    expect(picker.el.querySelector('.tip-desc')?.textContent).toContain('below');
    picker.set('none');
    expect([...radios].find((r) => r.value === 'none')!.checked).toBe(true);
  });
});

describe('airfoil thumbnail', () => {
  it('draws the section and names it', () => {
    const thumb = createAirfoilThumb({ camber: 0.02, camberPos: 0.4, thickness: 0.12 });
    expect(thumb.name()).toBe('NACA 2412');
    const d1 = thumb.el.querySelector('.airfoil-thumb__outline')!.getAttribute('d');
    expect(d1).toMatch(/^M/);
    thumb.set({ camber: 0, camberPos: 0.4, thickness: 0.15 });
    expect(thumb.name()).toBe('NACA 0015');
    expect(thumb.el.querySelector('.airfoil-thumb__outline')!.getAttribute('d')).not.toBe(d1);
    expect(thumb.el.getAttribute('aria-label')).toContain('NACA 0015');
  });
});
