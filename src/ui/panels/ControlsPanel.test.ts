// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOW, DEFAULT_STATE, PARAM_SPECS, TIP_DEVICE_DEFAULTS } from '../../state/params';
import type { AppState } from '../../state/params';
import { PRESETS } from '../../state/presets';
import { Store } from '../../state/store';
import { ControlsPanel } from './ControlsPanel';

const preset = PRESETS[0]!;
const presetState = (): AppState => ({ ...DEFAULT_STATE, presetId: preset.id });

let root: HTMLElement;

function setup(initial: AppState = DEFAULT_STATE) {
  root = document.createElement('div');
  document.body.append(root);
  const store = new Store<AppState>(initial);
  const panel = new ControlsPanel(root, store);
  return { store, panel };
}

const param = (path: string) => root.querySelector<HTMLElement>(`[data-param="${path}"]`);
const range = (path: string) => param(path)!.querySelector<HTMLInputElement>('input[type=range]')!;

function drag(path: string, value: number) {
  const r = range(path);
  r.value = String(value);
  r.dispatchEvent(new Event('input', { bubbles: true }));
}

function release(path: string) {
  range(path).dispatchEvent(new Event('change', { bubbles: true }));
}

function choose(path: string, value: string) {
  const radio = param(path)!.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ControlsPanel structure', () => {
  it('has a data-param control for every ParamSpec', () => {
    setup();
    for (const spec of PARAM_SPECS) {
      expect(param(spec.path), spec.path).not.toBeNull();
    }
  });

  it('also tags the other controls so lessons can highlight them', () => {
    setup();
    for (const path of [
      'presetId',
      'wing.tipDevice.kind',
      'wing.slats',
      'view.flowMode',
      'view.colorBy',
      'view.rake.mode',
      'view.rake.eta',
      'view.rake.height',
      'view.rake.count',
      'view.showSurfacePressure',
      'view.showForces',
      'view.showSpanLoad',
      'view.playbackSpeed',
      'view.paused',
      'view.units',
      'view.engineerMode',
    ]) {
      expect(param(path), path).not.toBeNull();
    }
  });

  it('has the eight sections in order', () => {
    setup();
    const titles = [...root.querySelectorAll('.collapsible__title')].map((e) => e.textContent);
    expect(titles).toEqual([
      'Aircraft',
      'Flight',
      'Wing shape',
      'Airfoil',
      'Wingtip',
      'High-lift devices',
      'View',
      'Settings',
    ]);
  });

  it('groups the aircraft picker by category and shows Custom when presetId is null', () => {
    setup();
    const select = param('presetId')!.querySelector('select')!;
    expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(0);
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('Custom');
  });

  it('shows the preset name and blurb when a preset is active', () => {
    setup(presetState());
    const select = param('presetId')!.querySelector('select')!;
    expect(select.value).toBe(preset.id);
    expect(root.querySelector('.aircraft__blurb')?.textContent).toBe(preset.blurb);
  });

  it('reflects the airfoil as a live NACA name', () => {
    const { store } = setup();
    expect(root.querySelector('.airfoil__name')?.textContent).toBe('NACA 2412');
    store.set((s) => ({
      ...s,
      wing: { ...s.wing, airfoil: { camber: 0.04, camberPos: 0.4, thickness: 0.12 } },
    }));
    expect(root.querySelector('.airfoil__name')?.textContent).toBe('NACA 4412');
    expect(root.querySelector('.airfoil-thumb')).not.toBeNull();
  });
});

