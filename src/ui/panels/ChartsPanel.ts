/**
 * Right-column charts: lift curve, load along the span, surface pressure and drag polar.
 * Every chart carries a one-line plain-language caption saying what to notice, plus a live
 * sentence about the wing's current state. Charts are drawn on demand (see LineChart), and only
 * the visible tab is recomputed when results change.
 */
import { pressureColor, rgbToCss } from '../../shared/colormaps';
import type { AppState } from '../../state/params';
import type { Store } from '../../state/store';
import type { ResultsState } from '../../state/results';
import {
  dragNote,
  dragPolarData,
  liftCurveData,
  liftCurveNote,
  pressureData,
  pressureNote,
  spanChartData,
  spanLoadNote,
} from '../charts/chartData';
import { LineChart, type ChartConfig, type ChartSeries } from '../charts/LineChart';
import '../styles/viz.css';

type TabId = 'lift' | 'span' | 'pressure' | 'drag';

interface TabDef {
  id: TabId;
  label: string;
  /** How many stacked charts the tab shows. */
  figures: number;
}

const TABS: readonly TabDef[] = [
  { id: 'lift', label: 'Lift curve', figures: 1 },
  { id: 'span', label: 'Along the span', figures: 2 },
  { id: 'pressure', label: 'Pressure', figures: 1 },
  { id: 'drag', label: 'Drag', figures: 1 },
];

const CAPTIONS = {
  lift: 'A real, finite wing makes less lift per degree than an endless one, because air leaks around the tips and the tip vortices weaken the lift.',
  load: 'How hard each part of the wing works. The dashed ellipse is the ideal sharing, the one that wastes the least energy.',
  stall:
    'How close each part of the wing is to stalling. Where the line reaches 100%, the air can no longer follow the surface there.',
  pressure:
    'Suction (pressure below the surrounding air) is plotted upward, as aerodynamicists do. The gap between the curves is the push that holds the wing up.',
  drag: 'Drag grows as you ask the wing for more lift. The steepest line from the corner that still touches the curve marks the most efficient way to fly.',
} as const;

let panelCounter = 0;

/** One chart with its caption, live note and empty-state message. */
class Figure {
  readonly el: HTMLElement;
  readonly chart: LineChart;
  private readonly empty: HTMLElement;
  private readonly note: HTMLElement;

  constructor(doc: Document, caption: string) {
    this.el = doc.createElement('figure');
    this.el.className = 'viz-figure';
    const plot = doc.createElement('div');
    plot.className = 'viz-chart-host';
    this.empty = doc.createElement('div');
    this.empty.className = 'viz-empty';
    this.empty.hidden = true;
    plot.appendChild(this.empty);
    const cap = doc.createElement('figcaption');
    cap.className = 'viz-caption';
    cap.textContent = caption;
    this.note = doc.createElement('p');
    this.note.className = 'viz-note';
    this.note.hidden = true;
    this.el.append(plot, cap, this.note);
    this.chart = new LineChart(plot);
  }

  show(config: ChartConfig, note: string | null): void {
    this.empty.hidden = true;
    this.chart.canvas.hidden = false;
    this.chart.setConfig(config);
    this.setNote(note);
  }

  showEmpty(message: string): void {
    this.empty.textContent = message;
    this.empty.hidden = false;
    this.chart.canvas.hidden = true;
    this.setNote(null);
  }

  setNote(text: string | null): void {
    this.note.textContent = text ?? '';
    this.note.hidden = !text;
  }

  setStale(on: boolean): void {
    this.el.classList.toggle('is-stale', on);
  }

  destroy(): void {
    this.chart.destroy();
    this.el.remove();
  }
}

const percentTick = (v: number): string => `${Math.round(v * 100)}%`;
const percentTip = (v: number): string => `${(v * 100).toFixed(0)}%`;

export class ChartsPanel {
  private readonly el: HTMLElement;
  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  private readonly panes = new Map<TabId, HTMLElement>();
  private readonly figures = new Map<TabId, Figure[]>();
  private readonly stale = new Set<TabId>(TABS.map((t) => t.id));
  private readonly unsubscribe: (() => void)[] = [];
  private active: TabId = 'lift';
  private last: Partial<Record<keyof ResultsState, unknown>> = {};

