/**
 * Left-hand controls: aircraft picker, flight conditions, wing shape, airfoil, wingtip device,
 * high-lift devices, view options and settings.
 *
 * Every parameter control's wrapper carries `data-param="<state path>"` so lessons can add the
 * `is-highlighted` class to it. Sliders are generated from PARAM_SPECS; advanced ones appear only
 * in engineer mode. Editing any `wing.*` value turns the aircraft into "Custom" (presetId null);
 * flow and view edits do not. Slider drags write to the store at most once per animation frame.
 */
import type {
  AppState,
  ColorBy,
  FlowVizMode,
  ParamSpec,
  RakeMode,
  TipDeviceKind,
  UnitSystem,
} from '../../state/params';
import { DEFAULT_STATE, PARAM_SPECS, TIP_DEVICE_DEFAULTS } from '../../state/params';
import { PRESETS, applyPreset, getPreset } from '../../state/presets';
import type { AircraftPreset, PresetCategory } from '../../state/presets';
import { deepEqual, getPath, setPath } from '../../state/store';
import type { Store } from '../../state/store';
import { UNIT_SYSTEMS, UNIT_SYSTEM_LABELS } from '../../shared/units';
import type { QuantityKind } from '../../shared/units';
import { createAirfoilThumb } from '../components/airfoilThumb';
import { createCollapsible } from '../components/collapsible';
import type { CollapsibleControl } from '../components/collapsible';
import type { IconName } from '../components/icons';
import { createSegmented } from '../components/segmented';
import { createSelect } from '../components/select';
import type { SelectGroup } from '../components/select';
import { createSlider } from '../components/slider';
import type { SliderControl } from '../components/slider';
import { createTipDevicePicker } from '../components/tipDevicePicker';
import { createToggle } from '../components/toggle';
import { createFrameThrottle, h, prefersReducedMotion, scrollWithinPanel, setHidden } from '../dom';
import type { FrameThrottle } from '../dom';

/* ------------------------------------------------------------------------------------------ */
/* Static copy and slider definitions                                                          */
/* ------------------------------------------------------------------------------------------ */

const CATEGORY_ORDER: readonly PresetCategory[] = [
  'airliner',
  'general-aviation',
  'glider',
  'fighter',
  'teaching',
];

const CATEGORY_LABELS: Record<PresetCategory, string> = {
  airliner: 'Airliners',
  'general-aviation': 'General aviation',
  glider: 'Gliders',
  fighter: 'Fighters',
  teaching: 'Teaching wings',
};

/** Description of one slider; generated from a ParamSpec or written by hand for view options. */
interface SliderDef {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  quantity: QuantityKind;
  help: string;
  advanced?: boolean;
}

function quantityForSpec(spec: ParamSpec): QuantityKind {
  switch (spec.unit) {
    case 'deg':
      return 'angle';
    case 'm':
      return spec.path === 'flow.altitude' ? 'altitude' : 'length';
    case 'm/s':
      return 'speed';
    case 'ratio':
      return 'ratio';
    case 'percent-chord':
    case 'fraction':
      return 'percent';
  }
}

function defFromSpec(spec: ParamSpec): SliderDef {
  return {
    path: spec.path,
    label: spec.label,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    quantity: quantityForSpec(spec),
    help: spec.help,
    advanced: spec.advanced,
  };
}

