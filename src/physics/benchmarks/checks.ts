/**
 * External-reference benchmark checks. Each check pairs one model quantity with one reference
 * value (wind-tunnel measurement, independent code or published aircraft figure), the error and
 * the tolerance chosen in tolerances.ts. The *.test.ts files in this folder assert them; the
 * `npm run benchmark` script prints them as a table.
 *
 * Every check is computed lazily (a check group is only evaluated when asked for), so a test
 * file pays only for the solves it needs.
 */
import type { FlowConditions, WingConfig } from '../../state/params';
import { NO_TIP_DEVICE } from '../../state/params';
import { getPreset } from '../../state/presets';
import type { Naca4Params, SectionPolar } from '../types';
import { getAirfoilModel } from '../airfoil/index';
import { isaAtmosphere } from '../atmosphere';
import { buildWingGeometry } from '../wing/geometry';
import { buildVlmModel, solveVlm } from '../wing/vlm';
import { computeAero, computePolarSweep, createAeroCache } from '../aero';
import type { ToleranceId } from './tolerances';
import { TOLERANCES } from './tolerances';
import { KNOWN_DEVIATIONS } from './knownDeviations';
import experimental2d from './reference/naca_2d_experimental.json';
import neuralfoil2d from './reference/neuralfoil_2d.json';
import vlm3d from './reference/vlm_3d.json';
import sweptExperimental from './reference/swept_wing_experimental.json';
import aircraftPublished from './reference/aircraft_published.json';

const DEG = Math.PI / 180;

export type CheckGroup =
  | '2D vs experiment'
  | '2D vs NeuralFoil'
  | '3D vs AVL'
  | '3D vs experiment'
  | 'Aircraft vs published';

export interface BenchmarkCheck {
  /** Stable id, used by KNOWN_DEVIATIONS. */
  id: string;
  group: CheckGroup;
  /** What is compared, e.g. "NACA 2412 Re 6e6: cl_max". */
  quantity: string;
  unit: string;
  model: number;
  reference: number;
  tolerance: ToleranceId;
  /** Short source tag (full citations live in the fixture and docs/VALIDATION.md). */
  source: string;
}

export interface EvaluatedCheck extends BenchmarkCheck {
  /** model - reference ('abs') or model / reference - 1 ('rel'). */
  error: number;
  pass: boolean;
  /** Reason, when the miss is a documented known deviation. */
  knownDeviation: string | null;
}

export function evaluate(check: BenchmarkCheck): EvaluatedCheck {
  const tol = TOLERANCES[check.tolerance];
  const error =
    tol.kind === 'rel' ? check.model / check.reference - 1 : check.model - check.reference;
  const pass = Number.isFinite(error) && Math.abs(error) <= tol.value + 1e-12;
  return { ...check, error, pass, knownDeviation: KNOWN_DEVIATIONS[check.id] ?? null };
}

/* ------------------------------------------------------------------------------------------ */
/* 2D sections                                                                                 */
/* ------------------------------------------------------------------------------------------ */

interface PolarSummary {
  liftSlopePerDeg: number;
  alphaZeroLiftDeg: number;
  clMax: number;
  alphaStallDeg: number;
  cdMin: number;
  cmQuarterChord: number;
}

/** Least-squares slope and intercept of y(x). */
function lineFit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * Reduce a model polar exactly as the generator reduces the NeuralFoil polars (see
 * scripts/benchmarks/generate_reference.py): a line through cl over [aL0 - 2, aL0 + 6] deg,
 * the first lift peak, minimum cd over [aL0 - 4, aL0 + 10] and the mean cm over the linear range.
 */
export function summarizePolar(polar: SectionPolar, reynolds: number): PolarSummary {
  const step = 0.25;
  const alphas: number[] = [];
  for (let a = -20; a <= 26 + 1e-9; a += step) alphas.push(Math.round(a * 100) / 100);
  const cl = alphas.map((a) => polar.cl(a * DEG, reynolds));
  const cd = alphas.map((a) => polar.cd(a * DEG, reynolds));
  const cm = alphas.map((a) => polar.cm(a * DEG, reynolds));
  const window = (lo: number, hi: number) =>
    alphas.map((a, i) => [a, i] as const).filter(([a]) => a >= lo && a <= hi);
  let lin = window(-2, 4);
  let fit = lineFit(
    lin.map(([a]) => a),
    lin.map(([, i]) => cl[i]!),
  );
  let a0 = -fit.intercept / fit.slope;
  lin = window(a0 - 2, a0 + 6);
  fit = lineFit(
    lin.map(([a]) => a),
    lin.map(([, i]) => cl[i]!),
  );
  a0 = -fit.intercept / fit.slope;
  let iMax = alphas.findIndex((a) => a >= a0 + 4);
  for (let i = iMax; i < alphas.length - 1; i++) {
    if (cl[i]! >= cl[iMax]!) iMax = i;
    else if (alphas[i]! > alphas[iMax]! + 3) break;
  }
  const cdWin = window(a0 - 4, a0 + 10).map(([, i]) => cd[i]!);
  const cmLin = lin.map(([, i]) => cm[i]!);
  return {
    liftSlopePerDeg: fit.slope,
    alphaZeroLiftDeg: a0,
    clMax: cl[iMax]!,
    alphaStallDeg: alphas[iMax]!,
    cdMin: Math.min(...cdWin),
    cmQuarterChord: cmLin.reduce((s, v) => s + v, 0) / cmLin.length,
  };
}

