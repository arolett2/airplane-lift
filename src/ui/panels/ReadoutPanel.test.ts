// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { AeroResult, WingGeometry } from '../../physics/types';
import { DEFAULT_STATE } from '../../state/params';
import type { AppState } from '../../state/params';
import { PRESETS } from '../../state/presets';
import { EMPTY_RESULTS } from '../../state/results';
import type { ResultsState } from '../../state/results';
import { Store } from '../../state/store';
import { GRAVITY } from '../../shared/units';
import { ReadoutPanel, liftViewsText, machLevel } from './ReadoutPanel';

const preset = PRESETS[0]!;

function makeAero(over: Partial<AeroResult> = {}): AeroResult {
  const base = {
    requestId: 1,
    atmosphere: {
      altitude: 0,
      temperature: 288.15,
      pressure: 101325,
      density: 1.225,
      speedOfSound: 340.3,
      dynamicViscosity: 1.79e-5,
    },
    velocity: 60,
    mach: 0.18,
    dynamicPressure: 2205,
    reynoldsMac: 6.2e6,
    alpha: 0.087,
    CL: 0.652,
    CDi: 0.0123,
    CD0: 0.0089,
    CDw: 0,
    CD: 0.0212,
    Cm: -0.05,
    liftToDrag: 30.8,
    spanEfficiency: 0.93,
    lift: 152300,
    drag: 4950,
    inducedDrag: 2870,
    liftSlope: 5.09,
    machCritical: 0.78,
    machDragDivergence: 0.82,
    stall: { any: false, fraction: 0, firstEta: null, margin: 1.2 },
    strips: [],
    force: [0, 0, 0],
    centerOfPressure: [0, 0, 0],
    warnings: [],
  };
  return { ...base, ...over } as unknown as AeroResult;
}

const geometry = {
  aspectRatio: 9.1,
  referenceArea: 124.6,
  referenceSpan: 35.8,
  meanAeroChord: 3.9,
} as unknown as WingGeometry;

let root: HTMLElement;
let store: Store<AppState>;
let results: Store<ResultsState>;

function setup(state: Partial<AppState> = {}, res: Partial<ResultsState> = {}) {
  root = document.createElement('div');
  document.body.append(root);
  store = new Store<AppState>({ ...DEFAULT_STATE, ...state });
  results = new Store<ResultsState>({ ...EMPTY_RESULTS, ...res });
  return new ReadoutPanel(root, store, results);
}

const visible = (sel: string) => {
  const el = root.querySelector(sel);
  return el !== null && !el.hasAttribute('hidden');
};
const text = (sel: string) => root.querySelector(sel)?.textContent ?? '';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('ReadoutPanel without results', () => {
  it('tolerates null aero and shows a waiting state', () => {
    setup();
    expect(text('.metric--lift .metric__number')).toBe('–');
    expect(text('.metric--lift .metric__sub')).toContain('Waiting');
    expect(visible('.banner--stall')).toBe(false);
    expect(visible('.metric--gauge')).toBe(false);
    expect(visible('.engineer')).toBe(false);
  });

  it('shows a computing state while stages are pending, then clears it', () => {
    setup({}, { pending: ['aero', 'streamlines'] });
    expect(root.classList.contains('is-computing')).toBe(true);
    expect(text('.readouts__status')).toBe('computing…');
    expect(root.getAttribute('aria-busy')).toBe('true');
    results.set({ pending: [], aero: makeAero(), geometry });
    expect(root.classList.contains('is-computing')).toBe(false);
    expect(root.getAttribute('aria-busy')).toBe('false');
    expect(visible('.readouts__status')).toBe(false);
  });

  it('keeps showing the previous numbers while recomputing', () => {
    setup({}, { aero: makeAero(), geometry });
    results.set({ pending: ['aero'] });
    expect(text('.metric--lift .metric__number')).toBe('152');
    expect(text('.readouts__status')).toBe('computing…');
  });

  it('shows an error', () => {
    setup({}, { error: 'solver blew up' });
    expect(visible('.banner--error')).toBe(true);
    expect(text('.banner--error')).toContain('solver blew up');
  });
});