const VIEW_SLIDERS = {
  rakeEta: {
    path: 'view.rake.eta',
    label: 'Smoke position',
    min: -1,
    max: 1,
    step: 0.01,
    quantity: 'percent',
    help: 'Where along the wing the smoke is released: 0% is the centre line, 100% is the right wingtip, -100% the left.',
  },
  rakeHeight: {
    path: 'view.rake.height',
    label: 'Smoke height',
    min: -0.3,
    max: 0.3,
    step: 0.01,
    quantity: 'percent',
    help: 'Moves the smoke source up or down relative to the wing. Smoke released above the wing is pulled down toward it; smoke below is pushed away.',
  },
  rakeCount: {
    path: 'view.rake.count',
    label: 'Smoke lines',
    min: 8,
    max: 64,
    step: 1,
    quantity: 'ratio',
    help: 'How many streams of smoke are released. More lines show more detail but can look busy.',
  },
  playback: {
    path: 'view.playbackSpeed',
    label: 'Flow speed',
    min: 0.05,
    max: 2,
    step: 0.05,
    quantity: 'multiplier',
    help: 'Slows the animation down so you can follow individual bits of air. This changes only how fast the picture plays, not the physics.',
  },
  density: {
    path: 'view.particleDensity',
    label: 'Particle density',
    min: 0.25,
    max: 2,
    step: 0.05,
    quantity: 'multiplier',
    help: 'How many drifting particles are drawn. Lower this if the animation feels slow.',
    advanced: true,
  },
} as const satisfies Record<string, SliderDef>;

const FLOW_MODE_OPTIONS: { value: FlowVizMode; label: string; title: string }[] = [
  { value: 'streamlines', label: 'Smoke', title: 'Lines of smoke that trace the air' },
  { value: 'particles', label: 'Particles', title: 'Small bits of drifting air' },
  { value: 'both', label: 'Both', title: 'Smoke and particles together' },
  { value: 'off', label: 'Off', title: 'Hide the airflow' },
];

const COLOR_BY_OPTIONS: { value: ColorBy; label: string; title: string }[] = [
  {
    value: 'pressure',
    label: 'Pressure',
    title: 'Blue is low pressure (fast air), red is high pressure (slow air)',
  },
  { value: 'speed', label: 'Speed', title: 'Slow air is violet, fast air is yellow' },
];

const RAKE_MODE_OPTIONS: { value: RakeMode; label: string }[] = [
  { value: 'vertical', label: 'Vertical line (side view)' },
  { value: 'horizontal', label: 'Horizontal line (along the span)' },
  { value: 'tip-vortex', label: 'Around the wingtip vortex' },
];

const TOGGLE_HELP = {
  slats:
    'Slats are small wings on the front edge that slide forward at low speed. They let air follow the top of the wing at steeper angles, so the wing stalls later.',
  supercritical:
    'Modern jet airliners use a flatter-topped "supercritical" section that delays shock waves. This only changes the speed at which the Mach warning appears.',
  surfacePressure:
    'Paint the wing by pressure: blue where the air pushes less (suction), red where it pushes more.',
  forces:
    'Show arrows for lift (up), drag (backwards) and, for comparison, the aircraft weight (down).',
  spanLoad:
    'Draw how much lift each part of the wing makes along its span. A wing that loads its middle more than its tips has less induced drag.',
  paused: 'Freeze the animation to study a moment. The numbers keep updating if you change things.',
  engineer:
    'Show the engineering numbers: coefficients, Reynolds number, Mach number and extra controls.',
} as const;

/* ------------------------------------------------------------------------------------------ */
/* Panel                                                                                        */
/* ------------------------------------------------------------------------------------------ */

interface SliderEntry {
  def: SliderDef;
  control: SliderControl;
  throttle: FrameThrottle<number>;
}

export class ControlsPanel {
  private readonly root: HTMLElement;
  private readonly store: Store<AppState>;
  private readonly sections = new Map<HTMLElement, CollapsibleControl>();
  private readonly sliders = new Map<string, SliderEntry>();
  /** Callbacks that copy the current state into one control. */
  private readonly syncers: ((state: AppState) => void)[] = [];
  /** Elements shown only in engineer mode. */
  private readonly advancedEls: HTMLElement[] = [];
  private readonly destroyers: (() => void)[] = [];
  private unsubscribe: (() => void) | null = null;
  private observer: MutationObserver | null = null;
  private shownUnits: UnitSystem | null = null;