function sectionPolar(
  params: Naca4Params,
  flap: { chordFrac: number; deflectionDeg: number } | null,
) {
  return getAirfoilModel({
    params,
    flap: flap ? { chordFrac: flap.chordFrac, deflection: flap.deflectionDeg * DEG } : null,
    slat: false,
    supercritical: false,
  }).polar;
}

const SUMMARY_FIELDS: {
  key: keyof PolarSummary;
  label: string;
  unit: string;
  tolerance: ToleranceId;
}[] = [
  { key: 'liftSlopePerDeg', label: 'lift slope a0', unit: '1/deg', tolerance: 'liftSlope2d' },
  { key: 'alphaZeroLiftDeg', label: 'zero-lift angle', unit: 'deg', tolerance: 'alphaZeroLift2d' },
  { key: 'clMax', label: 'cl_max', unit: '-', tolerance: 'clMax2d' },
  { key: 'alphaStallDeg', label: 'stall angle', unit: 'deg', tolerance: 'alphaStall2d' },
  { key: 'cdMin', label: 'cd_min', unit: '-', tolerance: 'cdMin2d' },
  { key: 'cmQuarterChord', label: 'cm_c/4', unit: '-', tolerance: 'cmQuarter2d' },
];

interface ExperimentalSection {
  section: string;
  params: Naca4Params;
  reynolds: number;
  source: string;
  liftSlopePerDeg?: number | null;
  alphaZeroLiftDeg?: number | null;
  clMax?: number | null;
  alphaStallDeg?: number | null;
  cdMin?: number | null;
  cmQuarterChord?: number | null;
}

const reLabel = (re: number) => `Re ${re / 1e6}e6`;

export function airfoilExperimentChecks(): BenchmarkCheck[] {
  const out: BenchmarkCheck[] = [];
  const data = experimental2d.sections as ExperimentalSection[];
  for (const ref of data) {
    const m = summarizePolar(sectionPolar(ref.params, null), ref.reynolds);
    for (const f of SUMMARY_FIELDS) {
      const r = ref[f.key];
      if (r === null || r === undefined) continue;
      out.push({
        id: `2d-exp:${ref.section}:${ref.reynolds}:${f.key}`,
        group: '2D vs experiment',
        quantity: `NACA ${ref.section} ${reLabel(ref.reynolds)}: ${f.label}`,
        unit: f.unit,
        model: m[f.key],
        reference: r,
        tolerance: f.tolerance,
        source: ref.source,
      });
    }
  }
  // Reynolds trend of cl_max: ratio of the highest to the lowest Re tabulated per section.
  for (const t of experimental2d.clMaxReynoldsTrend) {
    const polar = sectionPolar(t.params as Naca4Params, null);
    const model = polar.clMax(t.reynoldsHigh) / polar.clMax(t.reynoldsLow);
    out.push({
      id: `2d-exp:${t.section}:clmax-re-ratio`,
      group: '2D vs experiment',
      quantity: `NACA ${t.section}: cl_max(${reLabel(t.reynoldsHigh)}) / cl_max(${reLabel(t.reynoldsLow)})`,
      unit: '-',
      model,
      reference: t.clMaxHigh / t.clMaxLow,
      tolerance: 'clMaxReynoldsRatio',
      source: t.source,
    });
  }
  return out;
}

