/**
 * 2D cross-section of the wing at one span station (the slice the slider picks): the single most
 * intuitive picture of lift, so it gets a roomy card and an "Enlarge" view.
 *
 * The solver gives the flow in the airfoil frame, with the air arriving at the effective angle
 * of attack. We rotate the picture so the air moves horizontally left to right and the wing
 * appears pitched up. Canvas layers, back to front:
 *   pressure tint -> streamlines -> separated-air label -> airfoil -> pressure arrows ->
 *   stagnation point -> lift arrow -> animated smoke streaks -> timing markers.
 * The angle bookkeeping (wing tilt - downwash = what the air feels) and the colour key live in
 * the DOM under the picture, so nothing is ever drawn over the airfoil.
 *
 * Everything except the animated parts is rendered once into an offscreen layer; the animation
 * loop only blits that layer and draws the streaks, and runs only while the view is visible and
 * the simulation is not paused. The loop allocates nothing per frame.
 *
 * Three ways to make pressure intuitive (all driven by AppState.view, so lessons can set them):
 *  - Backdrop "Colours" (pressure tint) or "Terrain": pressure as a hillshaded landscape with
 *    contour lines; high pressure is a hill, low pressure a valley, and the smoke on top shows the
 *    air speeding up as it rolls downhill and slowing as it climbs.
 *  - Point of view "Wing's view" (the tunnel: air streams past) or "Air's view": the freestream
 *    is subtracted, and arrows show what the passing wing does to the still air (it circulates).
 *  - A draggable probe (pointer, or arrow keys on the focused picture) that reads the local
 *    speed, the pressure as a change from the surrounding air, and the flow direction.
 */
import { speedColor, rgbToCss, type RGB } from '../../shared/colormaps';
import type { AeroResult, SectionFlow } from '../../physics/types';
import type { AppState, SectionBackdrop, SectionFrame, SectionProbe } from '../../state/params';
import { formatPercent, probeText } from '../../shared/everydayFormat';
import type { ResultsState } from '../../state/results';
import type { Store } from '../../state/store';
import { readChartTheme } from '../charts/chartTheme';
import {
  CARD_VIEW,
  LARGE_VIEW,
  centerOfPressureX,
  contourToDisplay,
  crossingAtX,
  displayX,
  displayY,
  fillFieldImage,
  fitView,
  positionAtTime,
  prepareStreamlines,
  sectionPressureTint,
  separatedLabelAnchor,
  separationPolygon,
  speedGrid,
  surfaceArrows,
  surfaceProfile,
  surfaceY,
  type PreparedStreamlines,
  type SurfaceArrow,
  type SurfaceProfile,
  type ViewTransform,
} from '../charts/sectionMath';
import {
  TERRAIN_LEVELS,
  contourSegments,
  disturbanceArrows,
  disturbanceGain,
  fillTerrainImage,
  probeSection,
  sampleCpRaster,
  terrainColor,
  terrainHeights,
  type DisturbanceArrow,
  type ProbeFreestream,
} from '../charts/sectionFields';
import type { Control } from '../components/control';
import { icon } from '../components/icons';
import { createSegmented } from '../components/segmented';
import '../styles/viz.css';

/** Chord-times (chord / V_inf) that pass per real second at playback speed 1. */
const CHORDS_PER_SECOND = 0.9;
/** Fixed time between successive smoke streaks on a streamline (chord / V_inf). */
const PUFF_SPACING = 0.34;
/** Length of one streak in time: fast air draws longer streaks (chord / V_inf). */
const STREAK_TIME = 0.07;
/** How long the pulse label stays after the markers have finished (seconds). */
const PULSE_HOLD_SECONDS = 2.2;
/** At most this many timing markers on each side of the wing. */
const PULSE_PER_SIDE = 5;

const FALLBACK_BG = '#0a111d';
const STREAK = 'rgba(238, 246, 255, 0.78)';
const STREAMLINE = 'rgba(214, 228, 248, 0.3)';
const TEXT = 'rgba(236, 243, 252, 0.96)';
const TEXT_MUTED = 'rgba(182, 198, 220, 0.9)';
const HALO = 'rgba(7, 12, 21, 0.88)';
const TOP_COLOR = '#ffb454';
const BOTTOM_COLOR = '#67e8f9';
const SUCTION_ARROW = 'rgb(118, 192, 255)';
const PRESSURE_ARROW = 'rgb(255, 128, 100)';
const DISTURBANCE_ARROW = 'rgba(232, 242, 255, 0.86)';
const PROBE_RING = '#ffffff';
const PROBE_INSIDE = '#ffb454';

/** Where the probe appears when switched on: a little above the wing's front half (chords). */
export const DEFAULT_SECTION_PROBE: SectionProbe = { x: 0.3, y: 0.13 };
/** Arrow-key step for the probe (chords); Shift moves ten times as far. */
const PROBE_STEP = 0.01;
/** Probe positions are kept inside this display-frame window (chords). */
const PROBE_LIMITS = { xMin: -0.7, xMax: 1.9, yMin: -0.7, yMax: 0.7 } as const;
/** Disturbance arrows: lattice spacing on screen (CSS px) and typical arrow length (spacings). */
const DISTURBANCE_SPACING_PX = { card: 23, large: 30 } as const;
const DISTURBANCE_ARROW_SPACINGS = 0.8;
/** Candidate sizes for the arrow key, as fractions of the wind speed. */
const KEY_FRACTIONS = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5] as const;
/** Terrain relief: chords of height per unit of terrain height (for the hillshading slopes). */
const TERRAIN_RELIEF_CHORDS = 1.1;

/** |cl| below which the slice counts as "not lifting" in the captions. */
const NO_LIFT_CL = 0.05;

/**
 * Caption under the picture for a backdrop / point of view, worded for the sign of the slice's
 * lift so it stays true for negative lift (and for none).
 */
export function sectionCaption(
  backdrop: SectionBackdrop,
  frame: SectionFrame,
  cl: number | null,
): string {
  const sign =
    cl === null || !Number.isFinite(cl) ? 1 : Math.abs(cl) < NO_LIFT_CL ? 0 : Math.sign(cl);
  if (frame === 'air') {
    const intro =
      "The air's view: the wind is taken away, so the arrows show only what the passing wing does to still air.";
    const scale = 'Arrows are exaggerated; the key shows their scale.';
    if (sign > 0) {
      return `${intro} Air ahead is lifted, air over the top is pulled back, air underneath is pushed forward and air behind is thrown down: it circulates around the wing. ${scale}`;
    }
    if (sign < 0) {
      return `${intro} This slice pushes down, so the air circulates the other way: pulled back underneath, pushed forward over the top, and thrown up behind. ${scale}`;
    }
    return `${intro} With no lift there is almost no circulation: the air is just nudged aside around the wing's thickness. ${scale}`;
  }
  if (backdrop === 'terrain') {
    const where = sign < 0 ? 'under the wing' : 'over the wing';
    return `Pressure as a landscape: high pressure is a hill, low pressure a valley, and each line joins equal pressure (the bright one is normal air pressure). Air speeds up as it rolls downhill into the low-pressure valley ${where}, and slows as it climbs the hill at the nose.`;
  }
  return 'Blue is low pressure pulling the wing up; red is high pressure pushing it up. Watch the smoke speed up over the curved top.';
}

type ViewMode = 'card' | 'large';

interface PulseState {
  /** Time since release (chord / V_inf). */
  age: number;
  /** Time the slowest marker needs to leave the picture. */
  longest: number;
  /** All markers have left the picture. */
  done: boolean;
  /** Seconds left to show the label after finishing. */
  hold: number;
  /** Display X of the common start line. */
  startX: number;
  /** Mean time from the start line to the trailing edge, over the top / bottom markers. */
  top: number;
  bottom: number;
}

let viewCounter = 0;

export class SectionView {
  /** The drawing canvas (exposed for tests and for the app to snapshot). */
  readonly canvas: HTMLCanvasElement;