  constructor(
    root: HTMLElement,
    private readonly store: Store<AppState>,
    private readonly results: Store<ResultsState>,
  ) {
    const doc = root.ownerDocument;
    const uid = ++panelCounter;

    this.el = doc.createElement('section');
    this.el.className = 'viz-root viz-charts';
    this.el.setAttribute('aria-label', 'Charts');

    const tabs = doc.createElement('div');
    tabs.className = 'viz-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Chart type');
    this.el.appendChild(tabs);

    const captionsFor: Record<TabId, string[]> = {
      lift: [CAPTIONS.lift],
      span: [CAPTIONS.load, CAPTIONS.stall],
      pressure: [CAPTIONS.pressure],
      drag: [CAPTIONS.drag],
    };

    for (const tab of TABS) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'viz-tab';
      button.id = `viz-tab-${uid}-${tab.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `viz-pane-${uid}-${tab.id}`);
      button.textContent = tab.label;
      button.addEventListener('click', () => this.selectTab(tab.id));
      button.addEventListener('keydown', (e) => this.onTabKey(e, tab.id));
      tabs.appendChild(button);
      this.tabButtons.set(tab.id, button);

      const pane = doc.createElement('div');
      pane.className = 'viz-pane';
      pane.id = `viz-pane-${uid}-${tab.id}`;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', button.id);
      const figs = captionsFor[tab.id].map((c) => new Figure(doc, c));
      for (const f of figs) pane.appendChild(f.el);
      pane.classList.toggle('viz-pane-stacked', figs.length > 1);
      this.el.appendChild(pane);
      this.panes.set(tab.id, pane);
      this.figures.set(tab.id, figs);
    }
    root.appendChild(this.el);
    this.syncTabs();

    this.unsubscribe.push(
      results.subscribe((next) => this.onResults(next)),
      store.select(
        (s) => s.flow.alphaDeg,
        () => this.markStale('lift'),
      ),
    );
    this.last = this.snapshot(results.get());
    this.refreshActive();
  }

  destroy(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    for (const figs of this.figures.values()) for (const f of figs) f.destroy();
    this.el.remove();
  }

  /** Switch to a tab (also used by lessons or tests). */
  selectTab(id: TabId): void {
    if (this.active === id) return;
    this.active = id;
    this.syncTabs();
    if (this.stale.has(id)) this.refreshActive();
  }

  getActiveTab(): TabId {
    return this.active;
  }

  /* ---------------------------------------------------------------------------------------- */

  private onTabKey(e: KeyboardEvent, id: TabId): void {
    const order = TABS.map((t) => t.id);
    const i = order.indexOf(id);
    let target: TabId | null = null;
    if (e.key === 'ArrowRight') target = order[(i + 1) % order.length]!;
    else if (e.key === 'ArrowLeft') target = order[(i + order.length - 1) % order.length]!;
    else if (e.key === 'Home') target = order[0]!;
    else if (e.key === 'End') target = order[order.length - 1]!;
    if (!target) return;
    e.preventDefault();
    this.selectTab(target);
    this.tabButtons.get(target)?.focus();
  }

  private syncTabs(): void {
    for (const tab of TABS) {
      const on = tab.id === this.active;
      const button = this.tabButtons.get(tab.id)!;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle('is-active', on);
      this.panes.get(tab.id)!.hidden = !on;
    }
  }

  private snapshot(r: ResultsState): Partial<Record<keyof ResultsState, unknown>> {
    return {
      geometry: r.geometry,
      aero: r.aero,
      section: r.section,
      polar: r.polar,
      pending: r.pending,
      error: r.error,
    };
  }

  private onResults(next: ResultsState): void {
    const prev = this.last;
    const changed = (k: keyof ResultsState): boolean => prev[k] !== next[k];
    if (changed('polar') || changed('aero') || changed('pending') || changed('error')) {
      this.markStale('lift');
      this.markStale('drag');
    }
    if (changed('aero') || changed('geometry') || changed('pending') || changed('error')) {
      this.markStale('span');
    }
    if (changed('section') || changed('pending') || changed('error')) this.markStale('pressure');
    this.last = this.snapshot(next);
  }

  private markStale(id: TabId): void {
    this.stale.add(id);
    if (id === this.active) this.refreshActive();
  }

  private refreshActive(): void {
    const id = this.active;
    this.stale.delete(id);
    switch (id) {
      case 'lift':
        this.updateLift();
        break;
      case 'span':
        this.updateSpan();
        break;
      case 'pressure':
        this.updatePressure();
        break;
      case 'drag':
        this.updateDrag();
        break;
    }
  }

  private emptyMessage(what: string, stage: ResultsState['pending'][number]): string {
    const r = this.results.get();
    if (r.error) return `The calculation hit a problem: ${r.error}`;
    if (r.pending.includes(stage)) return `Working out the ${what}…`;
    return `The ${what} will appear after the first calculation.`;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Tabs                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  private updateLift(): void {
    const fig = this.figures.get('lift')![0]!;
    const r = this.results.get();
    if (!r.polar) {
      fig.showEmpty(this.emptyMessage('lift curve', 'polar'));
      return;
    }
    const data = liftCurveData(r.polar, this.store.get().flow.alphaDeg, r.aero);
    const series: ChartSeries[] = [
      {
        id: 'wing',
        label: 'Your wing',
        x: data.alphaDeg,
        y: data.wingCL,
        color: 'var(--series-1)',
        width: 2.5,
      },
      {
        id: 'endless',
        label: 'Endless wing (2D)',
        x: data.alphaDeg,
        y: data.sectionCL,
        color: 'var(--series-2)',
        width: 2,
        dash: [6, 4],
      },
    ];
    const config: ChartConfig = {
      x: { label: 'Angle of attack (°)', short: 'Angle', tickCount: 6 },
      y: { label: 'Lift coefficient', short: 'CL', includeZero: true },
      series,
      markers: data.current
        ? [
            {
              x: data.current.alphaDeg,
              y: data.current.CL,
              color: 'var(--lift)',
              label: 'You are here',
            },
          ]
        : [],
      vlines:
        data.stallAlphaDeg !== null
          ? [{ x: data.stallAlphaDeg, label: 'Stall', color: 'var(--drag)' }]
          : [],
      ariaLabel: 'Lift coefficient versus angle of attack, for your wing and for an endless wing',
    };
    fig.show(config, liftCurveNote(data));
    fig.setStale(r.pending.includes('polar'));
  }

  private updateSpan(): void {
    const [loadFig, stallFig] = this.figures.get('span')! as [Figure, Figure];
    const r = this.results.get();
    if (!r.aero) {
      const msg = this.emptyMessage('lift distribution', 'aero');
      loadFig.showEmpty(msg);
      stallFig.showEmpty(msg);
      return;
    }
    const data = spanChartData(r.aero, r.geometry);
    if (!data) {
      const msg = 'At this angle the wing makes almost no lift, so there is no sharing to show.';
      loadFig.showEmpty(msg);
      stallFig.showEmpty(msg);
      return;
    }
    const hasDevices = data.devices.length > 0;
    const xAxis = {
      label: 'Root → tip',
      short: 'Along wing',
      includeZero: true,
      tickCount: 6,
      format: (v: number) => percentTick(v),
      tooltipFormat: percentTip,
    };
    const tipLine = hasDevices ? [{ x: 1, label: 'wing tip' }] : [];

    const loadSeries: ChartSeries[] = [
      {
        id: 'ellipse',
        label: 'Ideal ellipse',
        x: data.ellipse.eta,
        y: data.ellipse.load,
        color: 'var(--series-2)',
        width: 2,
        dash: [6, 4],
      },
      {
        id: 'load',
        label: 'Your wing',
        x: data.wing.eta,
        y: data.wing.load,
        color: 'var(--series-1)',
        width: 2.5,
      },
      ...data.devices.map((d, i) => ({
        id: `load-dev-${i}`,
        label: 'Tip device',
        x: d.eta,
        y: d.load,
        color: 'var(--series-1)',
        width: 2.5,
        legend: false,
      })),
    ];
    loadFig.show(
      {
        x: xAxis,
        y: { label: 'Lift per metre (× average)', short: 'Load', includeZero: true },
        series: loadSeries,
        vlines: tipLine,
        xInclude: [1],
        legend: true,
        ariaLabel:
          'Lift per metre of span along the wing, compared with an ideal elliptical sharing',
      },
      null,
    );

    const stallSeries: ChartSeries[] = [
      {
        id: 'ratio',
        label: 'Your wing',
        x: data.wing.eta,
        y: data.wing.ratio,
        color: 'var(--series-1)',
        width: 2.5,
        legend: false,
      },
      ...data.devices.map((d, i) => ({
        id: `ratio-dev-${i}`,
        label: 'Tip device',
        x: d.eta,
        y: d.ratio,
        color: 'var(--series-1)',
        width: 2.5,
        legend: false,
      })),
    ];
    stallFig.show(
      {
        x: xAxis,
        y: {
          label: 'Closeness to stall',
          short: 'Of stall limit',
          min: 0,
          // Room for the 100% line and for any strip that is past it.
          max: Math.max(1.1, Math.ceil((data.closest?.ratio ?? 1) * 10 + 0.5) / 10),
          format: (v: number) => percentTick(v),
          tooltipFormat: percentTip,
        },
        series: stallSeries,
        vlines: tipLine,
        xInclude: [1],
        hlines: [{ y: 1, label: 'Stall limit', color: 'var(--drag)', dash: [] }],
        ariaLabel: 'Local lift as a fraction of the stall limit along the wing',
      },
      spanLoadNote(data),
    );
    const stale = r.pending.includes('aero');
    loadFig.setStale(stale);
    stallFig.setStale(stale);
  }

  private updatePressure(): void {
    const fig = this.figures.get('pressure')![0]!;
    const r = this.results.get();
    if (!r.section) {
      fig.showEmpty(this.emptyMessage('surface pressure', 'section'));
      return;
    }
    const data = pressureData(r.section);
    const upperColor = rgbToCss(pressureColor(-1.2));
    const lowerColor = rgbToCss(pressureColor(0.8));
    fig.show(
      {
        x: {
          label: 'Front → back of the wing section',
          short: 'Along chord',
          min: 0,
          max: 1,
          tickCount: 6,
          format: (v: number) => percentTick(v),
          tooltipFormat: percentTip,
        },
        y: {
          label: 'Pressure (Cp), suction up',
          short: 'Cp',
          inverted: true,
          includeZero: true,
        },
        series: [
          {
            id: 'upper',
            label: 'Top surface',
            x: data.xc,
            y: data.upper,
            color: upperColor,
            width: 2.5,
          },
          {
            id: 'lower',
            label: 'Underside',
            x: data.xc,
            y: data.lower,
            color: lowerColor,
            width: 2.5,
          },
        ],
        bands: [{ x: data.xc, y0: data.lower, y1: data.upper, color: 'var(--lift)', alpha: 0.16 }],
        hlines: [{ y: 0, label: 'surrounding air pressure', dash: [2, 3] }],
        ariaLabel: 'Pressure coefficient along the top and bottom of the wing section',
      },
      pressureNote(r.section),
    );
    fig.setStale(r.pending.includes('section'));
  }

  private updateDrag(): void {
    const fig = this.figures.get('drag')![0]!;
    const r = this.results.get();
    if (!r.polar) {
      fig.showEmpty(this.emptyMessage('drag polar', 'polar'));
      return;
    }
    const data = dragPolarData(r.polar, r.aero);
    const series: ChartSeries[] = [
      {
        id: 'polar',
        label: 'Your wing',
        x: data.CD,
        y: data.CL,
        color: 'var(--series-1)',
        width: 2.5,
      },
    ];
    if (data.bestGlide) {
      const k = 1.5;
      series.push({
        id: 'glide',
        label: `Best glide (L/D ${data.bestGlide.liftToDrag.toFixed(1)})`,
        x: [0, data.bestGlide.CD * k],
        y: [0, data.bestGlide.CL * k],
        color: 'var(--series-2)',
        width: 1.75,
        dash: [6, 4],
      });
    }
    fig.show(
      {
        x: { label: 'Drag coefficient', short: 'CD', includeZero: true },
        y: { label: 'Lift coefficient', short: 'CL', includeZero: true },
        series,
        markers: data.current
          ? [
              {
                x: data.current.CD,
                y: data.current.CL,
                color: 'var(--lift)',
                label: 'You are here',
              },
            ]
          : [],
        ariaLabel: 'Lift coefficient versus drag coefficient for your wing',
      },
      dragNote(data),
    );
    fig.setStale(r.pending.includes('polar'));
  }
}