export function airfoilNeuralFoilChecks(): BenchmarkCheck[] {
  const out: BenchmarkCheck[] = [];
  const src = 'NeuralFoil xxxlarge';
  for (const ref of neuralfoil2d.polars) {
    if (ref.flap) continue;
    const m = summarizePolar(sectionPolar(ref.params, null), ref.reynolds);
    for (const f of SUMMARY_FIELDS) {
      out.push({
        id: `2d-nf:${ref.section}:${ref.reynolds}:${f.key}`,
        group: '2D vs NeuralFoil',
        quantity: `NACA ${ref.section} ${reLabel(ref.reynolds)}: ${f.label}`,
        unit: f.unit,
        model: m[f.key],
        reference: ref[f.key],
        tolerance: f.tolerance,
        source: src,
      });
    }
  }
  for (const ref of neuralfoil2d.polars) {
    if (!ref.flap) continue;
    const clean = neuralfoil2d.polars.find(
      (p) => p.section === ref.section && p.reynolds === ref.reynolds && !p.flap,
    )!;
    // NeuralFoil's clean cl at alpha = 0 from its own linear fit (same reduction as the flap case).
    const nfClean0 = -clean.alphaZeroLiftDeg * clean.liftSlopePerDeg;
    const polarClean = sectionPolar(ref.params, null);
    const polarFlap = sectionPolar(ref.params, ref.flap);
    const tag = `NACA ${ref.section} ${ref.flap.chordFrac * 100}% flap ${ref.flap.deflectionDeg} deg`;
    const id = `2d-nf:${ref.section}:flap${ref.flap.chordFrac}:${ref.flap.deflectionDeg}`;
    out.push({
      id: `${id}:dcl`,
      group: '2D vs NeuralFoil',
      quantity: `${tag}: flap lift increment at alpha 0`,
      unit: '-',
      model: polarFlap.cl(0, ref.reynolds) - polarClean.cl(0, ref.reynolds),
      reference: ref.clAtZeroAlpha! - nfClean0,
      tolerance: 'flapDeltaCl2d',
      source: src,
    });
    out.push({
      id: `${id}:clmax`,
      group: '2D vs NeuralFoil',
      quantity: `${tag}: cl_max`,
      unit: '-',
      model: polarFlap.clMax(ref.reynolds),
      reference: ref.clMax,
      tolerance: 'flapClMax2d',
      source: src,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* 3D: inviscid lattice vs AVL                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Benchmark wing config (fixture planform, everything else neutral). */
export function benchmarkWing(cfg: (typeof vlm3d.cases)[number]['config']): WingConfig {
  return {
    ...cfg,
    supercritical: false,
    tipDevice: { ...NO_TIP_DEVICE },
    flaps: { deflectionDeg: 0, chordFrac: 0.25, spanFrac: 0.6 },
    slats: false,
  };
}

export function vlmChecks(): BenchmarkCheck[] {
  const out: BenchmarkCheck[] = [];
  const alphas = vlm3d.alphasDeg;
  const iHi = alphas.length - 1;
  const dAlpha = (alphas[iHi]! - alphas[0]!) * DEG;
  for (const c of vlm3d.cases) {
    const geometry = buildWingGeometry(benchmarkWing(c.config));
    const model = buildVlmModel(geometry, { mach: c.mach });
    const sols = alphas.map((a) => solveVlm(model, { alpha: a * DEG }));
    const hi = sols[iHi]!;
    const ar = geometry.aspectRatio;
    const avlHi = c.avl.points[iHi]!;
    const src = 'AVL (OptVL)';
    const at = `alpha ${alphas[iHi]} deg`;
    out.push(
      {
        id: `3d-avl:${c.id}:CLalpha`,
        group: '3D vs AVL',
        quantity: `${c.id}: CL_alpha`,
        unit: '1/rad',
        model: (hi.CL - sols[0]!.CL) / dAlpha,
        reference: c.avl.CLalphaPerRad,
        tolerance: 'liftSlope3dVlm',
        source: src,
      },
      {
        id: `3d-avl:${c.id}:CL`,
        group: '3D vs AVL',
        quantity: `${c.id}: CL at ${at}`,
        unit: '-',
        model: hi.CL,
        reference: avlHi.CL,
        tolerance: 'cl3dVlm',
        source: src,
      },
      {
        id: `3d-avl:${c.id}:CDi`,
        group: '3D vs AVL',
        quantity: `${c.id}: CDi at ${at}`,
        unit: '-',
        model: hi.CDi,
        reference: avlHi.CDi,
        tolerance: 'inducedDragVlm',
        source: src,
      },
      {
        id: `3d-avl:${c.id}:e`,
        group: '3D vs AVL',
        quantity: `${c.id}: span efficiency e at ${at}`,
        unit: '-',
        model: (hi.CL * hi.CL) / (Math.PI * ar * hi.CDi),
        reference: avlHi.e,
        tolerance: 'spanEfficiencyVlm',
        source: src,
      },
    );
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* 3D: experiment                                                                              */
/* ------------------------------------------------------------------------------------------ */

interface SweptWingCase {
  id: string;
  source: string;
  planform: {
    aspectRatio: number;
    taperRatio: number;
    sweepQuarterChordDeg: number;
    airfoilStandIn: Naca4Params;
  };
  mach: number;
  liftSlope: { reynoldsMac: number; perDeg: number; alphaRangeDeg: number[] } | null;
  clMax: { reynoldsMac: number; value: number; alphaDeg: number | null } | null;
  /** Outboard half stalls first (true) per the report. */
  tipStallFirst: { reynoldsMac: number; value: boolean } | null;
}

/**
 * Wing and flow that reproduce a tunnel test's Reynolds number (on the MAC) and Mach number at
 * sea level: the planform is scaled until the MAC gives the Reynolds number at that airspeed.
 * Coefficients do not depend on scale, so this is equivalent to the pressurised tunnels' runs.
 */
export function tunnelCase(
  planform: SweptWingCase['planform'],
  mach: number,
  reynoldsMac: number,
): { wing: WingConfig; flow: FlowConditions } {
  const atm = isaAtmosphere(0);
  const airspeed = mach * atm.speedOfSound;
  const mac = (reynoldsMac * atm.dynamicViscosity) / (atm.density * airspeed);
  const l = planform.taperRatio;
  const rootChord = mac / (((2 / 3) * (1 + l + l * l)) / (1 + l));
  const span = (planform.aspectRatio * rootChord * (1 + l)) / 2;
  const wing: WingConfig = {
    span,
    rootChord,
    taperRatio: l,
    sweepDeg: planform.sweepQuarterChordDeg,
    dihedralDeg: 0,
    rootIncidenceDeg: 0,
    washoutDeg: 0,
    yehudi: { spanFrac: 0, chordFrac: 0 },
    airfoil: planform.airfoilStandIn,
    supercritical: false,
    tipDevice: { ...NO_TIP_DEVICE },
    flaps: { deflectionDeg: 0, chordFrac: 0.25, spanFrac: 0.5 },
    slats: false,
  };
  return { wing, flow: { alphaDeg: 0, airspeed, altitude: 0 } };
}

export function sweptWingExperimentChecks(): BenchmarkCheck[] {
  const out: BenchmarkCheck[] = [];
  const cache = createAeroCache(8);
  for (const c of sweptExperimental.cases as SweptWingCase[]) {
    if (c.liftSlope) {
      const { wing, flow } = tunnelCase(c.planform, c.mach, c.liftSlope.reynoldsMac);
      const lo = c.liftSlope.alphaRangeDeg[0]!;
      const hi = c.liftSlope.alphaRangeDeg[1]!;
      const cl = (a: number) => computeAero(wing, { ...flow, alphaDeg: a }, 0, cache).aero.CL;
      out.push({
        id: `3d-exp:${c.id}:CLalpha`,
        group: '3D vs experiment',
        quantity: `${c.id}: CL_alpha (${lo}..${hi} deg)`,
        unit: '1/deg',
        model: (cl(hi) - cl(lo)) / (hi - lo),
        reference: c.liftSlope.perDeg,
        tolerance: 'liftSlope3dExperiment',
        source: c.source,
      });
    }
    if (c.clMax) {
      const { wing, flow } = tunnelCase(c.planform, c.mach, c.clMax.reynoldsMac);
      const sweep = computePolarSweep(wing, flow, 0, cache);
      out.push({
        id: `3d-exp:${c.id}:CLmax`,
        group: '3D vs experiment',
        quantity: `${c.id}: CLmax`,
        unit: '-',
        model: sweep.CLmax,
        reference: c.clMax.value,
        tolerance: 'clMax3dExperiment',
        source: c.source,
      });
      if (c.clMax.alphaDeg !== null) {
        out.push({
          id: `3d-exp:${c.id}:alphaStall`,
          group: '3D vs experiment',
          quantity: `${c.id}: alpha at CLmax`,
          unit: 'deg',
          model: sweep.alphaStallDeg,
          reference: c.clMax.alphaDeg,
          tolerance: 'alphaStall3dExperiment',
          source: c.source,
        });
      }
    }
    if (c.tipStallFirst) {
      const { wing, flow } = tunnelCase(c.planform, c.mach, c.tipStallFirst.reynoldsMac);
      // First angle (0.5 deg steps) at which any strip stalls; where along the span is it?
      let firstEta = NaN;
      for (let a = 0; a <= 30; a += 0.5) {
        const { aero } = computeAero(wing, { ...flow, alphaDeg: a }, 0, cache);
        if (aero.stall.any) {
          firstEta = aero.stall.firstEta ?? NaN;
          break;
        }
      }
      out.push({
        id: `3d-exp:${c.id}:tipStall`,
        group: '3D vs experiment',
        quantity: `${c.id}: stall starts on the outboard half (1 = yes; model eta ${firstEta.toFixed(2)})`,
        unit: 'bool',
        model: firstEta > 0.5 ? 1 : 0,
        reference: c.tipStallFirst.value ? 1 : 0,
        tolerance: 'qualitative',
        source: c.source,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Aircraft level                                                                              */
/* ------------------------------------------------------------------------------------------ */

interface AircraftReference {
  presetId: string;
  publishedAreaM2: number;
  areaSource: string;
  cruiseCl: { value: number; source: string } | null;
  buffetOnsetCl: { value: number; source: string } | null;
  landingClMax: { value: number; flapDeg: number; source: string } | null;
  dragDivergenceMach: { value: number; source: string } | null;
}

export function aircraftChecks(): BenchmarkCheck[] {
  const out: BenchmarkCheck[] = [];
  const cache = createAeroCache(8);
  for (const ref of aircraftPublished.aircraft as AircraftReference[]) {
    const preset = getPreset(ref.presetId)!;
    const { geometry, aero } = computeAero(preset.wing, preset.cruise, 0, cache);
    // Coefficients rescaled from the app's reference area to the published one.
    const toPublished = geometry.referenceArea / ref.publishedAreaM2;
    const name = preset.shortName;
    if (ref.cruiseCl) {
      out.push({
        id: `ac:${ref.presetId}:cruiseCL`,
        group: 'Aircraft vs published',
        quantity: `${name}: cruise CL (preset trim, published area)`,
        unit: '-',
        model: aero.CL * toPublished,
        reference: ref.cruiseCl.value,
        tolerance: 'cruiseCl',
        source: ref.cruiseCl.source,
      });
    }
    if (ref.buffetOnsetCl) {
      // Model buffet onset: the CL at the first angle (0.25 deg steps) at which any strip is
      // stalled at the cruise Mach number (high-speed, shock-induced separation).
      let onset = NaN;
      for (let a = preset.cruise.alphaDeg; a <= 15; a += 0.25) {
        const r = computeAero(preset.wing, { ...preset.cruise, alphaDeg: a }, 0, cache).aero;
        if (r.stall.any) {
          onset = r.CL;
          break;
        }
      }
      out.push({
        id: `ac:${ref.presetId}:buffetCL`,
        group: 'Aircraft vs published',
        quantity: `${name}: buffet-onset CL at cruise Mach (published area)`,
        unit: '-',
        model: onset * toPublished,
        reference: ref.buffetOnsetCl.value,
        tolerance: 'buffetCl',
        source: ref.buffetOnsetCl.source,
      });
    }
    if (ref.landingClMax) {
      const wing: WingConfig = {
        ...preset.wing,
        flaps: { ...preset.wing.flaps, deflectionDeg: ref.landingClMax.flapDeg },
        slats: true,
      };
      const sweep = computePolarSweep(wing, preset.approach, 0, cache);
      out.push({
        id: `ac:${ref.presetId}:landingCLmax`,
        group: 'Aircraft vs published',
        quantity: `${name}: CLmax flaps ${ref.landingClMax.flapDeg} + slats (wing only, published area)`,
        unit: '-',
        model: sweep.CLmax * toPublished,
        reference: ref.landingClMax.value,
        tolerance: 'landingClMax',
        source: ref.landingClMax.source,
      });
    }
    if (ref.dragDivergenceMach) {
      out.push({
        id: `ac:${ref.presetId}:Mdd`,
        group: 'Aircraft vs published',
        quantity: `${name}: drag-divergence Mach at cruise CL`,
        unit: '-',
        model: aero.machDragDivergence,
        reference: ref.dragDivergenceMach.value,
        tolerance: 'dragDivergenceMach',
        source: ref.dragDivergenceMach.source,
      });
    }
  }
  return out;
}

/** Every check, in report order. */
export function allChecks(): BenchmarkCheck[] {
  return [
    ...airfoilExperimentChecks(),
    ...airfoilNeuralFoilChecks(),
    ...vlmChecks(),
    ...sweptWingExperimentChecks(),
    ...aircraftChecks(),
  ];
}