describe('ReadoutPanel readouts', () => {
  it('shows lift, drag and efficiency in friendly units', () => {
    setup({ view: { ...DEFAULT_STATE.view, units: 'metric' } }, { aero: makeAero(), geometry });
    expect(text('.metric--lift .metric__number')).toBe('152');
    expect(text('.metric--lift .metric__unit')).toBe('kN');
    expect(text('.metric--lift .metric__sub')).toContain('15.5 tonnes');
    expect(text('.metric--drag .metric__number')).toBe('4.95');
    expect(text('.metric--drag .metric__sub')).toContain('58%');
    expect(text('.metric--ld .metric__number')).toBe('30.8');
  });

  it('follows the unit system', () => {
    setup({ view: { ...DEFAULT_STATE.view, units: 'imperial' } }, { aero: makeAero() });
    expect(text('.metric--lift .metric__unit')).toBe('lbf');
    expect(text('.metric--lift .metric__sub')).toContain('pounds');
    store.set((s) => ({ ...s, view: { ...s.view, units: 'aviation' } }));
    expect(text('.metric--lift .metric__unit')).toBe('kN');
    expect(text('.metric--lift .metric__sub')).toContain('tonnes');
  });

  it('says so when the wing pushes down', () => {
    setup({}, { aero: makeAero({ lift: -5000, liftToDrag: -1 }) });
    expect(text('.metric--lift .metric__sub')).toContain('pushing down');
  });

  it('survives non-finite numbers', () => {
    setup({}, { aero: makeAero({ liftToDrag: NaN, drag: 0, inducedDrag: 0 }) });
    expect(text('.metric--ld .metric__number')).toBe('–');
  });
});