describe('ControlsPanel editing', () => {
  it('writes slider drags to the store once per frame and flushes on release', () => {
    vi.useFakeTimers();
    const { store } = setup();
    const writes = vi.fn();
    store.subscribe(writes);
    drag('flow.alphaDeg', 6);
    drag('flow.alphaDeg', 7);
    drag('flow.alphaDeg', 8);
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(store.get().flow.alphaDeg).toBe(8);

    drag('flow.alphaDeg', 9);
    release('flow.alphaDeg');
    expect(store.get().flow.alphaDeg).toBe(9);
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('does not let a store update fight an in-progress drag', () => {
    vi.useFakeTimers();
    const { store } = setup();
    drag('flow.airspeed', 120);
    store.set((s) => ({ ...s, view: { ...s.view, paused: true } })); // unrelated update
    expect(range('flow.airspeed').value).toBe('120');
  });

  it('keeps the aircraft when editing flow or view, and makes it Custom when editing the wing', () => {
    const { store, panel } = setup(presetState());
    drag('flow.alphaDeg', 3);
    panel.flush();
    expect(store.get().presetId).toBe(preset.id);

    choose('view.colorBy', 'speed');
    expect(store.get().view.colorBy).toBe('speed');
    expect(store.get().presetId).toBe(preset.id);

    drag('wing.span', 20);
    panel.flush();
    expect(store.get().wing.span).toBe(20);
    expect(store.get().presetId).toBeNull();
    expect(param('presetId')!.querySelector('select')!.value).toBe('');
  });

  it('turns slats and flaps into wing edits', () => {
    const { store, panel } = setup(presetState());
    const slats = param('wing.slats')!.querySelector<HTMLInputElement>('input')!;
    slats.checked = true;
    slats.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().wing.slats).toBe(true);
    expect(store.get().presetId).toBeNull();

    drag('wing.flaps.deflectionDeg', 20);
    panel.flush();
    expect(store.get().wing.flaps.deflectionDeg).toBe(20);
  });

  it('picks an aircraft via the preset select', () => {
    const { store } = setup();
    const select = param('presetId')!.querySelector('select')!;
    select.value = preset.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().presetId).toBe(preset.id);
    expect(store.get().wing).toEqual(preset.wing);
    expect(store.get().flow).toEqual(preset.cruise);
  });

  it('loads Cruise and Approach conditions for the current aircraft', () => {
    const { store } = setup(presetState());
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.btn-pair button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Cruise', 'Approach']);
    buttons[1]!.click();
    expect(store.get().flow).toEqual(preset.approach);
    expect(store.get().presetId).toBe(preset.id);
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false');
    buttons[0]!.click();
    expect(store.get().flow).toEqual(preset.cruise);
  });

  it('disables Cruise and Approach for a custom wing', () => {
    setup();
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.btn-pair button')];
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it('resets a slider to its default on double-click', () => {
    const { store, panel } = setup();
    drag('flow.alphaDeg', 12);
    panel.flush();
    expect(store.get().flow.alphaDeg).toBe(12);
    range('flow.alphaDeg').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(store.get().flow.alphaDeg).toBe(DEFAULT_FLOW.alphaDeg);
  });
});

describe('ControlsPanel wingtip devices', () => {
  const tipSliderPaths = PARAM_SPECS.filter((s) => s.group === 'tip').map((s) => s.path);

  it('hides tip sliders when there is no device', () => {
    setup();
    for (const path of tipSliderPaths) expect(param(path)!.hasAttribute('hidden'), path).toBe(true);
  });

  it('applies the device defaults and reveals its sliders', () => {
    const { store } = setup(presetState());
    choose('wing.tipDevice.kind', 'blended-winglet');
    expect(store.get().wing.tipDevice).toEqual(TIP_DEVICE_DEFAULTS['blended-winglet']);
    expect(store.get().presetId).toBeNull();
    expect(param('wing.tipDevice.size')!.hasAttribute('hidden')).toBe(false);
    expect(param('wing.tipDevice.cantDeg')!.hasAttribute('hidden')).toBe(false);
    // advanced tip sliders stay hidden until engineer mode
    expect(param('wing.tipDevice.toeDeg')!.hasAttribute('hidden')).toBe(true);
  });

  it('hides the cant angle for a raked tip', () => {
    setup();
    choose('wing.tipDevice.kind', 'raked-tip');
    expect(param('wing.tipDevice.size')!.hasAttribute('hidden')).toBe(false);
    expect(param('wing.tipDevice.cantDeg')!.hasAttribute('hidden')).toBe(true);
  });

  it('resets a tip slider to the chosen device default', () => {
    const { store } = setup();
    choose('wing.tipDevice.kind', 'split-winglet');
    drag('wing.tipDevice.size', 0.02);
    release('wing.tipDevice.size');
    expect(store.get().wing.tipDevice.size).toBe(0.02);
    range('wing.tipDevice.size').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(store.get().wing.tipDevice.size).toBe(TIP_DEVICE_DEFAULTS['split-winglet'].size);
  });

  it('going back to None hides the sliders and clears the device', () => {
    const { store } = setup();
    choose('wing.tipDevice.kind', 'wingtip-fence');
    choose('wing.tipDevice.kind', 'none');
    expect(store.get().wing.tipDevice.kind).toBe('none');
    expect(store.get().wing.tipDevice.size).toBe(0);
    expect(param('wing.tipDevice.size')!.hasAttribute('hidden')).toBe(true);
  });
});

describe('ControlsPanel engineer mode and units', () => {
  const advanced = PARAM_SPECS.filter((s) => s.advanced && s.group !== 'tip').map((s) => s.path);

  it('shows advanced sliders only in engineer mode', () => {
    const { store } = setup();
    for (const path of advanced) expect(param(path)!.hasAttribute('hidden'), path).toBe(true);
    expect(param('wing.supercritical')!.hasAttribute('hidden')).toBe(true);
    expect(param('view.particleDensity')!.hasAttribute('hidden')).toBe(true);

    const toggle = param('view.engineerMode')!.querySelector<HTMLInputElement>('input')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().view.engineerMode).toBe(true);
    for (const path of advanced) expect(param(path)!.hasAttribute('hidden'), path).toBe(false);
    expect(param('wing.supercritical')!.hasAttribute('hidden')).toBe(false);
  });

  it('shows tip advanced sliders in engineer mode once a device is chosen', () => {
    const { store } = setup();
    choose('wing.tipDevice.kind', 'canted-winglet');
    store.set((s) => ({ ...s, view: { ...s.view, engineerMode: true } }));
    expect(param('wing.tipDevice.toeDeg')!.hasAttribute('hidden')).toBe(false);
  });

  it('displays values in the chosen unit system', () => {
    const { store } = setup();
    const unit = () => param('flow.airspeed')!.querySelector('.slider__unit')!.textContent;
    expect(unit()).toBe('kt');
    choose('view.units', 'metric');
    expect(store.get().view.units).toBe('metric');
    expect(unit()).toBe('km/h');
    expect(param('wing.span')!.querySelector('.slider__unit')!.textContent).toBe('m');
    choose('view.units', 'imperial');
    expect(unit()).toBe('mph');
    expect(param('wing.span')!.querySelector('.slider__unit')!.textContent).toBe('ft');
    expect(param('flow.altitude')!.querySelector('.slider__unit')!.textContent).toBe('ft');
  });
});

describe('ControlsPanel view options and highlights', () => {
  it('disables rake controls the current smoke mode ignores', () => {
    const { store } = setup();
    expect(range('view.rake.eta').disabled).toBe(false);
    store.set((s) => ({ ...s, view: { ...s.view, rake: { ...s.view.rake, mode: 'tip-vortex' } } }));
    expect(range('view.rake.eta').disabled).toBe(true);
    expect(range('view.rake.height').disabled).toBe(true);
    store.set((s) => ({ ...s, view: { ...s.view, rake: { ...s.view.rake, mode: 'horizontal' } } }));
    expect(range('view.rake.eta').disabled).toBe(true);
    expect(range('view.rake.height').disabled).toBe(false);
  });

  it('opens a collapsed section when a lesson highlights a control inside it', async () => {
    setup();
    const section = param('wing.airfoil.thickness')!.closest('.collapsible')!;
    expect(section.classList.contains('is-open')).toBe(false);
    param('wing.airfoil.thickness')!.classList.add('is-highlighted');
    await new Promise((r) => setTimeout(r, 10));
    expect(section.classList.contains('is-open')).toBe(true);
  });

  it('follows outside store changes (a lesson step)', () => {
    const { store } = setup();
    store.set((s) => ({
      ...s,
      flow: { ...s.flow, alphaDeg: 14 },
      view: { ...s.view, flowMode: 'off' },
    }));
    expect(range('flow.alphaDeg').value).toBe('14');
    expect(
      param('view.flowMode')!.querySelector<HTMLInputElement>('input[value="off"]')!.checked,
    ).toBe(true);
  });

  it('destroy stops listening and clears the DOM', () => {
    const { store, panel } = setup();
    panel.destroy();
    expect(root.children).toHaveLength(0);
    expect(() => store.set((s) => ({ ...s, flow: { ...s.flow, alphaDeg: 1 } }))).not.toThrow();
  });
});
