/**
 * Right-hand "Numbers" card: friendly big readouts for lift, drag and efficiency, a lift-versus-
 * weight gauge for the current aircraft, stall and Mach warnings, and (engineer mode) a compact
 * table of coefficients and flow numbers.
 *
 * DOM is built once; every update only changes text, attributes and CSS custom properties.
 * Tolerates `aero === null` (nothing computed yet) and shows a "computing…" state while the
 * worker still has stages in flight.
 */
import type { AeroResult, WingGeometry } from '../../physics/types';
import { getPreset } from '../../state/presets';
import type { AppState } from '../../state/params';
import type { Store } from '../../state/store';
import type { ResultsState } from '../../state/results';
import {
  formatNumber,
  formatParts,
  formatQuantity,
  massSupportedByLift,
  unitFor,
  weightOfMass,
} from '../../shared/units';
import type { UnitSystem } from '../../shared/units';
import { clamp, h, setHidden } from '../dom';

/** Stall margin (clMax - cl, in section lift coefficient) below which we say "approaching stall". */
export const APPROACHING_STALL_MARGIN = 0.3;

/** The lift/weight ratio treated as "level flight". */
const LEVEL_FLIGHT_BAND: readonly [number, number] = [0.9, 1.1];
/** Gauge scale: the bar runs from 0 to this multiple of the aircraft's weight. */
const GAUGE_MAX_RATIO = 2;

const DASH = '–';

interface Metric {
  el: HTMLElement;
  value: HTMLElement;
  unit: HTMLElement;
  sub: HTMLElement;
}

function metric(modifier: string, title: string): Metric {
  const value = h('span', { class: 'metric__number' }, DASH);
  const unit = h('span', { class: 'metric__unit' });
  const sub = h('p', { class: 'metric__sub' });
  const el = h(
    'article',
    { class: `metric metric--${modifier}` },
    h('h3', { class: 'metric__title' }, title),
    h('div', { class: 'metric__value' }, value, unit),
    sub,
  );
  return { el, value, unit, sub };
}

interface Banner {
  el: HTMLElement;
  title: HTMLElement;
  text: HTMLElement;
}

/** Drag-divergence Mach, or a typical margin above the critical Mach when it is unknown. */
function dragDivergenceOf(machCritical: number, machDragDivergence: number): number {
  return Number.isFinite(machDragDivergence) && machDragDivergence > machCritical
    ? machDragDivergence
    : machCritical + 0.08;
}

/** How much the Mach number deserves to be mentioned. */
export function machLevel(
  mach: number,
  machCritical: number,
  machDragDivergence: number,
): 'none' | 'info' | 'warning' {
  if (!(Number.isFinite(mach) && Number.isFinite(machCritical) && machCritical > 0)) return 'none';
  if (mach <= machCritical) return 'none';
  return mach > dragDivergenceOf(machCritical, machDragDivergence) ? 'warning' : 'info';
}

function banner(kind: 'stall' | 'approach' | 'mach' | 'info' | 'error'): Banner {
  const title = h('strong', { class: 'banner__title' });
  const text = h('span', { class: 'banner__text' });
  const el = h(
    'div',
    { class: `banner banner--${kind}`, role: kind === 'error' ? 'alert' : 'status', hidden: true },
    title,
    text,
  );
  return { el, title, text };
}

interface EngineerRow {
  symbol: string;
  description: string;
  cell: HTMLElement;
}

export class ReadoutPanel {
  private readonly root: HTMLElement;
  private readonly store: Store<AppState>;
  private readonly results: Store<ResultsState>;
  private readonly unsubscribers: (() => void)[] = [];

  private readonly status = h('p', { class: 'readouts__status', 'aria-live': 'polite' });
  private readonly stallBanner = banner('stall');
  private readonly approachBanner = banner('approach');
  private readonly machNote = banner('info');
  private readonly machBanner = banner('mach');
  private readonly errorBanner = banner('error');

  private readonly lift = metric('lift', 'Lift');
  private readonly drag = metric('drag', 'Drag');
  private readonly efficiency = metric('ld', 'Efficiency');