  private readonly root: HTMLElement;
  private readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly sliderLabel: HTMLLabelElement;
  private readonly arrowsToggle: HTMLInputElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly pulseButton: HTMLButtonElement;
  private readonly probeButton: HTMLButtonElement;
  private readonly backdropControl: Control<SectionBackdrop>;
  private readonly frameControl: Control<SectionFrame>;
  private readonly caption: HTMLElement;
  private readonly probeBox: HTMLElement;
  private readonly probeCells: {
    speed: HTMLElement;
    speedSub: HTMLElement;
    pressure: HTMLElement;
    pressureSub: HTMLElement;
    direction: HTMLElement;
    inside: HTMLElement;
    hint: HTMLElement;
  };
  private readonly angleValues: { tilt: HTMLElement; down: HTMLElement; feels: HTMLElement };
  /** Operator and label of the induced-angle chip; they flip to "+ Upwash" when it is negative. */
  private readonly downOp: HTMLElement;
  private readonly downName: HTMLElement;
  private readonly legendLow: HTMLElement;
  private readonly legendMid: HTMLElement;
  private readonly legendHigh: HTMLElement;
  private readonly legendBar: HTMLElement;
  private readonly away: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: CanvasRenderingContext2D | null;
  private readonly field: HTMLCanvasElement;
  private readonly fieldCtx: CanvasRenderingContext2D | null;
  private fieldImage: ImageData | null = null;

  // Enlarged view (created on first use).
  private dialog: HTMLElement | null = null;
  private dialogSheet: HTMLElement | null = null;
  private dialogSubtitle: HTMLElement | null = null;
  private dialogClose: HTMLButtonElement | null = null;
  private mode: ViewMode = 'card';
  private returnFocus: HTMLElement | null = null;

  private readonly unsubscribe: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private readonly onVisibility = (): void => this.updateAnimation();

  // Derived from the current SectionFlow.
  private section: SectionFlow | null = null;
  private speed: Float32Array | null = null;
  private prep: PreparedStreamlines | null = null;
  /** Indices of the streamlines that carry timing markers, top group then bottom group. */
  private pulseTop: number[] = [];
  private pulseBottom: number[] = [];
  private pulseStarts = new Float64Array(0);
  private profile: SurfaceProfile | null = null;
  private arrows: SurfaceArrow[] = [];
  private contourDisp: Float32Array | null = null;
  private separation: Float32Array | null = null;
  private cpX = 0.25;

  // Layout and rendering state.
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private vt: ViewTransform | null = null;
  private staticDirty = true;
  private fieldDirty = true;
  private drawQueued = 0;
  private raf = 0;
  private lastTime = 0;
  private visible = true;
  private reducedMotion = false;
  private showArrows = true;
  private backdrop: SectionBackdrop = 'tint';
  private frame: SectionFrame = 'wing';
  private probe: SectionProbe | null = null;
  private dragging = false;
  /** Terrain: the Cp raster behind the relief image and its contour lines (raster cells). */
  private terrainCp: Float32Array | null = null;
  private terrainFade: Float32Array | null = null;
  private contours: { level: number; segs: Float32Array }[] = [];
  /** Air's view: the disturbance arrows, their display gain (chords per unit) and key size. */
  private dArrows: DisturbanceArrow[] = [];
  private dGain = 1;
  private dKey = 0.1;
  private destroyed = false;
  private fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  // Animation state.
  private clock = 0;
  private pulse: PulseState | null = null;
  private readonly scratch = new Float32Array(2);
  private readonly scratch2 = new Float32Array(2);

