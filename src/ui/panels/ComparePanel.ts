/**
 * Side-by-side comparison of two aircraft presets: planforms overlaid at one scale, a table of
 * the numbers that matter, and a plain-language "why they differ" list.
 *
 * Visible whenever AppState.compare is non-null; closing sets it back to null. The two wings
 * are solved at their typical cruise conditions through the injected `requestCompare`.
 */
import type { AeroResult, WingGeometry } from '../../physics/types';
import type { AppState, FlowConditions, WingConfig } from '../../state/params';
import { PRESETS, getPreset, type AircraftPreset, type PresetCategory } from '../../state/presets';
import type { Store } from '../../state/store';
import {
  buildPlanformSvg,
  compareRows,
  explainDifferences,
  formatLength,
  planformShapes,
  summarizeCase,
  type CaseSummary,
} from '../charts/compareData';
import '../styles/viz.css';

export type CompareRequester = (
  cases: { id: string; wing: WingConfig; flow: FlowConditions }[],
) => Promise<{ id: string; geometry: WingGeometry; aero: AeroResult }[]>;

const CATEGORY_LABELS: Record<PresetCategory, string> = {
  airliner: 'Airliners',
  'general-aviation': 'General aviation',
  glider: 'Gliders',
  fighter: 'Fighters',
  teaching: 'Teaching wings',
};
const CATEGORY_ORDER: PresetCategory[] = [
  'airliner',
  'general-aviation',
  'glider',
  'fighter',
  'teaching',
];

type Slot = 'a' | 'b';
type Status = 'loading' | 'ready' | 'error';

let compareCounter = 0;

export class ComparePanel {
  private readonly el: HTMLElement;
  private readonly card: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly selects: Record<Slot, HTMLSelectElement>;
  private readonly blurbs: Record<Slot, HTMLElement>;
  private readonly headerCells: Record<Slot, HTMLTableCellElement>;
  private readonly statusEl: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly planformEl: HTMLElement;
  private readonly planformBox: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly tbody: HTMLTableSectionElement;
  private readonly why: HTMLElement;
  private readonly whyList: HTMLElement;
  private readonly unsubscribe: (() => void)[] = [];