  constructor(root: HTMLElement, store: Store<AppState>) {
    this.root = root;
    this.store = store;
    root.classList.add('controls');
    root.append(
      this.buildAircraft(),
      this.buildFlight(),
      this.buildWingShape(),
      this.buildAirfoil(),
      this.buildWingtip(),
      this.buildHighLift(),
      this.buildView(),
      this.buildSettings(),
    );
    this.sync(store.get());
    this.unsubscribe = store.subscribe((state) => this.sync(state));
    this.watchHighlights();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.observer?.disconnect();
    this.observer = null;
    for (const entry of this.sliders.values()) entry.throttle.cancel();
    for (const fn of this.destroyers) fn();
    this.destroyers.length = 0;
    this.sliders.clear();
    this.sections.clear();
    this.root.classList.remove('controls');
    this.root.replaceChildren();
  }

  /** Apply any pending throttled slider writes immediately (tests, or before reading the store). */
  flush(): void {
    for (const entry of this.sliders.values()) entry.throttle.flush();
  }

  /* -------------------------------------------------------------------------------------- */
  /* Store writes                                                                             */
  /* -------------------------------------------------------------------------------------- */

  /** Write one value by path. Editing the wing makes the aircraft "Custom". */
  private writeValue(path: string, value: unknown): void {
    this.store.set((s) => {
      const next = setPath(s, path, value);
      if (next === s) return s;
      return path.startsWith('wing.') && next.presetId !== null
        ? { ...next, presetId: null }
        : next;
    });
  }

  /* -------------------------------------------------------------------------------------- */
  /* Building blocks                                                                          */
  /* -------------------------------------------------------------------------------------- */

  private section(id: string, title: string, icon: IconName, open: boolean): CollapsibleControl {
    const c = createCollapsible({
      title,
      icon,
      open,
      storageKey: `controls.${id}`,
      level: 2,
      class: 'controls__section',
    });
    c.body.classList.add('stack');
    this.sections.set(c.el, c);
    this.destroyers.push(() => c.destroy());
    return c;
  }

  /** The value a double-click on this slider restores. */
  private defaultFor(path: string): number {
    if (path.startsWith('wing.tipDevice.')) {
      const key = path.slice('wing.tipDevice.'.length) as 'size' | 'cantDeg' | 'sweepDeg';
      const kind = this.store.get().wing.tipDevice.kind;
      return TIP_DEVICE_DEFAULTS[kind][key];
    }
    return Number(getPath(DEFAULT_STATE, path));
  }

  /**
   * Create a slider bound to a state path. `manageAdvanced: false` leaves hiding to the caller
   * (the wingtip sliders also depend on which device is chosen).
   */
  private addSlider(parent: HTMLElement, def: SliderDef, manageAdvanced = true): SliderEntry {
    const state = this.store.get();
    const throttle = createFrameThrottle<number>((value) => this.writeValue(def.path, value));
    const control = createSlider({
      label: def.label,
      min: def.min,
      max: def.max,
      step: def.step,
      value: Number(getPath(state, def.path)),
      defaultValue: () => this.defaultFor(def.path),
      quantity: def.quantity,
      system: state.view.units,
      help: def.help,
      param: def.path,
      onInput: (value) => throttle.push(value),
      onCommit: (value) => {
        throttle.push(value);
        throttle.flush();
      },
    });
    const entry: SliderEntry = { def, control, throttle };
    this.sliders.set(def.path, entry);
    if (def.advanced && manageAdvanced) this.advancedEls.push(control.el);
    this.destroyers.push(() => control.destroy());
    parent.append(control.el);
    return entry;
  }

  private addToggle(
    parent: HTMLElement | null,
    path: string,
    label: string,
    help: string,
    advanced = false,
  ): HTMLElement {
    const toggle = createToggle({
      label,
      help,
      param: path,
      checked: Boolean(getPath(this.store.get(), path)),
      onChange: (checked) => this.writeValue(path, checked),
    });
    if (advanced) this.advancedEls.push(toggle.el);
    this.syncers.push((s) => toggle.set(Boolean(getPath(s, path))));
    this.destroyers.push(() => toggle.destroy());
    parent?.append(toggle.el);
    return toggle.el;
  }