  /**
   * Keys while enlarged. Listens on the document in the capture phase, so Escape still closes
   * the dialog after a click on the picture moved focus to <body>, and stops there instead of
   * also closing the drawer behind the dialog.
   */
  private readonly onDialogKey = (e: KeyboardEvent): void => {
    if (this.mode !== 'large') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.setExpanded(false);
    } else if (e.key === 'Tab') {
      this.trapFocus(e);
    }
  };

  constructor(
    root: HTMLElement,
    private readonly store: Store<AppState>,
    private readonly results: Store<ResultsState>,
  ) {
    const doc = root.ownerDocument;
    const uid = ++viewCounter;
    this.root = root;
    const make = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className?: string,
      text?: string,
    ): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    this.el = make('section', 'viz-root viz-section');
    this.el.setAttribute('aria-label', 'Cross-section of the wing');

    // Toolbar: arrows toggle, timing pulse, enlarge.
    const toolbar = make('div', 'viz-section-toolbar');
    const toggle = make('label', 'viz-toggle');
    const toggleLabel = toggle;
    this.arrowsToggle = make('input');
    this.arrowsToggle.type = 'checkbox';
    this.arrowsToggle.checked = true;
    this.arrowsToggle.addEventListener('change', () => {
      this.showArrows = this.arrowsToggle.checked;
      this.staticDirty = true;
      this.requestDraw();
    });
    toggle.append(this.arrowsToggle, doc.createTextNode('Pressure arrows'));

    const pulseButton = make('button', 'viz-button', 'Timing dots');
    pulseButton.type = 'button';
    pulseButton.title = 'Release a line of dots together and watch which side arrives first';
    pulseButton.addEventListener('click', () => this.firePulse());
    this.pulseButton = pulseButton;

    this.probeButton = make('button', 'viz-button viz-section-probe-toggle');
    this.probeButton.type = 'button';
    this.probeButton.setAttribute('aria-pressed', 'false');
    this.probeButton.dataset.param = 'view.sectionProbe';
    this.probeButton.title =
      'Place a probe in the air: it reads the speed, the pressure and the direction of the air there';
    this.probeButton.append(make('span', 'viz-probe-dot'), make('span', undefined, 'Probe'));
    this.probeButton.addEventListener('click', () => this.toggleProbe());

    const setView = <K extends 'sectionBackdrop' | 'sectionFrame'>(
      key: K,
      value: AppState['view'][K],
    ): void =>
      this.store.set((s) =>
        s.view[key] === value ? s : { ...s, view: { ...s.view, [key]: value } },
      );
    this.backdropControl = createSegmented<SectionBackdrop>({
      label: 'Show pressure as',
      hideLabel: true,
      param: 'view.sectionBackdrop',
      value: 'tint',
      options: [
        { value: 'tint', label: 'Colours', title: 'Pressure as colour: blue low, red high' },
        {
          value: 'terrain',
          label: 'Terrain',
          title: 'Pressure as a landscape: high pressure is a hill, low pressure a valley',
        },
      ],
      onChange: (v) => setView('sectionBackdrop', v),
    });
    this.frameControl = createSegmented<SectionFrame>({
      label: 'Point of view',
      hideLabel: true,
      param: 'view.sectionFrame',
      value: 'wing',
      options: [
        {
          value: 'wing',
          label: "Wing's view",
          title: 'Ride with the wing: the air streams past it, as in the wind tunnel',
        },
        {
          value: 'air',
          label: "Air's view",
          title:
            'Stand in the still air: take the wind away and see what the passing wing does to the air',
        },
      ],
      onChange: (v) => setView('sectionFrame', v),
    });
    const views = make('div', 'viz-section-views');
    views.append(this.backdropControl.el, this.frameControl.el);

    this.expandButton = make('button', 'viz-button viz-section-expand');
    this.expandButton.type = 'button';
    this.expandButton.setAttribute('aria-label', 'Enlarge the cross-section');
    this.expandButton.title = 'Enlarge';
    this.expandButton.append(icon('expand', 15));
    this.expandButton.addEventListener('click', () => this.setExpanded(true));
    toolbar.append(
      views,
      toggle,
      pulseButton,
      this.probeButton,
      make('span', 'viz-spacer'),
      this.expandButton,
    );

    this.stage = make('div', 'viz-section-stage');
    this.canvas = make('canvas', 'viz-section-canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute(
      'aria-label',
      'Air flowing past a slice of the wing: blue marks low pressure above, red high pressure below.',
    );
    this.stage.appendChild(this.canvas);
    this.stage.addEventListener('dblclick', () => {
      if (!this.probe) this.setExpanded(this.mode === 'card');
    });
    this.stage.addEventListener('pointerdown', this.onPointerDown);
    this.stage.addEventListener('pointermove', this.onPointerMove);
    this.stage.addEventListener('pointerup', this.onPointerUp);
    this.stage.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('keydown', this.onCanvasKey);
    this.canvas.addEventListener('focus', () => this.requestDraw());
    this.canvas.addEventListener('blur', () => this.requestDraw());

    // Probe readout (shown while the probe is placed).
    this.probeBox = make('div', 'viz-probe');
    this.probeBox.hidden = true;
    this.probeBox.setAttribute('role', 'status');
    this.probeBox.setAttribute('aria-live', 'polite');
    const cell = (name: string, cls: string): [HTMLElement, HTMLElement] => {
      const el = make('div', `viz-probe__cell ${cls}`);
      const value = make('b', 'viz-probe__value', '–');
      const sub = make('span', 'viz-probe__sub');
      el.append(make('span', 'viz-probe__name', name), value, sub);
      this.probeBox.append(el);
      return [value, sub];
    };
    const [speedValue, speedSub] = cell('Speed', 'viz-probe__cell--speed');
    const [pressureValue, pressureSub] = cell('Pressure', 'viz-probe__cell--pressure');
    const [directionValue] = cell('Heading', 'viz-probe__cell--direction');
    const inside = make('p', 'viz-probe__inside');
    inside.hidden = true;
    const hint = make(
      'p',
      'viz-probe__hint',
      'Drag the probe, or click the picture and use the arrow keys.',
    );
    this.probeBox.append(inside, hint);
    this.probeCells = {
      speed: speedValue,
      speedSub,
      pressure: pressureValue,
      pressureSub,
      direction: directionValue,
      inside,
      hint,
    };

    // Angle bookkeeping: wing tilt - downwash = what the air feels.
    const angles = make('div', 'viz-section-angles');
    angles.title =
      'The swirl from the wingtips pushes the air down a little (downwash), so the air meets this slice at a shallower angle than the wing is tilted.';
    const chip = (cls: string, name: string): HTMLElement => {
      const value = make('b', 'viz-angle__value', '–');
      const el = make('span', `viz-angle ${cls}`);
      el.append(make('span', 'viz-angle__name', name), value);
      angles.append(el);
      return value;
    };
    const tilt = chip('viz-angle--tilt', 'Wing tilt');
    this.downOp = make('span', 'viz-angle__op', '−');
    angles.append(this.downOp);
    const down = chip('viz-angle--down', 'Downwash');
    this.downName = down.previousElementSibling as HTMLElement;
    angles.append(make('span', 'viz-angle__op', '='));
    const feels = chip('viz-angle--feels', 'Air feels');
    this.angleValues = { tilt, down, feels };

    // Colour key.
    const legend = make('div', 'viz-section-legend');
    legend.setAttribute('aria-hidden', 'true');
    this.legendLow = make('span', 'viz-legend-end');
    this.legendBar = make('span', 'viz-legend-bar');
    this.legendMid = make('span', 'viz-legend-mid');
    this.legendHigh = make('span', 'viz-legend-end');
    const barWrap = make('span', 'viz-legend-scale');
    barWrap.append(this.legendBar, this.legendMid);
    legend.append(this.legendLow, barWrap, this.legendHigh);

    const sliderBox = make('div', 'viz-slider');
    this.sliderLabel = make('label');
    this.sliderLabel.htmlFor = `viz-section-eta-${uid}`;
    this.slider = make('input');
    this.slider.type = 'range';
    this.slider.id = `viz-section-eta-${uid}`;
    this.slider.min = '0';
    this.slider.max = '1';
    this.slider.step = '0.01';
    this.slider.addEventListener('input', () => this.onSlider());
    sliderBox.append(this.sliderLabel, this.slider);

    const caption = make('p', 'viz-caption', sectionCaption('tint', 'wing', null));
    this.caption = caption;

    this.el.append(toolbar, this.stage, this.probeBox, angles, legend, sliderBox, caption);
    root.appendChild(this.el);

    // Shown in the card while the picture is enlarged.
    this.away = make('div', 'viz-section-away');
    this.away.hidden = true;
    const back = make('button', 'viz-button', 'Show it here');
    back.type = 'button';
    back.addEventListener('click', () => this.setExpanded(false));
    this.away.append(make('span', undefined, 'The cross-section is open in the large view.'), back);
    root.appendChild(this.away);

    this.ctx = this.getContext(this.canvas);
    this.layer = doc.createElement('canvas');
    this.layerCtx = this.getContext(this.layer);
    this.field = doc.createElement('canvas');
    this.fieldCtx = this.getContext(this.field);

    try {
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      this.reducedMotion = false;
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[entries.length - 1]?.contentRect;
        if (rect) this.setSize(rect.width, rect.height);
      });
      this.resizeObserver.observe(this.stage);
    } else {
      this.setSize(this.stage.clientWidth, this.stage.clientHeight);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) {
          this.visible = last.isIntersecting;
          this.updateAnimation();
        }
      });
      this.intersectionObserver.observe(this.el);
    }
    doc.addEventListener('visibilitychange', this.onVisibility);

    this.unsubscribe.push(
      store.select(
        (s) => s.view.sectionEta,
        (eta) => this.syncSlider(eta),
        { fireNow: true },
      ),
      store.select(
        (s) => s.view.paused,
        () => this.updateAnimation(),
      ),
      store.select(
        (s) => s.view.sectionBackdrop,
        (backdrop) => {
          this.backdrop = backdrop === 'terrain' ? 'terrain' : 'tint';
          this.backdropControl.set(this.backdrop);
          this.syncLegend(this.store.get().view.colorBy);
          this.syncCaption();
          this.fieldDirty = true;
          this.staticDirty = true;
          this.requestDraw();
        },
        { fireNow: true },
      ),
      store.select(
        (s) => s.view.sectionFrame,
        (frame) => {
          this.frame = frame === 'air' ? 'air' : 'wing';
          this.frameControl.set(this.frame);
          if (this.frame === 'air') this.pulse = null;
          this.pulseButton.disabled = this.frame === 'air';
          this.arrowsToggle.disabled = this.frame === 'air';
          toggleLabel.classList.toggle('is-disabled', this.frame === 'air');
          this.pulseButton.title =
            this.frame === 'air'
              ? "Timing dots ride with the smoke, which the air's view hides"
              : 'Release a line of dots together and watch which side arrives first';
          this.syncCaption();
          this.staticDirty = true;
          this.requestDraw();
          this.updateAnimation();
        },
        { fireNow: true },
      ),
      store.select(
        (s) => s.view.sectionProbe,
        (probe) => this.setProbe(probe),
        { fireNow: true },
      ),
      store.select(
        (s) => s.view.units,
        () => this.syncProbeReadout(),
      ),
      results.select(
        (r) => r.aero,
        () => this.syncProbeReadout(),
      ),
      store.select(
        (s) => s.view.colorBy,
        (mode) => {
          this.syncLegend(mode);
          this.fieldDirty = true;
          this.staticDirty = true;
          this.requestDraw();
        },
        { fireNow: true },
      ),
      store.select(
        (s) => s.wing.flaps,
        () => {
          this.staticDirty = true;
          this.requestDraw();
        },
      ),
      results.select(
        (r) => r.section,
        (section) => this.setSection(section),
      ),
      results.select(
        (r) => r.pending.includes('section'),
        () => {
          // Only the placeholder message depends on this.
          if (!this.section) {
            this.staticDirty = true;
            this.requestDraw();
          }
        },
      ),
    );
    this.setSection(results.get().section);
  }

  /**
   * Release a vertical line of markers together and let them race along the streamlines.
   * The markers over the top reach the trailing edge sooner. (Frozen while paused.)
   */
  firePulse(): void {
    const prep = this.prep;
    if (!this.section || !prep || prep.lines.length === 0 || this.frame === 'air') return;
    // Start on a line just inside the left edge of the picture, so the markers are seen leaving.
    const startX = this.vt ? Math.max(prep.pulseX, this.vt.worldX(14)) : prep.pulseX;
    if (this.pulseStarts.length !== prep.lines.length) {
      this.pulseStarts = new Float64Array(prep.lines.length);
    }
    this.pulseStarts.fill(NaN);
    let longest = 0;
    const arrival = (indices: number[]): number => {
      let sum = 0;
      let n = 0;
      for (const i of indices) {
        const line = prep.lines[i]!;
        const hit = crossingAtX(line.disp, line.time, startX);
        if (!hit) continue;
        this.pulseStarts[i] = hit.t;
        longest = Math.max(longest, line.total - hit.t);
        if (Number.isFinite(line.teTime)) {
          sum += line.teTime - hit.t;
          n++;
        }
      }
      return n ? sum / n : NaN;
    };
    const top = arrival(this.pulseTop);
    const bottom = arrival(this.pulseBottom);
    this.pulse = { age: 0, longest, done: false, hold: PULSE_HOLD_SECONDS, startX, top, bottom };
    this.requestDraw();
    this.updateAnimation();
  }

  /** Show the picture large in a dialog (true) or back in its card (false). */
  setExpanded(on: boolean): void {
    if (this.destroyed || on === (this.mode === 'large')) return;
    const doc = this.root.ownerDocument;
    if (on) {
      this.ensureDialog();
      this.returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      this.mode = 'large';
      this.dialogSheet!.appendChild(this.el);
      this.away.hidden = false;
      this.dialog!.hidden = false;
      this.el.classList.add('is-large');
      this.dialogClose!.focus({ preventScroll: true });
    } else {
      this.mode = 'card';
      this.el.classList.remove('is-large');
      this.root.insertBefore(this.el, this.away);
      this.away.hidden = true;
      if (this.dialog) this.dialog.hidden = true;
      const back = this.returnFocus;
      this.returnFocus = null;
      (back?.isConnected ? back : this.expandButton).focus({ preventScroll: true });
    }
    // The stage is re-measured by the ResizeObserver; re-fit for the new mode right away too.
    this.vt = null;
    this.setSize(this.stage.clientWidth || this.cssW, this.stage.clientHeight || this.cssH, true);
  }

  /** True while the enlarged view is open. */
  isExpanded(): boolean {
    return this.mode === 'large';
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    if (this.drawQueued && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.drawQueued);
    }
    this.raf = 0;
    this.drawQueued = 0;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.el.ownerDocument.removeEventListener('visibilitychange', this.onVisibility);
    this.backdropControl.destroy();
    this.frameControl.destroy();
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.el.remove();
    this.away.remove();
    this.dialog?.remove();
    this.el.ownerDocument.removeEventListener('keydown', this.onDialogKey, true);
  }

  /** True while the requestAnimationFrame loop is running. */
  isAnimating(): boolean {
    return this.raf !== 0;
  }

  /** True while a timing pulse is on screen. */
  isPulseActive(): boolean {
    return this.pulse !== null;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Enlarged view                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  private ensureDialog(): void {
    if (this.dialog) return;
    const doc = this.root.ownerDocument;
    const titleId = `viz-section-title-${viewCounter}`;
    const dialog = doc.createElement('div');
    dialog.className = 'viz-root viz-section-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.hidden = true;
    const backdrop = doc.createElement('div');
    backdrop.className = 'viz-section-backdrop';
    backdrop.addEventListener('click', () => this.setExpanded(false));
    const sheet = doc.createElement('div');
    sheet.className = 'viz-section-sheet';
    const head = doc.createElement('header');
    head.className = 'viz-section-dialog-head';
    const titles = doc.createElement('div');
    const title = doc.createElement('h2');
    title.id = titleId;
    title.textContent = 'Cross-section of the wing';
    const subtitle = doc.createElement('p');
    subtitle.className = 'viz-section-dialog-sub';
    titles.append(title, subtitle);
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'viz-close';
    close.setAttribute('aria-label', 'Close the large view');
    close.title = 'Close (Esc)';
    close.appendChild(icon('close', 18));
    close.addEventListener('click', () => this.setExpanded(false));
    head.append(titles, close);
    sheet.append(head);
    dialog.append(backdrop, sheet);
    // Focusable as a whole, so a click on the picture keeps focus inside the dialog.
    sheet.tabIndex = -1;
    doc.addEventListener('keydown', this.onDialogKey, true);
    doc.body.appendChild(dialog);
    this.dialog = dialog;
    this.dialogSheet = sheet;
    this.dialogSubtitle = subtitle;
    this.dialogClose = close;
    this.syncSlider(this.store.get().view.sectionEta);
  }

  private trapFocus(e: KeyboardEvent): void {
    if (!this.dialogSheet) return;
    const focusable = [
      ...this.dialogSheet.querySelectorAll<HTMLElement>('button, input, select'),
    ].filter((n) => !n.hidden && !n.hasAttribute('disabled') && n.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = this.root.ownerDocument.activeElement;
    if (!this.dialogSheet.contains(active) || active === this.dialogSheet) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* State                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  private getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    try {
      return canvas.getContext('2d');
    } catch {
      return null; // no canvas implementation (some test environments)
    }
  }

  private onSlider(): void {
    const eta = Math.min(1, Math.max(0, Number(this.slider.value)));
    this.store.set((s) =>
      s.view.sectionEta === eta ? s : { ...s, view: { ...s.view, sectionEta: eta } },
    );
  }

  private syncSlider(eta: number): void {
    if (Number(this.slider.value) !== eta) this.slider.value = String(eta);
    const pct = Math.round(eta * 100);
    const where = pct <= 0 ? ' (at the body)' : pct >= 100 ? ' (at the wingtip)' : '';
    const text = `Slice at ${pct}% of the half-span${where}`;
    this.sliderLabel.textContent = text;
    this.slider.setAttribute('aria-valuetext', text);
    if (this.dialogSubtitle) {
      this.dialogSubtitle.textContent = `${text}. Air flows from left to right.`;
    }
  }

  private syncLegend(mode: AppState['view']['colorBy']): void {
    if (this.backdrop === 'terrain') {
      this.legendLow.textContent = 'Valley · low';
      this.legendMid.textContent = 'flat · normal';
      this.legendHigh.textContent = 'Hill · high';
      const rgb: [number, number, number] = [0, 0, 0];
      const stop = (cp: number, at: number): string => {
        terrainColor(cp, rgb);
        return `rgb(${rgb.map((v) => Math.round(v)).join(', ')}) ${at}%`;
      };
      this.legendBar.style.background = `linear-gradient(90deg, ${[
        stop(-1.6, 0),
        stop(-0.8, 22),
        stop(-0.25, 40),
        stop(0, 50),
        stop(0.25, 60),
        stop(0.6, 78),
        stop(1, 100),
      ].join(', ')})`;
      return;
    }
    if (mode === 'speed') {
      this.legendLow.textContent = 'Slow air';
      this.legendMid.textContent = 'normal';
      this.legendHigh.textContent = 'Fast air';
      const rgb: RGB = [0, 0, 0];
      const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `${rgbToCss(speedColor(t * 2, rgb))}`);
      this.legendBar.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
    } else {
      this.legendLow.textContent = 'Low pressure';
      this.legendMid.textContent = 'normal';
      this.legendHigh.textContent = 'High pressure';
      const rgb: RGB = [0, 0, 0];
      const stop = (cp: number, at: number): string => {
        const a = sectionPressureTint(cp, rgb);
        return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${a.toFixed(2)}) ${at}%`;
      };
      this.legendBar.style.background = `linear-gradient(90deg, ${[
        stop(-1.8, 0),
        stop(-0.8, 22),
        stop(-0.25, 40),
        stop(0, 50),
        stop(0.25, 60),
        stop(0.6, 78),
        stop(1, 100),
      ].join(', ')})`;
    }
  }

  private setAngles(section: SectionFlow | null): void {
    const fmt = (rad: number): string =>
      Number.isFinite(rad) ? `${((rad * 180) / Math.PI).toFixed(1)}°` : '–';
    this.angleValues.tilt.textContent = section ? fmt(section.alphaGeometric) : '–';
    // Negative induced angle is real (e.g. a still-lifting outboard wing during a partial
    // stall pushes air UP here): say "+ Upwash" rather than "− Downwash −3°".
    const upwash = section !== null && section.alphaInduced < 0;
    this.downOp.textContent = upwash ? '+' : '−';
    this.downName.textContent = upwash ? 'Upwash' : 'Downwash';
    this.angleValues.down.textContent = section ? fmt(Math.abs(section.alphaInduced)) : '–';
    this.angleValues.feels.textContent = section ? fmt(section.alphaEffective) : '–';
  }

  private setSection(section: SectionFlow | null): void {
    this.section = section;
    this.pulse = null;
    this.setAngles(section);
    if (section) {
      this.speed = speedGrid(section);
      this.prep = prepareStreamlines(section);
      this.pickPulseLines(this.prep);
      this.profile = surfaceProfile(section.contour);
      this.arrows = surfaceArrows(section, 9);
      this.contourDisp = contourToDisplay(section.contour, section.alphaEffective);
      this.separation = separationPolygon(section);
      this.cpX = centerOfPressureX(section.cp);
      if (this.cssW > 0) this.vt = this.fit(this.cssW, this.cssH, section.alphaEffective);
    } else {
      this.speed = null;
      this.prep = null;
      this.pulseTop = [];
      this.pulseBottom = [];
      this.profile = null;
      this.arrows = [];
      this.contourDisp = null;
      this.separation = null;
    }
    this.fieldDirty = true;
    this.staticDirty = true;
    this.syncCaption();
    this.syncProbeReadout();
    this.requestDraw();
    this.updateAnimation();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Probe and captions                                                                        */
  /* ---------------------------------------------------------------------------------------- */

  private syncCaption(): void {
    this.caption.textContent = sectionCaption(
      this.backdrop,
      this.frame,
      this.section ? (this.section.fieldCl ?? this.section.cl) : null,
    );
    const base =
      this.frame === 'air'
        ? "The air's view of a slice of the wing: arrows show how the passing wing moves the still air."
        : this.backdrop === 'terrain'
          ? 'Air flowing over a pressure landscape around a slice of the wing: valleys of low pressure, hills of high pressure, with contour lines.'
          : 'Air flowing past a slice of the wing: blue marks low pressure above, red high pressure below.';
    this.canvas.setAttribute(
      'aria-label',
      this.probe ? `${base} Probe placed: use the arrow keys to move it.` : base,
    );
  }

  /** Switch the probe on (at its default spot) or off. */
  toggleProbe(): void {
    const next = this.probe ? null : { ...DEFAULT_SECTION_PROBE };
    this.store.set((s) => ({ ...s, view: { ...s.view, sectionProbe: next } }));
    if (next) this.canvas.focus({ preventScroll: true });
  }

  private setProbe(probe: SectionProbe | null): void {
    this.probe = probe ? { x: probe.x, y: probe.y } : null;
    const on = this.probe !== null;
    this.probeButton.setAttribute('aria-pressed', String(on));
    this.probeButton.classList.toggle('is-active', on);
    this.stage.classList.toggle('is-probing', on);
    this.el.classList.toggle('has-probe', on);
    this.probeBox.hidden = !on;
    if (on) this.canvas.tabIndex = 0;
    else this.canvas.removeAttribute('tabindex');
    if (!on) this.dragging = false;
    this.syncCaption();
    this.syncProbeReadout();
    this.requestDraw();
  }

  private freestream(aero: AeroResult | null): ProbeFreestream {
    if (!aero) return { vInf: NaN, mach: 0, pInf: 101325, q: NaN };
    return {
      vInf: aero.velocity,
      mach: aero.mach,
      pInf: aero.atmosphere.pressure,
      q: aero.dynamicPressure,
    };
  }

  /** Fill the probe readout from the current section, probe position and freestream. */
  private syncProbeReadout(): void {
    const probe = this.probe;
    const section = this.section;
    const cells = this.probeCells;
    if (!probe) return;
    if (!section) {
      cells.speed.textContent = '–';
      cells.speedSub.textContent = 'Waiting for the flow…';
      cells.pressure.textContent = '–';
      cells.pressureSub.textContent = '';
      cells.direction.textContent = '–';
      return;
    }
    const aero = this.results.get().aero;
    const free = this.freestream(aero);
    const r = probeSection(section, probe.x, probe.y, free);
    const text = probeText(
      {
        inside: r.inside,
        speedRatio: r.speedRatio,
        vInf: free.vInf,
        deltaPressure: r.pressure.delta,
        pressureFraction: r.pressure.fraction,
        angleUp: r.angle,
        separated: r.separated,
      },
      this.store.get().view.units,
    );
    this.probeBox.classList.toggle('is-inside', r.inside);
    cells.inside.hidden = !r.inside;
    cells.inside.textContent = r.inside
      ? 'Inside the wing: no air here. Drag the probe out into the flow.'
      : '';
    if (r.inside) return;
    cells.speed.textContent = text.speed;
    cells.speedSub.textContent = text.speedCompare;
    const f = r.pressure.fraction;
    const same = !(Math.abs(f) >= 5e-5);
    cells.pressure.textContent = same
      ? 'Normal'
      : `${formatPercent(f)} ${f < 0 ? 'lower' : 'higher'}`;
    cells.pressure.dataset.sign = same ? '0' : f < 0 ? '-' : '+';
    cells.pressureSub.textContent = same
      ? 'same as the air around it'
      : `than the air around it (${text.pressureValue})`;
    cells.direction.textContent = text.direction;
    this.probeBox.setAttribute('aria-label', text.summary);
  }

  private moveProbe(x: number, y: number): void {
    const next = {
      x: Math.min(PROBE_LIMITS.xMax, Math.max(PROBE_LIMITS.xMin, x)),
      y: Math.min(PROBE_LIMITS.yMax, Math.max(PROBE_LIMITS.yMin, y)),
    };
    this.store.set((s) => ({ ...s, view: { ...s.view, sectionProbe: next } }));
  }

  private probeFromEvent(e: PointerEvent): void {
    const vt = this.vt;
    if (!vt) return;
    const rect = this.canvas.getBoundingClientRect();
    this.moveProbe(vt.worldX(e.clientX - rect.left), vt.worldY(e.clientY - rect.top));
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.probe || e.button !== 0) return;
    this.dragging = true;
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      /* not supported (tests) */
    }
    e.preventDefault();
    this.canvas.focus({ preventScroll: true });
    this.probeFromEvent(e);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) this.probeFromEvent(e);
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
  };

  private readonly onCanvasKey = (e: KeyboardEvent): void => {
    const probe = this.probe;
    if (!probe) return;
    const step = PROBE_STEP * (e.shiftKey ? 10 : 1);
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = moves[e.key];
    if (!d) return;
    e.preventDefault();
    this.moveProbe(probe.x + d[0], probe.y + d[1]);
  };

  /** The few streamlines nearest the wing on each side carry the timing markers. */
  private pickPulseLines(prep: PreparedStreamlines): void {
    const near = (side: 'top' | 'bottom'): number[] =>
      prep.lines
        .map((l, i) => ({ i, l }))
        .filter(({ l }) => l.side === side && Number.isFinite(l.teOffset))
        .sort((a, b) => Math.abs(a.l.teOffset) - Math.abs(b.l.teOffset))
        .slice(0, PULSE_PER_SIDE)
        .sort((a, b) => b.l.teOffset - a.l.teOffset)
        .map(({ i }) => i);
    this.pulseTop = near('top');
    this.pulseBottom = near('bottom');
    // Fallback for flows where no line reaches the trailing edge: use every line.
    if (this.pulseTop.length + this.pulseBottom.length === 0) {
      this.pulseTop = prep.lines.map((_, i) => i);
    }
  }

  private fit(width: number, height: number, alpha: number): ViewTransform {
    // The roomier framing only pays off on a wide picture; a narrow (phone) one keeps the
    // airfoil as big as the card does.
    const roomy = this.mode === 'large' && width >= 560;
    return fitView(width, height, alpha, roomy ? LARGE_VIEW : CARD_VIEW);
  }

  private setSize(width: number, height: number, force = false): void {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    const dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (!force && w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.vt = this.section && w > 0 ? this.fit(w, h, this.section.alphaEffective) : null;
    this.fieldDirty = true;
    this.staticDirty = true;
    this.requestDraw();
    this.updateAnimation();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Animation loop                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  private shouldAnimate(): boolean {
    if (this.destroyed || !this.section || !this.prep || this.cssW === 0) return false;
    if (!this.visible || this.el.ownerDocument.hidden) return false;
    if (this.store.get().view.paused) return false;
    // Reduced motion: only the explicit timing pulse moves.
    return !this.reducedMotion || this.pulse !== null;
  }

  private updateAnimation(): void {
    const should = this.shouldAnimate();
    if (should && !this.raf) {
      this.lastTime = 0;
      this.raf = requestAnimationFrame(this.tick);
    } else if (!should && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.lastTime = 0;
    }
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (!this.shouldAnimate()) {
      this.lastTime = 0;
      return;
    }
    const dt = this.lastTime ? Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000)) : 0;
    this.lastTime = now;
    this.advance(dt, this.store.get().view.playbackSpeed);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Advance the animation clocks by `dt` real seconds. Exposed (not private) for tests. */
  advance(dt: number, playbackSpeed: number): void {
    const dtChord = dt * CHORDS_PER_SECOND * playbackSpeed;
    if (!this.reducedMotion) this.clock += dtChord;
    const pulse = this.pulse;
    if (pulse && this.prep) {
      if (!pulse.done) {
        pulse.age += dtChord;
        if (pulse.age > pulse.longest + 0.05) pulse.done = true;
      } else {
        pulse.hold -= dt;
        if (pulse.hold <= 0) this.pulse = null;
      }
    }
  }

  /** Current clock values, for tests. */
  getClock(): { clock: number; pulseAge: number | null } {
    return { clock: this.clock, pulseAge: this.pulse ? this.pulse.age : null };
  }

  private requestDraw(): void {
    if (this.destroyed || this.raf || this.drawQueued) return; // the running loop will draw
    this.drawQueued = requestAnimationFrame(() => {
      this.drawQueued = 0;
      if (!this.destroyed) this.draw();
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Drawing                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.cssW < 20 || this.cssH < 20) return;
    const pxW = Math.round(this.cssW * this.dpr);
    const pxH = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;

    if (this.staticDirty) this.renderStatic(pxW, pxH);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);
    if (this.layerCtx) ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.frame === 'air') {
      this.drawDisturbanceMotion(ctx);
    } else {
      this.drawStreaks(ctx);
      this.drawPulse(ctx);
    }
    this.drawProbe(ctx);
  }

  /** Text size scale: a little larger in the enlarged view. */
  private get textScale(): number {
    return this.mode === 'large' ? 1.2 : 1;
  }

  /** Render the parts that only change with the data, size or toggles into the offscreen layer. */
  private renderStatic(pxW: number, pxH: number): void {
    const ctx = this.layerCtx;
    if (!ctx) return;
    this.staticDirty = false;
    if (this.layer.width !== pxW) this.layer.width = pxW;
    if (this.layer.height !== pxH) this.layer.height = pxH;
    const theme = readChartTheme(this.stage);
    this.fontFamily = theme.fontFamily;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = this.backgroundColor();
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.font = this.font(11);

    const section = this.section;
    const vt = this.vt;
    if (!section || !vt || !this.prep || !this.contourDisp || !this.profile) {
      const pending = this.results.get().pending.includes('section');
      ctx.fillStyle = TEXT_MUTED;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        pending
          ? 'Working out the flow…'
          : 'The cross-section appears after the first calculation.',
        this.cssW / 2,
        this.cssH / 2,
      );
      return;
    }

    this.renderField(vt);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.fieldImage) ctx.drawImage(this.field, 0, 0, this.cssW, this.cssH);
    if (this.backdrop === 'terrain') this.drawContours(ctx);

    const air = this.frame === 'air';
    if (air) this.drawDisturbance(ctx, vt, section);
    else this.drawStreamlines(ctx, vt);
    this.drawSeparation(ctx, vt, section);
    this.drawAirfoil(ctx, vt, this.contourDisp);
    this.drawFlapHinge(ctx, vt, section);
    if (this.showArrows && !air) this.drawSurfaceArrows(ctx, vt, section);
    this.drawStagnation(ctx, vt, section);
    this.drawLiftArrow(ctx, vt, section, theme.tokens['--lift'] ?? '#4ade80');
    this.drawAirflowCue(ctx);
    if (air) this.drawDisturbanceKey(ctx);
  }

  private backgroundColor(): string {
    try {
      const bg = getComputedStyle(this.stage).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    } catch {
      /* fall through */
    }
    return FALLBACK_BG;
  }

  private font(px: number, weight = ''): string {
    return `${weight} ${(px * this.textScale).toFixed(1)}px ${this.fontFamily}`.trim();
  }

  /** Resample the velocity grid into the offscreen field canvas (view-aligned). */
  private renderField(vt: ViewTransform): void {
    const ctx = this.fieldCtx;
    const section = this.section;
    if (!ctx || !section || !this.speed) return;
    if (!this.fieldDirty && this.fieldImage) return;
    this.fieldDirty = false;
    const w = Math.max(64, Math.min(420, Math.round(this.cssW / 1.6)));
    const h = Math.max(36, Math.round((w * this.cssH) / this.cssW));
    if (this.field.width !== w) this.field.width = w;
    if (this.field.height !== h) this.field.height = h;
    if (!this.fieldImage || this.fieldImage.width !== w || this.fieldImage.height !== h) {
      this.fieldImage = ctx.createImageData(w, h);
    }
    const win = {
      Xmin: vt.worldX(0),
      Xmax: vt.worldX(this.cssW),
      Ymax: vt.worldY(0),
      Ymin: vt.worldY(this.cssH),
    };
    if (this.backdrop === 'terrain') {
      if (!this.terrainCp || this.terrainCp.length !== w * h)
        this.terrainCp = new Float32Array(w * h);
      if (!this.terrainFade || this.terrainFade.length !== w * h) {
        this.terrainFade = new Float32Array(w * h);
      }
      sampleCpRaster(section, win, w, h, this.terrainCp, this.terrainFade);
      const pxPerChord = w / (win.Xmax - win.Xmin);
      fillTerrainImage(
        this.terrainCp,
        w,
        h,
        TERRAIN_RELIEF_CHORDS * pxPerChord,
        this.fieldImage.data,
        this.terrainFade,
      );
      const heights = terrainHeights(this.terrainCp, this.terrainFade);
      this.contours = TERRAIN_LEVELS.map((level) => ({
        level,
        segs: contourSegments(heights, w, h, level),
      }));
    } else {
      const mode = this.store.get().view.colorBy;
      fillFieldImage(section, this.speed, win, w, h, mode, this.fieldImage.data);
      this.contours = [];
    }
    ctx.putImageData(this.fieldImage, 0, 0);
  }

  /** Terrain contour lines; normal pressure ("sea level") is drawn brighter. */
  private drawContours(ctx: CanvasRenderingContext2D): void {
    if (this.contours.length === 0) return;
    const sx = this.cssW / this.field.width;
    const sy = this.cssH / this.field.height;
    ctx.lineJoin = 'round';
    for (const { level, segs } of this.contours) {
      if (segs.length === 0) continue;
      const sea = Math.abs(level) < 1e-9;
      const major = Math.abs(Math.round(level * 10)) % 5 === 0;
      ctx.strokeStyle = sea
        ? 'rgba(255, 255, 255, 0.7)'
        : level < 0
          ? `rgba(190, 225, 255, ${major ? 0.5 : 0.28})`
          : `rgba(255, 214, 196, ${major ? 0.55 : 0.32})`;
      ctx.lineWidth = sea ? 1.4 : major ? 1.1 : 0.8;
      ctx.beginPath();
      for (let k = 0; k + 3 < segs.length; k += 4) {
        ctx.moveTo(segs[k]! * sx, segs[k + 1]! * sy);
        ctx.lineTo(segs[k + 2]! * sx, segs[k + 3]! * sy);
      }
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The air's view                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  /** Static disturbance arrows (flow minus wind), exaggerated by a "nice" gain. */
  private drawDisturbance(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const spacingPx = DISTURBANCE_SPACING_PX[this.mode];
    const spacing = spacingPx / vt.scale;
    const win = {
      Xmin: vt.worldX(spacingPx * 0.5),
      Xmax: vt.worldX(this.cssW - spacingPx * 0.5),
      Ymax: vt.worldY(spacingPx * 0.5),
      Ymin: vt.worldY(this.cssH - spacingPx * 0.5),
    };
    this.dArrows = disturbanceArrows(section, win, spacing);
    this.dGain = disturbanceGain(this.dArrows, DISTURBANCE_ARROW_SPACINGS * spacing);
    // Key: the largest "nice" fraction of the wind whose arrow fits in about two spacings.
    let key: number = KEY_FRACTIONS[0];
    for (const f of KEY_FRACTIONS) if (f * this.dGain <= 2.2 * spacing) key = f;
    this.dKey = key;
    const head = this.mode === 'large' ? 6 : 4.5;
    const maxLen = 1.7 * spacingPx;
    for (const a of this.dArrows) {
      const mag = Math.hypot(a.dU, a.dV);
      let len = mag * this.dGain * vt.scale;
      if (len < 4) continue;
      len = Math.min(len, maxLen);
      const ux = a.dU / mag;
      const uy = -a.dV / mag; // screen y runs down
      const x0 = vt.x(a.X) - ux * len * 0.5;
      const y0 = vt.y(a.Y) - uy * len * 0.5;
      const alpha = Math.min(1, 0.35 + len / spacingPx);
      ctx.globalAlpha = alpha;
      this.arrow(ctx, x0, y0, x0 + ux * len, y0 + uy * len, DISTURBANCE_ARROW, 1.5, head);
    }
    ctx.globalAlpha = 1;
  }

  /** A bright dash that runs along each arrow: the direction reads even at a glance. */
  private drawDisturbanceMotion(ctx: CanvasRenderingContext2D): void {
    const vt = this.vt;
    if (!vt || this.dArrows.length === 0 || this.reducedMotion) return;
    const spacingPx = DISTURBANCE_SPACING_PX[this.mode];
    const maxLen = 1.7 * spacingPx;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = this.mode === 'large' ? 2.4 : 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < this.dArrows.length; i++) {
      const a = this.dArrows[i]!;
      const mag = Math.hypot(a.dU, a.dV);
      const len = Math.min(maxLen, mag * this.dGain * vt.scale);
      if (len < 6) continue;
      const ux = a.dU / mag;
      const uy = -a.dV / mag;
      const phase = (this.clock * 1.4 + ((i * 0.618034) % 1)) % 1;
      const x0 = vt.x(a.X) - ux * len * 0.5;
      const y0 = vt.y(a.Y) - uy * len * 0.5;
      const t0 = phase * 0.75 * len;
      const t1 = t0 + 0.25 * len;
      ctx.moveTo(x0 + ux * t0, y0 + uy * t0);
      ctx.lineTo(x0 + ux * t1, y0 + uy * t1);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** "Arrow = 10% of the wind speed" key, top-right. */
  private drawDisturbanceKey(ctx: CanvasRenderingContext2D): void {
    const vt = this.vt;
    if (!vt || this.dArrows.length === 0) return;
    const k = this.textScale;
    const len = Math.max(8, this.dKey * this.dGain * vt.scale);
    const text = `= ${Math.round(this.dKey * 100)}% of the wind speed`;
    const font = this.font(10.5, '600');
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    const boxW = len + tw + 26;
    const boxH = 22 * k;
    const x = this.cssW - boxW - 8;
    const y = 8;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, boxW, boxH, 6);
    else ctx.rect(x, y, boxW, boxH);
    ctx.fillStyle = 'rgba(7, 12, 21, 0.8)';
    ctx.fill();
    const cy = y + boxH / 2;
    this.arrow(
      ctx,
      x + 9,
      cy,
      x + 9 + len,
      cy,
      DISTURBANCE_ARROW,
      1.5,
      this.mode === 'large' ? 6 : 4.5,
    );
    this.label(ctx, text, x + len + 16, cy, 'left', TEXT_MUTED, font);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Probe marker                                                                              */
  /* ---------------------------------------------------------------------------------------- */

  private drawProbe(ctx: CanvasRenderingContext2D): void {
    const probe = this.probe;
    const vt = this.vt;
    const section = this.section;
    if (!probe || !vt || !section) return;
    const px = vt.x(probe.x);
    const py = vt.y(probe.y);
    const r = probeSection(section, probe.x, probe.y, this.freestream(this.results.get().aero));
    const big = this.mode === 'large';
    const ring = big ? 9 : 7.5;
    // Flow direction: a short arrow from the probe along the local velocity, longer when faster.
    if (!r.inside && Number.isFinite(r.angle)) {
      const len = (big ? 30 : 22) * Math.min(2, r.speedRatio);
      const ex = px + Math.cos(r.angle) * (ring + len);
      const ey = py - Math.sin(r.angle) * (ring + len);
      const sx = px + Math.cos(r.angle) * ring;
      const sy = py - Math.sin(r.angle) * ring;
      this.arrow(ctx, sx, sy, ex, ey, '#ffffff', big ? 2.4 : 2, big ? 9 : 7, HALO);
    }
    ctx.beginPath();
    ctx.arc(px, py, ring + 2, 0, Math.PI * 2);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, ring, 0, Math.PI * 2);
    ctx.strokeStyle = r.inside ? PROBE_INSIDE : PROBE_RING;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fillStyle = r.inside ? PROBE_INSIDE : PROBE_RING;
    ctx.fill();
    if (this.canvas.ownerDocument.activeElement === this.canvas) {
      ctx.beginPath();
      ctx.arc(px, py, ring + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(61, 214, 200, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // A compact tag: the pressure change, coloured like the pressure map.
    const f = r.pressure.fraction;
    const tag = r.inside
      ? 'inside the wing'
      : Number.isFinite(f)
        ? `${formatPercent(f)} ${f < 0 ? 'lower' : 'higher'} pressure`
        : '';
    if (!tag) return;
    const color = r.inside ? PROBE_INSIDE : f < 0 ? SUCTION_ARROW : PRESSURE_ARROW;
    const font = this.font(11, '700');
    ctx.font = font;
    const tw = ctx.measureText(tag).width;
    const right = px + ring + 6 + tw < this.cssW - 4;
    const ty = py - ring - 8 < 10 ? py + ring + 12 : py - ring - 8;
    this.label(
      ctx,
      tag,
      right ? px + ring + 4 : px - ring - 4,
      ty,
      right ? 'left' : 'right',
      color,
      font,
    );
  }

  private drawStreamlines(ctx: CanvasRenderingContext2D, vt: ViewTransform): void {
    const prep = this.prep!;
    ctx.strokeStyle = STREAMLINE;
    ctx.lineWidth = this.mode === 'large' ? 1.2 : 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const line of prep.lines) {
      const d = line.disp;
      if (d.length < 4) continue;
      ctx.moveTo(vt.x(d[0]!), vt.y(d[1]!));
      for (let i = 2; i + 1 < d.length; i += 2) ctx.lineTo(vt.x(d[i]!), vt.y(d[i + 1]!));
    }
    ctx.stroke();
  }

  /** Label the dead air of a stalled section (outline only when the solver gave no mask). */
  private drawSeparation(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const anchor = section.stalled || this.separation ? separatedLabelAnchor(section) : null;
    let labelX = NaN;
    let labelY = NaN;
    if (anchor) {
      labelX = vt.x(anchor.X);
      labelY = vt.y(anchor.Y) - 10 * this.textScale;
    } else if (this.separation) {
      const poly = this.separation;
      ctx.beginPath();
      for (let i = 0; i + 1 < poly.length; i += 2) {
        const px = vt.x(poly[i]!);
        const py = vt.y(poly[i + 1]!);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(70, 130, 230, 0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(200, 220, 250, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Label above the rear half of the patch, clear of the lift arrow near the front.
      const minX = vt.x(this.prep ? this.prep.teX : 1) - 20;
      let bestY = Infinity;
      for (let i = 0; i + 1 < poly.length; i += 2) {
        const px = vt.x(poly[i]!);
        const py = vt.y(poly[i + 1]!);
        if (px >= minX && py < bestY) {
          bestY = py;
          labelX = px;
        }
      }
      labelY = bestY - 8;
    }
    if (Number.isFinite(labelX) && Number.isFinite(labelY)) {
      ctx.font = this.font(11, '600');
      const half = ctx.measureText('Separated air (stall)').width / 2 + 4;
      const x = Math.min(Math.max(labelX, half), this.cssW - half);
      const y = Math.max(12, labelY);
      this.label(ctx, 'Separated air (stall)', x, y, 'center', TEXT, this.font(11, '600'));
    }
  }

  private drawAirfoil(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    contour: Float32Array,
  ): void {
    ctx.beginPath();
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i + 1 < contour.length; i += 2) {
      const px = vt.x(contour[i]!);
      const py = vt.y(contour[i + 1]!);
      top = Math.min(top, py);
      bottom = Math.max(bottom, py);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    let fill: string | CanvasGradient = '#1d2738';
    if (typeof ctx.createLinearGradient === 'function' && bottom > top) {
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, '#36435a');
      g.addColorStop(1, '#161e2c');
      fill = g;
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(230, 238, 252, 0.92)';
    ctx.lineWidth = this.mode === 'large' ? 1.6 : 1.3;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** A faint hinge line when a flap is deployed on this slice. */
  private drawFlapHinge(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const flaps = this.store.get().wing.flaps;
    if (!this.profile || flaps.deflectionDeg < 0.5 || section.eta > flaps.spanFrac + 1e-6) return;
    const x = 1 - flaps.chordFrac;
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const yu = surfaceY(this.profile.upperX, this.profile.upperY, x);
    const yl = surfaceY(this.profile.lowerX, this.profile.lowerY, x);
    ctx.strokeStyle = 'rgba(222, 233, 250, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(vt.x(displayX(c, s, x, yu)), vt.y(displayY(c, s, x, yu)));
    ctx.lineTo(vt.x(displayX(c, s, x, yl)), vt.y(displayY(c, s, x, yl)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawSurfaceArrows(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const head = Math.max(5, vt.scale * 0.03);
    const width = this.mode === 'large' ? 2.2 : 1.8;
    const lengthScale = this.mode === 'large' ? 1 : 0.9;
    for (const a of this.arrows) {
      const X = displayX(c, s, a.x, a.y);
      const Y = displayY(c, s, a.x, a.y);
      const nX = displayX(c, s, a.nx, a.ny);
      const nY = displayY(c, s, a.nx, a.ny);
      const len = a.length * vt.scale * lengthScale;
      if (len < 4) continue;
      const bx = vt.x(X);
      const by = vt.y(Y);
      // Screen y runs down, so a display-frame normal (nX, nY) points to (nX, -nY) on screen.
      const tx = bx + nX * len;
      const ty = by - nY * len;
      if (a.cp < 0) {
        // Suction pulls the surface outward: tail on the surface, head outside.
        this.arrow(ctx, bx + nX * 2, by - nY * 2, tx, ty, SUCTION_ARROW, width, head);
      } else {
        // Pressure pushes inward: tail outside, head on the surface.
        this.arrow(ctx, tx, ty, bx + nX, by - nY, PRESSURE_ARROW, width, head);
      }
    }
  }

  private drawStagnation(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const [sx, sy] = section.stagnation;
    const px = vt.x(displayX(c, s, sx, sy));
    const py = vt.y(displayY(c, s, sx, sy));
    ctx.beginPath();
    ctx.arc(px, py, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 140, 110, 0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = HALO;
    ctx.stroke();
    if (this.cssW >= 240) {
      const text = 'Stagnation point';
      const font = this.font(10.5);
      ctx.font = font;
      const width = ctx.measureText(text).width;
      // Below the nose along a short leader, where the incoming air is calm. Kept inside the
      // picture even when the leading edge is close to the left edge.
      const ly = py + 24 * this.textScale;
      const lx = Math.min(this.cssW - width - 6, Math.max(6, px - width * 0.75));
      ctx.strokeStyle = 'rgba(214, 228, 248, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - 1, py + 5);
      ctx.lineTo(Math.min(px - 1, lx + width * 0.75), ly - 7);
      ctx.stroke();
      this.label(ctx, text, lx, ly, 'left', TEXT_MUTED, font);
    }
  }

  /** Lift arrow from the centre of pressure, perpendicular to the oncoming air. */
  private drawLiftArrow(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
    color: string,
  ): void {
    const profile = this.profile!;
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const x = this.cpX;
    const y =
      (surfaceY(profile.upperX, profile.upperY, x) + surfaceY(profile.lowerX, profile.lowerY, x)) /
      2;
    const X = displayX(c, s, x, y);
    const Y = displayY(c, s, x, y);
    const lengthChords = Math.max(-0.75, Math.min(0.75, 0.5 * section.cl));
    const bx = vt.x(X);
    const by = vt.y(Y);
    // Keep the arrow head inside the picture, even for a big lift coefficient.
    const ty = Math.max(18, Math.min(this.cssH - 18, vt.y(Y + lengthChords)));
    if (Math.abs(ty - by) > 6) {
      const big = this.mode === 'large';
      this.arrow(ctx, bx, by, bx, ty, color, big ? 4 : 3, big ? 13 : 10, HALO);
      this.label(
        ctx,
        'Lift',
        bx + 9,
        ty + (ty < by ? 9 : -9) * this.textScale,
        'left',
        color,
        this.font(12, '700'),
      );
    }
  }

  /** A quiet "airflow" cue in the bottom-left corner. */
  private drawAirflowCue(ctx: CanvasRenderingContext2D): void {
    if (this.cssW < 220) return;
    const x = 10;
    const y = this.cssH - 12;
    const font = this.font(9.5, '600');
    ctx.font = font;
    if (this.frame === 'air') {
      this.arrow(ctx, x + 26, y, x + 2, y, 'rgba(182, 198, 220, 0.7)', 1.3, 5);
      this.label(
        ctx,
        'WING MOVES THROUGH STILL AIR',
        x + 32,
        y,
        'left',
        'rgba(182, 198, 220, 0.7)',
        font,
      );
      return;
    }
    const text = 'AIRFLOW';
    const w = ctx.measureText(text).width;
    this.label(ctx, text, x, y, 'left', 'rgba(182, 198, 220, 0.7)', font);
    this.arrow(ctx, x + w + 6, y, x + w + 30, y, 'rgba(182, 198, 220, 0.7)', 1.3, 5);
  }

  /** Smoke streaks released at a fixed time interval: fast air spreads them out and stretches them. */
  private drawStreaks(ctx: CanvasRenderingContext2D): void {
    const prep = this.prep;
    const vt = this.vt;
    if (!prep || !vt) return;
    const head = this.scratch;
    const tail = this.scratch2;
    const phase = ((this.clock % PUFF_SPACING) + PUFF_SPACING) % PUFF_SPACING;
    ctx.strokeStyle = STREAK;
    ctx.lineWidth = this.mode === 'large' ? 2.2 : 1.7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let li = 0; li < prep.lines.length; li++) {
      const line = prep.lines[li]!;
      if (line.total <= 0) continue;
      // Each line gets its own phase so the smoke looks like smoke, not a grid.
      const offset = ((li * 0.618034) % 1) * PUFF_SPACING;
      for (let t = (phase + offset) % PUFF_SPACING; t < line.total; t += PUFF_SPACING) {
        if (!positionAtTime(line, t, head)) continue;
        if (!positionAtTime(line, Math.max(line.time[0]!, t - STREAK_TIME), tail)) continue;
        const hx = vt.x(head[0]!);
        const hy = vt.y(head[1]!);
        let tx = vt.x(tail[0]!);
        let ty = vt.y(tail[1]!);
        // Keep a visible dot even where the air is almost still.
        if (Math.abs(hx - tx) + Math.abs(hy - ty) < 1.5) {
          tx = hx - 1.5;
          ty = hy;
        }
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
      }
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  private drawPulse(ctx: CanvasRenderingContext2D): void {
    const pulse = this.pulse;
    const prep = this.prep;
    const vt = this.vt;
    if (!pulse || !prep || !vt) return;
    const out = this.scratch;

    // Guide lines: where the markers start and the trailing edge they race towards.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    if (!pulse.done || pulse.age < 0.3) {
      ctx.moveTo(vt.x(pulse.startX), 0);
      ctx.lineTo(vt.x(pulse.startX), this.cssH);
    }
    ctx.moveTo(vt.x(prep.teX), 0);
    ctx.lineTo(vt.x(prep.teX), this.cssH);
    ctx.stroke();
    ctx.setLineDash([]);

    const radius = this.mode === 'large' ? 5.2 : 4.2;
    const group = (indices: number[], color: string): void => {
      // The "timeline": a thread through the markers that bends as they race.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let pen = false;
      for (const li of indices) {
        const line = prep.lines[li]!;
        if (!positionAtTime(line, this.pulseStarts[li]! + pulse.age, out)) {
          pen = false;
          continue;
        }
        const px = vt.x(out[0]!);
        const py = vt.y(out[1]!);
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        pen = true;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const li of indices) {
        const line = prep.lines[li]!;
        if (!positionAtTime(line, this.pulseStarts[li]! + pulse.age, out)) continue;
        const px = vt.x(out[0]!);
        const py = vt.y(out[1]!);
        ctx.beginPath();
        ctx.arc(px, py, radius + 1.6, 0, Math.PI * 2);
        ctx.fillStyle = HALO;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    };
    group(this.pulseTop, TOP_COLOR);
    group(this.pulseBottom, BOTTOM_COLOR);

    // Caption box, top-left.
    const showResult =
      pulse.done &&
      Number.isFinite(pulse.top) &&
      Number.isFinite(pulse.bottom) &&
      pulse.top < pulse.bottom - 0.005;
    const k = this.textScale;
    const boxW = 214 * k;
    const boxH = (showResult ? 58 : 42) * k;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(6, 6, boxW, boxH, 7);
    else ctx.rect(6, 6, boxW, boxH);
    ctx.fillStyle = 'rgba(7, 12, 21, 0.8)';
    ctx.fill();
    this.label(
      ctx,
      'Same start, different arrival',
      13,
      6 + 11 * k,
      'left',
      TEXT,
      this.font(11.5, '600'),
    );
    const rowY = 6 + 27 * k;
    ctx.fillStyle = TOP_COLOR;
    ctx.beginPath();
    ctx.arc(17, rowY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = BOTTOM_COLOR;
    ctx.beginPath();
    ctx.arc(17 + 92 * k, rowY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    this.label(ctx, 'over the top', 25, rowY, 'left', TEXT_MUTED);
    this.label(ctx, 'underneath', 25 + 92 * k, rowY, 'left', TEXT_MUTED);
    if (showResult) {
      this.label(ctx, 'The air over the top gets there first.', 13, 6 + 44 * k, 'left', TEXT);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Small drawing helpers                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  private label(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
    color: string,
    font = this.font(10.5),
  ): void {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = HALO;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /** Line with a triangular head at (x1, y1); an optional dark outline keeps it readable. */
  private arrow(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    width: number,
    head: number,
    outline?: string,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const h = Math.min(head, len * 0.7);
    const bx = x1 - ux * h * 0.8;
    const by = y1 - uy * h * 0.8;
    const lx = x1 - ux * h - uy * h * 0.5;
    const ly = y1 - uy * h + ux * h * 0.5;
    const rx = x1 - ux * h + uy * h * 0.5;
    const ry = y1 - uy * h - ux * h * 0.5;
    ctx.lineCap = 'butt';
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = width + 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(lx, ly);
    ctx.lineTo(rx, ry);
    ctx.closePath();
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.fill();
  }
}