  private readonly gaugeCard = h('article', { class: 'metric metric--gauge', hidden: true });
  private readonly gaugeBar = h('div', {
    class: 'gauge',
    role: 'meter',
    'aria-label': "Lift compared with the aircraft's weight",
    'aria-valuemin': 0,
    'aria-valuemax': GAUGE_MAX_RATIO * 100,
  });
  private readonly gaugeFill = h('div', { class: 'gauge__fill' });
  private readonly gaugeValue = h('span', { class: 'metric__number' }, DASH);
  private readonly gaugeText = h('p', { class: 'metric__sub' });

  private readonly engineer = h('section', { class: 'engineer', hidden: true });
  private readonly engineerRows: EngineerRow[] = [];
  private readonly warnings = h('ul', { class: 'engineer__warnings' });

  constructor(root: HTMLElement, store: Store<AppState>, results: Store<ResultsState>) {
    this.root = root;
    this.store = store;
    this.results = results;
    root.classList.add('readouts');

    this.buildGauge();
    this.buildEngineerTable();
    root.append(
      this.status,
      h(
        'div',
        { class: 'banners' },
        this.errorBanner.el,
        this.stallBanner.el,
        this.approachBanner.el,
        this.machBanner.el,
      ),
      h('div', { class: 'metric-grid' }, this.lift.el, this.drag.el, this.efficiency.el),
      // Calm notes (not warnings) sit under the numbers they explain.
      this.machNote.el,
      this.engineer,
    );
    // Lift and "compared with weight" tell one story, so they share a card.
    this.lift.el.append(this.gaugeCard);

    this.render();
    this.unsubscribers.push(
      store.subscribe(() => this.render()),
      results.subscribe(() => this.render()),
    );
  }

  destroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.root.classList.remove('readouts');
    this.root.removeAttribute('aria-busy');
    this.root.replaceChildren();
  }

  /* -------------------------------------------------------------------------------------- */
  /* Build                                                                                    */
  /* -------------------------------------------------------------------------------------- */

  private buildGauge(): void {
    this.gaugeBar.append(
      h('div', { class: 'gauge__track' }, this.gaugeFill, h('div', { class: 'gauge__mark' })),
      h(
        'div',
        { class: 'gauge__scale', 'aria-hidden': 'true' },
        h('span', null, '0'),
        h('span', null, 'Weight'),
        h('span', null, `${GAUGE_MAX_RATIO}×`),
      ),
    );
    this.gaugeCard.append(
      h('h3', { class: 'metric__title' }, 'Lift compared with weight'),
      h(
        'div',
        { class: 'metric__value' },
        this.gaugeValue,
        h('span', { class: 'metric__unit' }, 'of weight'),
      ),
      this.gaugeBar,
      this.gaugeText,
    );
  }

  private buildEngineerTable(): void {
    const defs: [string, string][] = [
      ['CL', 'Lift coefficient'],
      ['CDi', 'Induced drag coefficient'],
      ['CD0', 'Profile drag coefficient'],
      ['CDw', 'Wave drag coefficient'],
      ['CD', 'Total drag coefficient'],
      ['e', 'Span efficiency'],
      ['AR', 'Aspect ratio'],
      ['S', 'Wing area'],
      ['b', 'Span'],
      ['MAC', 'Mean chord'],
      ['Re', 'Reynolds number'],
      ['Mach', 'Mach number'],
      ['q', 'Dynamic pressure'],
      ['rho', 'Air density'],
      ['Mcrit', 'Critical Mach number'],
      ['CLα', 'Lift-curve slope'],
    ];
    const tbody = h('tbody');
    for (const [symbol, description] of defs) {
      const cell = h('td', { class: 'engineer__value' }, DASH);
      this.engineerRows.push({ symbol, description, cell });
      tbody.append(
        h(
          'tr',
          null,
          h(
            'th',
            { scope: 'row', class: 'engineer__symbol' },
            symbol,
            h('span', { class: 'engineer__desc' }, description),
          ),
          cell,
        ),
      );
    }
    this.engineer.append(
      h('h3', { class: 'metric__title' }, 'Engineering numbers'),
      h('table', { class: 'engineer__table' }, tbody),
      this.warnings,
    );
  }

  /* -------------------------------------------------------------------------------------- */
  /* Render                                                                                   */
  /* -------------------------------------------------------------------------------------- */

  private render(): void {
    const state = this.store.get();
    const { aero, geometry, pending, error } = this.results.get();
    const system = state.view.units;
    const computing = pending.length > 0;

    this.root.classList.toggle('is-computing', computing);
    this.root.setAttribute('aria-busy', String(computing));
    this.status.textContent = computing
      ? 'computing…'
      : aero
        ? ''
        : 'Waiting for the first results…';
    setHidden(this.status, !computing && aero !== null);

    this.renderBanners(aero, error);
    this.renderMetrics(aero, system);
    this.renderGauge(aero, state, system);
    setHidden(this.engineer, !state.view.engineerMode);
    if (state.view.engineerMode) this.renderEngineer(aero, geometry, system);
  }

  private renderBanners(aero: AeroResult | null, error: string | null): void {
    setHidden(this.errorBanner.el, error === null);
    if (error !== null) {
      this.errorBanner.title.textContent = 'Something went wrong. ';
      this.errorBanner.text.textContent = `The numbers could not be computed (${error}).`;
    }

    const stalled = aero?.stall.any === true;
    setHidden(this.stallBanner.el, !stalled);
    if (aero && stalled) {
      const pct = Math.max(1, Math.round(aero.stall.fraction * 100));
      this.stallBanner.title.textContent = `Stall! Air has separated from ${pct}% of the wing. `;
      this.stallBanner.text.textContent =
        'The smooth flow has broken away from the top surface, so lift drops and drag climbs. Lower the angle of attack to recover.';
    }

    const margin = aero?.stall.margin;
    const approaching =
      aero !== null &&
      !stalled &&
      margin !== undefined &&
      Number.isFinite(margin) &&
      margin < APPROACHING_STALL_MARGIN;
    setHidden(this.approachBanner.el, !approaching);
    if (approaching) {
      this.approachBanner.title.textContent = 'Getting close to stall. ';
      this.approachBanner.text.textContent =
        'Part of the wing is nearly at the limit of how much it can lift. A little more angle and the air will let go.';
    }

    this.renderMach(aero);
  }

  /**
   * Mach messaging in three calm steps. Up to the critical Mach: nothing to say. Between it and
   * the drag-divergence Mach some air over the wing is supersonic, which is what airliners do
   * every day in cruise, so this is an information note, not a warning. Only past drag
   * divergence, where shock waves make drag climb steeply, does the amber warning appear.
   */
  private renderMach(aero: AeroResult | null): void {
    const crit = aero?.machCritical ?? NaN;
    const known = aero !== null && Number.isFinite(crit) && crit > 0;
    const level = !aero || !known ? 'none' : machLevel(aero.mach, crit, aero.machDragDivergence);
    setHidden(this.machNote.el, level !== 'info');
    setHidden(this.machBanner.el, level !== 'warning');
    if (!aero) return;
    if (level === 'info') {
      this.machNote.title.textContent = `Mach ${formatNumber(aero.mach, 2)}: some air over the wing is now supersonic. `;
      this.machNote.text.textContent =
        'Normal for jets in cruise; it is why airliner wings are swept and use special airfoils.';
    } else if (level === 'warning') {
      const divergence = dragDivergenceOf(crit, aero.machDragDivergence);
      this.machBanner.title.textContent = `Mach ${formatNumber(aero.mach, 2)} is past this wing's drag rise (about Mach ${formatNumber(divergence, 2)}). `;
      this.machBanner.text.textContent = `Shock waves on the wing are now strong enough that drag climbs steeply (shocks first form at Mach ${formatNumber(crit, 2)}). More sweep or a thinner wing pushes this limit higher.`;
    }
  }

  private setMetric(m: Metric, value: string, unit: string, sub: string): void {
    m.value.textContent = value;
    m.unit.textContent = unit;
    m.sub.textContent = sub;
  }

  private renderMetrics(aero: AeroResult | null, system: UnitSystem): void {
    if (!aero) {
      const waiting = 'Waiting for the first results…';
      this.setMetric(this.lift, DASH, '', waiting);
      this.setMetric(this.drag, DASH, '', waiting);
      this.setMetric(this.efficiency, DASH, '', waiting);
      return;
    }

    const lift = formatParts('force', aero.lift, system);
    const mass = formatParts('mass', massSupportedByLift(aero.lift), system);
    const massName = unitFor('mass', system).name;
    this.setMetric(
      this.lift,
      lift.value,
      lift.unit,
      aero.lift > 0
        ? `Enough lift to hold up ${mass.value} ${massName}.`
        : 'The wing is pushing down, not up.',
    );

    const drag = formatParts('force', aero.drag, system);
    const share = aero.drag > 0 ? Math.round((aero.inducedDrag / aero.drag) * 100) : NaN;
    this.setMetric(
      this.drag,
      drag.value,
      drag.unit,
      Number.isFinite(share) && share > 0
        ? `About ${clamp(share, 0, 100)}% of it comes from the wingtip swirl.`
        : 'Air resistance the engines must overcome.',
    );

    const ld = aero.liftToDrag;
    this.setMetric(
      this.efficiency,
      Number.isFinite(ld) ? formatNumber(ld, 1) : DASH,
      'lift per drag',
      Number.isFinite(ld) && ld > 0
        ? 'Lift for each unit of drag. Higher is better.'
        : 'Lift per unit of drag. Higher is better.',
    );
  }

  private renderGauge(aero: AeroResult | null, state: AppState, system: UnitSystem): void {
    const preset = state.presetId ? getPreset(state.presetId) : undefined;
    const massKg = preset?.typicalCruiseMassKg;
    const visible = aero !== null && massKg !== undefined && massKg > 0;
    setHidden(this.gaugeCard, !visible);
    if (!aero || !massKg || massKg <= 0) return;

    const ratio = aero.lift / weightOfMass(massKg);
    const pct = Math.round(ratio * 100);
    const weight = formatQuantity('mass', massKg, system);
    const [low, high] = LEVEL_FLIGHT_BAND;
    const state_ = ratio < low ? 'low' : ratio > high ? 'high' : 'ok';

    this.gaugeCard.dataset.level = state_;
    this.gaugeValue.textContent = Number.isFinite(pct) ? `${pct}%` : DASH;
    this.gaugeFill.style.setProperty('--fill', `${clamp(ratio / GAUGE_MAX_RATIO, 0, 1) * 100}%`);
    this.gaugeBar.setAttribute('aria-valuenow', String(clamp(pct, 0, GAUGE_MAX_RATIO * 100)));
    this.gaugeBar.setAttribute('aria-valuetext', `${pct}% of the aircraft's weight`);
    this.gaugeText.textContent =
      state_ === 'low'
        ? `The ${preset?.shortName ?? 'aircraft'} weighs about ${weight}. Not enough lift to stay up: it would sink.`
        : state_ === 'ok'
          ? `Matches the ${preset?.shortName ?? 'aircraft'}'s weight of about ${weight}: steady, level flight.`
          : `More than the ${preset?.shortName ?? 'aircraft'}'s weight of about ${weight}: it would climb.`;
  }

  private renderEngineer(
    aero: AeroResult | null,
    geometry: WingGeometry | null,
    system: UnitSystem,
  ): void {
    const values: string[] = aero
      ? [
          formatNumber(aero.CL, 3),
          formatNumber(aero.CDi, 4),
          formatNumber(aero.CD0, 4),
          formatNumber(aero.CDw, 4),
          formatNumber(aero.CD, 4),
          formatNumber(aero.spanEfficiency, 3),
          geometry ? formatNumber(geometry.aspectRatio, 1) : DASH,
          geometry ? formatQuantity('area', geometry.referenceArea, system) : DASH,
          geometry ? formatQuantity('length', geometry.referenceSpan, system) : DASH,
          geometry ? formatQuantity('length', geometry.meanAeroChord, system) : DASH,
          Number.isFinite(aero.reynoldsMac)
            ? `${formatNumber(aero.reynoldsMac / 1e6, 2)} million`
            : DASH,
          formatNumber(aero.mach, 3),
          `${formatNumber(aero.dynamicPressure, 0)} Pa`,
          `${formatNumber(aero.atmosphere.density, 3)} kg/m³`,
          formatNumber(aero.machCritical, 3),
          `${formatNumber(aero.liftSlope, 2)} per rad`,
        ]
      : this.engineerRows.map(() => DASH);

    this.engineerRows.forEach((row, i) => {
      row.cell.textContent = values[i] ?? DASH;
    });

    this.warnings.replaceChildren(...(aero?.warnings ?? []).map((w) => h('li', null, w)));
    setHidden(this.warnings, !aero || aero.warnings.length === 0);
  }
}
