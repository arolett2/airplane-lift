/**
 * Benchmark checks the model is KNOWN to miss, with the reason. Each listed check runs as
 * `it.fails` in the tests (so the suite stays green while the gap stays visible, and a fix that
 * makes it pass turns the test red until the entry is removed) and is flagged in
 * `npm run benchmark` and docs/VALIDATION.md. Never widen a tolerance instead of adding an entry.
 */

const CD_MIN_LAMINAR =
  'Profile drag uses flat-plate friction with transition fixed at Re_x = 5e5 (mostly turbulent ' +
  'at Re 3-9e6). Smooth tunnel models and XFOIL (n_crit 9) keep 30-60 % of the chord laminar, ' +
  'so their cd_min is lower; the model sits between smooth and standard-roughness data.';

const XFOIL_STALL =
  'Reference limitation: XFOIL (and NeuralFoil, trained on it) delays trailing-edge stall on ' +
  'NACA 4-digit sections by 3-6 deg relative to the tunnel; the model stall angle agrees with ' +
  'the measured one (2D vs experiment rows).';

const XFOIL_THIN =
  'Reference limitation: the 6 % section stalls from leading-edge bubble burst (measured ' +
  'cl_max 0.83-0.93 at 9 deg), which XFOIL/NeuralFoil cannot capture (cl_max 1.1-1.5 at ' +
  '11-16 deg). The model follows the experiment.';

export const KNOWN_DEVIATIONS: Readonly<Record<string, string>> = {
  /* ----- 2D vs experiment ----- */
  '2d-exp:0006:3000000:cdMin': CD_MIN_LAMINAR,
  '2d-exp:0006:6000000:cdMin': CD_MIN_LAMINAR,
  '2d-exp:0012:6000000:cdMin': CD_MIN_LAMINAR,
  '2d-exp:2412:clmax-re-ratio':
    'cl_max scales as Re^0.1 for every section; the measured NACA 2412 curve levels off above ' +
    'Re 5.7e6 (ratio 1.053 vs 1.111). The same law matches 4412 and 0006.',

  /* ----- 2D vs NeuralFoil ----- */
  ...Object.fromEntries(
    ['0006', '0012', '2412', '4412'].flatMap((s) =>
      ['3000000', '6000000', '9000000'].map((re) => [`2d-nf:${s}:${re}:cdMin`, CD_MIN_LAMINAR]),
    ),
  ),
  ...Object.fromEntries(
    ['0012', '2412', '4412'].flatMap((s) =>
      ['3000000', '6000000', '9000000'].map((re) => [
        `2d-nf:${s}:${re}:alphaStallDeg`,
        XFOIL_STALL,
      ]),
    ),
  ),
  '2d-nf:0006:6000000:alphaStallDeg': XFOIL_THIN,
  '2d-nf:0006:9000000:alphaStallDeg': XFOIL_THIN,
  '2d-nf:0006:3000000:clMax': XFOIL_THIN,
  '2d-nf:0006:6000000:clMax': XFOIL_THIN,
  '2d-nf:0006:9000000:clMax': XFOIL_THIN,

  /* ----- 3D vs experiment ----- */
  '3d-exp:RM-L50F16 45deg AR6:CLalpha':
    '6 % section, 45 deg sweep: the model slope is 11 % above the figure value (read to about ' +
    '+-4 %). The 2D slope of the 6 % stand-in now matches the NACA 0006 tunnel slope within 2 %, ' +
    'so the gap is not the 2D slope. Not resolved: candidates are the 4-digit stand-in for the ' +
    "wing's 65A006 section and the figure-read reference itself.",
  '3d-exp:RM-L50F16 45deg AR6:CLmax':
    'On this thin, highly swept wing a leading-edge separation vortex carries the lift from CL ' +
    '0.35 to CLmax 1.02 (vortex lift). The model has no vortex lift: its strips stall like 2D ' +
    'sections and CLmax is 0.53.',
};