describe('ReadoutPanel lift vs weight gauge', () => {
  it('is hidden for a custom wing', () => {
    setup({ presetId: null }, { aero: makeAero() });
    expect(visible('.metric--gauge')).toBe(false);
  });

  it('compares lift with the preset cruise weight', () => {
    const weightN = preset.typicalCruiseMassKg * GRAVITY;
    setup({ presetId: preset.id }, { aero: makeAero({ lift: weightN }) });
    expect(visible('.metric--gauge')).toBe(true);
    expect(text('.metric--gauge .metric__number')).toBe('100%');
    expect(root.querySelector('.metric--gauge')?.getAttribute('data-level')).toBe('ok');
    const meter = root.querySelector('[role=meter]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(text('.metric--gauge .metric__sub')).toContain('level flight');

    results.set({ aero: makeAero({ lift: weightN * 0.5 }) });
    expect(root.querySelector('.metric--gauge')?.getAttribute('data-level')).toBe('low');
    expect(text('.metric--gauge .metric__sub')).toContain('sink');

    results.set({ aero: makeAero({ lift: weightN * 1.6 }) });
    expect(root.querySelector('.metric--gauge')?.getAttribute('data-level')).toBe('high');
    expect(text('.metric--gauge .metric__sub')).toContain('climb');
  });

  it('hides when the aircraft becomes custom', () => {
    setup({ presetId: preset.id }, { aero: makeAero() });
    expect(visible('.metric--gauge')).toBe(true);
    store.set({ presetId: null });
    expect(visible('.metric--gauge')).toBe(false);
  });
});

describe('ReadoutPanel warnings', () => {
  it('shows the stall banner with the stalled percentage', () => {
    setup(
      {},
      {
        aero: makeAero({ stall: { any: true, fraction: 0.35, firstEta: 0.8, margin: -0.2 } }),
      },
    );
    expect(visible('.banner--stall')).toBe(true);
    expect(text('.banner--stall')).toContain('Stall! Air has separated from 35% of the wing');
    expect(visible('.banner--approach')).toBe(false);
  });

  it('never rounds a stall down to 0%', () => {
    setup(
      {},
      { aero: makeAero({ stall: { any: true, fraction: 0.002, firstEta: 0.9, margin: -0.01 } }) },
    );
    expect(text('.banner--stall')).toContain('from 1% of the wing');
  });

  it('hints at an approaching stall when the margin is small', () => {
    setup(
      {},
      {
        aero: makeAero({
          stall: { any: false, fraction: 0, firstEta: 0.5, margin: 0.1 },
          strips: [{ cl: 1.4, clMax: 1.5 } as AeroResult['strips'][number]],
        }),
      },
    );
    expect(visible('.banner--approach')).toBe(true);
    expect(visible('.banner--stall')).toBe(false);
    results.set({
      // A normal cruise buffet margin (cl 0.6 of 0.85) is not "close to stall".
      aero: makeAero({
        stall: { any: false, fraction: 0, firstEta: null, margin: 0.25 },
        strips: [{ cl: 0.6, clMax: 0.85 } as AeroResult['strips'][number]],
      }),
    });
    expect(visible('.banner--approach')).toBe(false);
  });

  it('warns only when Mach is past drag divergence', () => {
    setup({}, { aero: makeAero({ mach: 0.85, machCritical: 0.78, machDragDivergence: 0.82 }) });
    expect(visible('.banner--mach')).toBe(true);
    expect(visible('.banner--info')).toBe(false);
    expect(text('.banner--mach')).toContain('0.85');
    expect(text('.banner--mach')).toContain('0.82');
    expect(text('.banner--mach')).toContain('drag');
    results.set({ aero: makeAero({ mach: 0.7, machCritical: 0.78 }) });
    expect(visible('.banner--mach')).toBe(false);
    expect(visible('.banner--info')).toBe(false);
  });

  it('calls normal cruise above the critical Mach an information note, not a warning', () => {
    setup({}, { aero: makeAero({ mach: 0.8, machCritical: 0.78, machDragDivergence: 0.82 }) });
    expect(visible('.banner--mach')).toBe(false);
    expect(visible('.banner--info')).toBe(true);
    expect(text('.banner--info')).toContain('supersonic');
    expect(text('.banner--info')).toMatch(/normal/i);
  });

  it('says nothing at or below the critical Mach', () => {
    setup({}, { aero: makeAero({ mach: 0.78, machCritical: 0.78, machDragDivergence: 0.82 }) });
    expect(visible('.banner--mach')).toBe(false);
    expect(visible('.banner--info')).toBe(false);
  });

  it('ignores a missing critical Mach', () => {
    setup({}, { aero: makeAero({ mach: 0.85, machCritical: NaN }) });
    expect(visible('.banner--mach')).toBe(false);
    expect(visible('.banner--info')).toBe(false);
  });

  it('classifies Mach levels', () => {
    expect(machLevel(0.7, 0.75, 0.8)).toBe('none');
    expect(machLevel(0.77, 0.75, 0.8)).toBe('info');
    expect(machLevel(0.81, 0.75, 0.8)).toBe('warning');
    // Unknown divergence: a typical margin above the critical Mach is assumed.
    expect(machLevel(0.8, 0.75, NaN)).toBe('info');
    expect(machLevel(0.9, 0.75, NaN)).toBe('warning');
    expect(machLevel(0.9, NaN, 0.8)).toBe('none');
  });
});

describe('ReadoutPanel engineer mode', () => {
  it('adds a table of coefficients and flow numbers', () => {
    setup(
      { view: { ...DEFAULT_STATE.view, engineerMode: true, units: 'metric' } },
      { aero: makeAero({ warnings: ['Near stall at the tip'] }), geometry },
    );
    expect(visible('.engineer')).toBe(true);
    const rows = [...root.querySelectorAll('.engineer__table tr')];
    expect(rows).toHaveLength(16);
    const cell = (symbol: string) =>
      rows
        .find((r) => r.querySelector('th')?.firstChild?.textContent === symbol)
        ?.querySelector('td')?.textContent;
    expect(cell('CL')).toBe('0.652');
    expect(cell('CDi')).toBe('0.0123');
    expect(cell('CD0')).toBe('0.0089');
    expect(cell('CDw')).toBe('0.0000');
    expect(cell('CD')).toBe('0.0212');
    expect(cell('e')).toBe('0.930');
    expect(cell('AR')).toBe('9.1');
    expect(cell('S')).toBe('125 m²');
    expect(cell('b')).toBe('35.8 m');
    expect(cell('MAC')).toBe('3.90 m');
    expect(cell('Re')).toBe('6.20 million');
    expect(cell('Mach')).toBe('0.180');
    expect(cell('q')).toBe('2,205 Pa');
    expect(cell('rho')).toBe('1.225 kg/m³');
    expect(cell('Mcrit')).toBe('0.780');
    expect(cell('CLα')).toBe('5.09 per rad');
    expect(text('.engineer__warnings')).toContain('Near stall at the tip');
  });

  it('is hidden by default and appears when engineer mode is switched on', () => {
    setup({}, { aero: makeAero(), geometry });
    expect(visible('.engineer')).toBe(false);
    store.set((s) => ({ ...s, view: { ...s.view, engineerMode: true } }));
    expect(visible('.engineer')).toBe(true);
  });

  it('shows dashes for span efficiency when it is NaN and tolerates a missing geometry', () => {
    setup(
      { view: { ...DEFAULT_STATE.view, engineerMode: true } },
      { aero: makeAero({ spanEfficiency: NaN }) },
    );
    const eRow = [...root.querySelectorAll('.engineer__table tr')].find(
      (r) => r.querySelector('th')?.firstChild?.textContent === 'e',
    );
    expect(eRow?.querySelector('td')?.textContent).toBe('–');
  });
});

describe('Same lift, two views', () => {
  it('shows the pressure push and the air thrown down once there is a result', () => {
    setup({ view: { ...DEFAULT_STATE.view, units: 'metric' } }, { aero: makeAero(), geometry });
    expect(visible('.lift-views')).toBe(true);
    // 152.3 kN on 124.6 m² = 1222 Pa = 125 kg/m², 1.2% of 101.3 kPa.
    expect(text('.lift-view--pressure')).toContain(
      'Each square metre of wing is pushed up with about 120 kg',
    );
    expect(text('.lift-view--pressure')).toContain('1.2% of the air pressure at the ground');
    // ṁ = 1.225 × 60 × π × 35.8² / 4 = 74 t/s; w = 152300 / 73970 = 2.1 m/s.
    expect(text('.lift-view--newton')).toContain('74 tonnes of air thrown down every second');
    expect(text('.lift-view--newton')).toContain('2.1 m/s');
  });

  it('is hidden without geometry, and words negative and zero lift', () => {
    setup({}, { aero: makeAero() });
    expect(visible('.lift-views')).toBe(false);
    const down = liftViewsText(makeAero({ lift: -20000, CL: -0.1 }), geometry, 'aviation');
    expect(down.pressure).toContain('pushed down');
    expect(down.newton).toContain('thrown up every second');
    const none = liftViewsText(makeAero({ lift: 10, CL: 0.0001 }), geometry, 'aviation');
    expect(none.newton).toBe('With no lift, the wing throws no air down.');
  });

  it('follows the unit system', () => {
    const t = liftViewsText(makeAero(), geometry, 'imperial');
    expect(t.pressure).toContain('Each square foot');
    expect(t.pressure).toContain('psi');
    expect(t.newton).toContain('lb of air');
    expect(t.newton).toContain('mph');
  });
});

describe('ReadoutPanel lifecycle', () => {
  it('stops updating after destroy', () => {
    const panel = setup({}, { aero: makeAero() });
    panel.destroy();
    expect(root.children).toHaveLength(0);
    expect(() => results.set({ aero: makeAero({ lift: 1 }) })).not.toThrow();
    expect(root.children).toHaveLength(0);
  });
});