  private addSpecSliders(parent: HTMLElement, group: ParamSpec['group']): void {
    for (const spec of PARAM_SPECS) {
      if (spec.group === group) this.addSlider(parent, defFromSpec(spec));
    }
  }

  /* -------------------------------------------------------------------------------------- */
  /* Sections                                                                                 */
  /* -------------------------------------------------------------------------------------- */

  private buildAircraft(): HTMLElement {
    const section = this.section('aircraft', 'Aircraft', 'plane', true);
    const state = this.store.get();

    const groups: SelectGroup[] = [];
    const byCategory = new Map<string, AircraftPreset[]>();
    for (const p of PRESETS) {
      const list = byCategory.get(p.category) ?? [];
      list.push(p);
      byCategory.set(p.category, list);
    }
    const categories = [
      ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
      ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c as PresetCategory)),
    ];
    for (const category of categories) {
      groups.push({
        label: CATEGORY_LABELS[category as PresetCategory] ?? category,
        options: (byCategory.get(category) ?? []).map((p) => ({ value: p.id, label: p.name })),
      });
    }

    const picker = createSelect({
      label: 'Choose an aircraft',
      groups,
      value: state.presetId ?? '',
      placeholder: 'Custom',
      param: 'presetId',
      onChange: (id) => {
        if (id) this.store.set((s) => applyPreset(s, id, 'cruise'));
      },
    });
    this.destroyers.push(() => picker.destroy());

    const blurb = h('p', { class: 'aircraft__blurb' });

    const cruise = h(
      'button',
      { class: 'btn btn--solid btn--sm', type: 'button', 'aria-pressed': 'false' },
      'Cruise',
    );
    const approach = h(
      'button',
      { class: 'btn btn--solid btn--sm', type: 'button', 'aria-pressed': 'false' },
      'Approach',
    );
    const loadConditions = (mode: 'cruise' | 'approach') => () => {
      const id = this.store.get().presetId;
      if (id) this.store.set((s) => applyPreset(s, id, mode));
    };
    cruise.addEventListener('click', loadConditions('cruise'));
    approach.addEventListener('click', loadConditions('approach'));
    const conditions = h(
      'div',
      { class: 'field' },
      h('div', { class: 'field__label' }, 'Flight conditions'),
      h(
        'div',
        { class: 'btn-pair', role: 'group', 'aria-label': 'Load flight conditions' },
        cruise,
        approach,
      ),
      h(
        'p',
        { class: 'field__hint' },
        'Cruise: high and fast. Approach: slow and low, on the way to landing (try adding flaps).',
      ),
    );

    section.body.append(picker.el, blurb, conditions);

    this.syncers.push((s) => {
      picker.set(s.presetId ?? '');
      const preset = s.presetId ? getPreset(s.presetId) : undefined;
      blurb.textContent = preset
        ? preset.blurb
        : 'A custom wing: you have changed the shape. Pick an aircraft above to start from a real one.';
      for (const [button, mode] of [
        [cruise, 'cruise'],
        [approach, 'approach'],
      ] as const) {
        button.disabled = !preset;
        button.title = preset ? '' : 'Pick an aircraft first';
        button.setAttribute('aria-pressed', String(!!preset && deepEqual(s.flow, preset[mode])));
      }
    });
    return section.el;
  }

  private buildFlight(): HTMLElement {
    const section = this.section('flight', 'Flight', 'sliders', true);
    this.addSpecSliders(section.body, 'flight');
    return section.el;
  }

  private buildWingShape(): HTMLElement {
    const section = this.section('wing', 'Wing shape', 'section', true);
    this.addSpecSliders(section.body, 'planform');
    return section.el;
  }

  private buildAirfoil(): HTMLElement {
    const section = this.section('airfoil', 'Airfoil', 'airfoil', false);
    const thumb = createAirfoilThumb(this.store.get().wing.airfoil);
    this.destroyers.push(() => thumb.destroy());
    const name = h('span', { class: 'airfoil__name' }, thumb.name());
    section.body.append(
      h(
        'div',
        { class: 'airfoil__preview' },
        thumb.el,
        h(
          'div',
          { class: 'airfoil__caption' },
          h('span', { class: 'airfoil__label' }, 'Wing section'),
          name,
        ),
      ),
    );
    this.addSpecSliders(section.body, 'airfoil');
    this.addToggle(
      section.body,
      'wing.supercritical',
      'Supercritical section',
      TOGGLE_HELP.supercritical,
      true,
    );
    this.syncers.push((s) => {
      thumb.set(s.wing.airfoil);
      name.textContent = thumb.name();
    });
    return section.el;
  }

  private buildWingtip(): HTMLElement {
    const section = this.section('tip', 'Wingtip', 'winglet', true);
    const picker = createTipDevicePicker({
      value: this.store.get().wing.tipDevice.kind,
      param: 'wing.tipDevice.kind',
      onChange: (kind) => this.chooseTipDevice(kind),
    });
    this.destroyers.push(() => picker.destroy());
    section.body.append(picker.el);

    const tipSliders: SliderEntry[] = [];
    for (const spec of PARAM_SPECS) {
      if (spec.group === 'tip') {
        tipSliders.push(this.addSlider(section.body, defFromSpec(spec), false));
      }
    }
    this.syncers.push((s) => {
      const kind = s.wing.tipDevice.kind;
      picker.set(kind);
      const engineer = s.view.engineerMode;
      for (const { def, control } of tipSliders) {
        let hidden = kind === 'none' || (def.advanced === true && !engineer);
        // A raked tip stays in the plane of the wing, so a cant angle means nothing.
        if (kind === 'raked-tip' && def.path === 'wing.tipDevice.cantDeg') hidden = true;
        setHidden(control.el, hidden);
      }
    });
    return section.el;
  }

  /** Picking a device loads its typical shape; the sliders then fine-tune it. */
  private chooseTipDevice(kind: TipDeviceKind): void {
    this.store.set((s) => {
      if (s.wing.tipDevice.kind === kind) return s;
      return {
        ...s,
        presetId: null,
        wing: { ...s.wing, tipDevice: { ...TIP_DEVICE_DEFAULTS[kind] } },
      };
    });
  }

  private buildHighLift(): HTMLElement {
    const section = this.section('high-lift', 'High-lift devices', 'flaps', false);
    this.addSpecSliders(section.body, 'high-lift');
    // Slats belong right under the main flap slider, before the advanced flap sliders.
    const slats = this.addToggle(null, 'wing.slats', 'Leading-edge slats', TOGGLE_HELP.slats);
    const flaps = this.sliders.get('wing.flaps.deflectionDeg');
    if (flaps) flaps.control.el.after(slats);
    else section.body.append(slats);
    return section.el;
  }

  private buildView(): HTMLElement {
    const section = this.section('view', 'View', 'eye', false);
    const body = section.body;
    const view = this.store.get().view;

    const flowMode = createSegmented<FlowVizMode>({
      label: 'Show the air as',
      options: FLOW_MODE_OPTIONS,
      value: view.flowMode,
      param: 'view.flowMode',
      onChange: (v) => this.writeValue('view.flowMode', v),
    });
    const colorBy = createSegmented<ColorBy>({
      label: 'Colour by',
      options: COLOR_BY_OPTIONS,
      value: view.colorBy,
      param: 'view.colorBy',
      onChange: (v) => this.writeValue('view.colorBy', v),
    });
    const rakeMode = createSelect({
      label: 'Smoke source',
      groups: [{ options: RAKE_MODE_OPTIONS }],
      value: view.rake.mode,
      param: 'view.rake.mode',
      onChange: (v) => this.writeValue('view.rake.mode', v),
    });
    body.append(flowMode.el, colorBy.el, rakeMode.el);
    this.destroyers.push(
      () => flowMode.destroy(),
      () => colorBy.destroy(),
      () => rakeMode.destroy(),
    );

    const eta = this.addSlider(body, VIEW_SLIDERS.rakeEta);
    const height = this.addSlider(body, VIEW_SLIDERS.rakeHeight);
    this.addSlider(body, VIEW_SLIDERS.rakeCount);

    this.addToggle(
      body,
      'view.showSurfacePressure',
      'Pressure on the wing',
      TOGGLE_HELP.surfacePressure,
    );
    this.addToggle(body, 'view.showForces', 'Force arrows', TOGGLE_HELP.forces);
    this.addToggle(body, 'view.showSpanLoad', 'Lift along the span', TOGGLE_HELP.spanLoad);
    this.addSlider(body, VIEW_SLIDERS.playback);
    this.addToggle(body, 'view.paused', 'Pause the flow', TOGGLE_HELP.paused);
    this.addSlider(body, VIEW_SLIDERS.density);

    this.syncers.push((s) => {
      flowMode.set(s.view.flowMode);
      colorBy.set(s.view.colorBy);
      rakeMode.set(s.view.rake.mode);
      const mode = s.view.rake.mode;
      eta.control.setDisabled(mode !== 'vertical', 'Only used by the vertical smoke line');
      height.control.setDisabled(mode === 'tip-vortex', 'Not used when following the tip vortex');
    });
    return section.el;
  }

  private buildSettings(): HTMLElement {
    const section = this.section('settings', 'Settings', 'gear', false);
    const units = createSegmented<UnitSystem>({
      label: 'Units',
      options: UNIT_SYSTEMS.map((u) => ({
        value: u,
        label: UNIT_SYSTEM_LABELS[u],
        title:
          u === 'aviation'
            ? 'Knots, feet, kilonewtons'
            : u === 'metric'
              ? 'Kilometres per hour, metres, kilonewtons'
              : 'Miles per hour, feet, pounds-force',
      })),
      value: this.store.get().view.units,
      param: 'view.units',
      onChange: (v) => this.writeValue('view.units', v),
    });
    this.destroyers.push(() => units.destroy());
    section.body.append(units.el);
    this.addToggle(section.body, 'view.engineerMode', 'Engineer mode', TOGGLE_HELP.engineer);
    this.syncers.push((s) => units.set(s.view.units));
    return section.el;
  }

  /* -------------------------------------------------------------------------------------- */
  /* State -> controls                                                                        */
  /* -------------------------------------------------------------------------------------- */

  private sync(state: AppState): void {
    const engineer = state.view.engineerMode;
    const units = state.view.units;
    this.root.dataset.engineer = String(engineer);

    const unitsChanged = units !== this.shownUnits;
    this.shownUnits = units;
    for (const [path, entry] of this.sliders) {
      // Do not fight the person's own drag: a pending write is newer than the store.
      if (!entry.throttle.pending) entry.control.set(Number(getPath(state, path)));
      if (unitsChanged) entry.control.setSystem(units);
    }
    for (const sync of this.syncers) sync(state);
    for (const el of this.advancedEls) setHidden(el, !engineer);
  }

  /**
   * When a lesson highlights a control inside a collapsed section, open that section and bring
   * the control into view.
   */
  private watchHighlights(): void {
    if (typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (!(target instanceof HTMLElement) || !target.classList.contains('is-highlighted'))
          continue;
        let node: HTMLElement | null = target.parentElement;
        while (node && node !== this.root) {
          const section = this.sections.get(node);
          if (section && !section.isOpen()) section.set(true);
          node = node.parentElement;
        }
        scrollWithinPanel(target, !prefersReducedMotion());
      }
    });
    this.observer.observe(this.root, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true,
    });
  }
}