  private open = false;
  private ids: [string, string] | null = null;
  private status: Status = 'loading';
  private errorMessage = '';
  private summaries: [CaseSummary, CaseSummary] | null = null;
  private token = 0;
  private previousFocus: Element | null = null;
  private destroyed = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'Tab') {
      this.trapFocus(e);
    }
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store<AppState>,
    private readonly requestCompare: CompareRequester,
  ) {
    const doc = root.ownerDocument;
    const uid = ++compareCounter;
    const h = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className?: string,
      text?: string,
    ): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    this.el = h('div', 'viz-compare');
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    const titleId = `viz-compare-title-${uid}`;
    this.el.setAttribute('aria-labelledby', titleId);

    const backdrop = h('div', 'viz-compare-backdrop');
    backdrop.addEventListener('click', () => this.close());
    this.card = h('div', 'viz-compare-card');

    const head = h('header', 'viz-compare-head');
    const title = h('h2', undefined, 'Compare two aircraft');
    title.id = titleId;
    this.closeButton = h('button', 'viz-close', '×');
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', 'Close comparison');
    this.closeButton.addEventListener('click', () => this.close());
    head.append(title, this.closeButton);

    const pickers = h('div', 'viz-compare-pickers');
    const makePicker = (slot: Slot, text: string): HTMLSelectElement => {
      const label = h('label', `viz-picker viz-picker-${slot}`);
      label.append(doc.createTextNode(text));
      const select = h('select');
      select.dataset.slot = slot;
      this.fillOptions(select);
      select.addEventListener('change', () => this.onPick(slot, select.value));
      label.appendChild(select);
      pickers.appendChild(label);
      return select;
    };
    this.selects = { a: makePicker('a', 'Aircraft A'), b: makePicker('b', 'Aircraft B') };

    const blurbs = h('div', 'viz-compare-blurbs');
    this.blurbs = { a: h('p'), b: h('p') };
    blurbs.append(this.blurbs.a, this.blurbs.b);

    this.statusEl = h('div', 'viz-compare-status');
    this.statusEl.setAttribute('role', 'status');
    this.statusText = h('span');
    this.retryButton = h('button', 'viz-button', 'Try again');
    this.retryButton.type = 'button';
    this.retryButton.hidden = true;
    this.retryButton.addEventListener('click', () => {
      if (this.ids) this.load(this.ids);
    });
    this.statusEl.append(this.statusText, doc.createTextNode(' '), this.retryButton);
    this.planformEl = h('div', 'viz-compare-planform');
    const planformCaption = h(
      'p',
      'viz-caption',
      'Both wings drawn to the same scale and lined up at the root, so you can see the real difference in size.',
    );
    this.planformBox = h('div');
    this.planformBox.append(this.planformEl, planformCaption);

    this.table = h('table', 'viz-compare-table');
    const caption = h('caption', undefined, 'How the two wings compare at typical cruise');
    const thead = h('thead');
    const headRow = h('tr');
    const corner = h('th', undefined, 'Measure');
    corner.scope = 'col';
    this.headerCells = { a: h('th', 'viz-col-a'), b: h('th', 'viz-col-b') };
    this.headerCells.a.scope = 'col';
    this.headerCells.b.scope = 'col';
    headRow.append(corner, this.headerCells.a, this.headerCells.b);
    thead.appendChild(headRow);
    this.tbody = h('tbody');
    this.table.append(caption, thead, this.tbody);

    this.why = h('section', 'viz-compare-why');
    this.why.appendChild(h('h3', undefined, 'Why they differ'));
    this.whyList = h('ul');
    this.why.appendChild(this.whyList);

    this.card.append(head, pickers, blurbs, this.statusEl, this.planformBox, this.table, this.why);
    this.el.append(backdrop, this.card);
    root.appendChild(this.el);
    doc.addEventListener('keydown', this.onKeyDown);

    this.unsubscribe.push(
      store.select(
        (s) => s.compare,
        () => this.sync(),
        { fireNow: true },
      ),
      store.select(
        (s) => s.view.units,
        () => {
          if (this.open) this.renderResults();
        },
      ),
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.token++;
    this.root.ownerDocument.removeEventListener('keydown', this.onKeyDown);
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.el.remove();
  }

  /** True while the comparison is on screen. */
  isOpen(): boolean {
    return this.open;
  }

  /* ---------------------------------------------------------------------------------------- */

  private fillOptions(select: HTMLSelectElement): void {
    const doc = select.ownerDocument;
    const groups = new Map<PresetCategory, AircraftPreset[]>();
    for (const p of PRESETS) {
      let list = groups.get(p.category);
      if (!list) groups.set(p.category, (list = []));
      list.push(p);
    }
    const ordered = [
      ...CATEGORY_ORDER.filter((c) => groups.has(c)),
      ...[...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
    ];
    for (const category of ordered) {
      const group = doc.createElement('optgroup');
      group.label = CATEGORY_LABELS[category] ?? category;
      for (const preset of groups.get(category)!) {
        const option = doc.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
  }

  /** Turn state ids into known presets, falling back to the first presets in the list. */
  private resolve(pair: readonly [string, string]): [string, string] {
    const fallback = (i: number): string => PRESETS[Math.min(i, PRESETS.length - 1)]?.id ?? '';
    return [getPreset(pair[0]) ? pair[0] : fallback(0), getPreset(pair[1]) ? pair[1] : fallback(1)];
  }

  private sync(): void {
    if (this.destroyed) return;
    const pair = this.store.get().compare;
    if (!pair) {
      this.hide();
      return;
    }
    const ids = this.resolve(pair);
    if (!this.open) this.show();
    this.selects.a.value = ids[0];
    this.selects.b.value = ids[1];
    if (this.ids && this.ids[0] === ids[0] && this.ids[1] === ids[1]) return;
    this.ids = ids;
    this.load(ids);
  }

  private show(): void {
    this.open = true;
    this.el.hidden = false;
    this.el.dataset.open = 'true';
    this.previousFocus = this.root.ownerDocument.activeElement;
    this.closeButton.focus();
  }

  private hide(): void {
    if (!this.open) return;
    this.open = false;
    this.ids = null;
    this.token++; // drop any request still in flight
    this.el.hidden = true;
    this.el.dataset.open = 'false';
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous instanceof HTMLElement) previous.focus();
  }

  /** Close the comparison (sets AppState.compare to null). */
  private close(): void {
    this.store.set((s) => (s.compare === null ? s : { ...s, compare: null }));
  }

  private onPick(slot: Slot, id: string): void {
    const current = this.ids ?? this.resolve(this.store.get().compare ?? ['', '']);
    const next: [string, string] = slot === 'a' ? [id, current[1]] : [current[0], id];
    this.store.set((s) => ({ ...s, compare: next }));
  }

  private trapFocus(e: KeyboardEvent): void {
    // Skip controls that are hidden (such as the retry button) or disabled: they cannot hold focus.
    const focusable = [...this.card.querySelectorAll<HTMLElement>('button, select')].filter(
      (n) => !n.hidden && !n.hasAttribute('disabled'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = this.root.ownerDocument.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Loading and rendering                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  private load(ids: [string, string]): void {
    const presetA = getPreset(ids[0]);
    const presetB = getPreset(ids[1]);
    const token = ++this.token;
    this.summaries = null;
    this.status = 'loading';
    this.renderHeader(presetA, presetB);
    this.renderResults();
    if (!presetA || !presetB) {
      this.fail('That aircraft is not available.');
      return;
    }
    const idA = `a:${presetA.id}`;
    const idB = `b:${presetB.id}`;
    let request: Promise<{ id: string; geometry: WingGeometry; aero: AeroResult }[]>;
    try {
      request = Promise.resolve(
        this.requestCompare([
          { id: idA, wing: presetA.wing, flow: presetA.cruise },
          { id: idB, wing: presetB.wing, flow: presetB.cruise },
        ]),
      );
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    request.then(
      (results) => {
        if (token !== this.token || this.destroyed) return;
        const a = results.find((r) => r.id === idA);
        const b = results.find((r) => r.id === idB);
        if (!a || !b) {
          this.fail('The calculation did not return both aircraft.');
          return;
        }
        try {
          this.summaries = [
            summarizeCase(presetA, a.geometry, a.aero),
            summarizeCase(presetB, b.geometry, b.aero),
          ];
          this.status = 'ready';
        } catch (e) {
          this.fail(e instanceof Error ? e.message : String(e));
          return;
        }
        this.renderResults();
      },
      (e: unknown) => {
        if (token !== this.token || this.destroyed) return;
        this.fail(e instanceof Error ? e.message : String(e));
      },
    );
  }

  private fail(message: string): void {
    this.status = 'error';
    this.errorMessage = message;
    this.summaries = null;
    this.renderResults();
  }

  private renderHeader(a: AircraftPreset | undefined, b: AircraftPreset | undefined): void {
    const describe = (p: AircraftPreset | undefined): string =>
      p ? [p.blurb, p.facts[0]].filter(Boolean).join(' ') : '';
    this.blurbs.a.textContent = describe(a);
    this.blurbs.b.textContent = describe(b);
    this.headerCells.a.textContent = a?.shortName ?? 'A';
    this.headerCells.b.textContent = b?.shortName ?? 'B';
  }

  private renderResults(): void {
    const ready = this.status === 'ready' && this.summaries !== null;
    this.statusEl.hidden = ready;
    this.planformBox.hidden = !ready;
    this.table.hidden = !ready;
    this.why.hidden = !ready;
    this.retryButton.hidden = this.status !== 'error';
    if (this.status === 'loading') this.statusText.textContent = 'Working out both wings…';
    else if (this.status === 'error') {
      this.statusText.textContent = `Could not compare these aircraft: ${this.errorMessage}`;
    }
    if (!ready || !this.summaries) return;
    try {
      this.renderReady(this.summaries[0], this.summaries[1]);
    } catch (e) {
      // Bad data from the solver must end in a visible error, not a half-drawn dialog.
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** Fill the planform drawing, table and explanations from two solved aircraft. */
  private renderReady(a: CaseSummary, b: CaseSummary): void {
    const units = this.store.get().view.units;

    this.planformEl.innerHTML = buildPlanformSvg(
      [
        {
          slot: 'a',
          label: a.preset.shortName,
          shapes: planformShapes(a.geometry),
          pivotX: a.geometry.pivot[0],
          spanM: a.spanM,
        },
        {
          slot: 'b',
          label: b.preset.shortName,
          shapes: planformShapes(b.geometry),
          pivotX: b.geometry.pivot[0],
          spanM: b.spanM,
        },
      ],
      units,
    );

    const doc = this.root.ownerDocument;
    this.tbody.replaceChildren();
    for (const row of compareRows(a, b, units)) {
      const tr = doc.createElement('tr');
      tr.dataset.row = row.id;
      const th = doc.createElement('th');
      th.scope = 'row';
      th.append(doc.createTextNode(row.label));
      const hint = doc.createElement('small');
      hint.className = 'viz-compare-hint';
      hint.textContent = row.hint;
      th.appendChild(hint);
      tr.appendChild(th);
      for (const [slot, value, frac] of [
        ['a', row.a, row.fracA],
        ['b', row.b, row.fracB],
      ] as const) {
        const td = doc.createElement('td');
        td.className = `viz-col-${slot}`;
        const cell = doc.createElement('span');
        cell.className = 'viz-cell';
        cell.textContent = value;
        const bar = doc.createElement('span');
        bar.className = 'viz-bar';
        bar.style.setProperty('--frac', frac.toFixed(3));
        td.append(cell, bar);
        tr.appendChild(td);
      }
      this.tbody.appendChild(tr);
    }

    this.whyList.replaceChildren();
    for (const sentence of explainDifferences(a, b, units)) {
      const li = doc.createElement('li');
      li.textContent = sentence;
      this.whyList.appendChild(li);
    }

    // The planform's dimension labels already show spans; keep the title attribute for hover.
    this.planformEl.title = `${a.preset.shortName}: ${formatLength(a.spanM, units)} · ${b.preset.shortName}: ${formatLength(b.spanM, units)}`;
  }
}
