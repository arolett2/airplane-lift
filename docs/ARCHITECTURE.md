# Architecture

An interactive wind tunnel built with three.js. A wing sits in a tunnel; real (simplified)
aerodynamic solvers compute lift, drag, the pressure on the wing and the flow around it, and the
renderer draws smoke streamlines, particles, pressure colours and force arrows. The person can
reshape the wing (span, sweep, taper, airfoil, tip devices, flaps) or load real aircraft presets.

## Layers (dependencies point downward only)

```
app/        wiring: stores <-> PhysicsClient <-> renderers <-> UI
ui/         DOM panels, controls, charts, 2D section view, lessons      (no three.js)
render/     three.js scene, wing mesh, tunnel, flow viz, force arrows   (no physics math)
worker/     Web Worker running physics; typed protocol + client
physics/    pure TypeScript solvers                                     (no DOM, no three.js)
state/      AppState types, defaults, param specs, presets, store
shared/     colour maps, units, tiny helpers usable by any layer
content/    lessons + glossary (data only)
```

ESLint enforces that `physics/` imports neither three.js nor the DOM.

## Coordinate frames and units

Defined once in `src/physics/types.ts` and used by every layer, including three.js:

- **Tunnel frame**: right-handed, **Z up**, +x downstream (freestream flows to +x), +y toward the
  right wingtip.
- **Body frame**: wing axes. The wing pitches nose-up by α about +y through the root
  quarter-chord (`WingGeometry.pivot`); see `physics/math/frames.ts`.
- **Airfoil frame**: unit chord, x from LE (0) to TE (1), y up.
- Physics uses SI units and radians. Degrees appear only in `WingConfig`/`FlowConditions` and in the UI.
- three.js objects that show physics data live under `SceneManager.modelRoot` in meters. The
  group is uniformly scaled so every aircraft fills the view.

## Physics pipeline (inside the worker)

1. `buildWingGeometry(WingConfig)` creates lifting surfaces made of sections, including tip
   devices, with the left side mirrored.
2. `getAirfoilModel(key)` builds the NACA geometry, factorises the panel-method matrix once, and
   creates a viscous polar with stall. Results are memoised.
3. `buildVlmModel(geometry)` builds a vortex lattice (non-planar, horseshoes) and factorises its AIC
   matrix once per geometry.
4. `solveCoupled(model, α, polars)` runs the nonlinear VLM. Strip virtual-twist iteration makes
   each strip's lift match its 2D viscous polar, which produces stall.
5. `aero.ts` assembles the `AeroResult`: coefficients, forces, strips with chordwise Cp, stall
   state, Mach effects and the tunnel-frame vortex lattice.
6. The flow module computes the velocity at any point by Biot–Savart, plus thickness sources. It
   uses that to fill a uniform grid (particles) and to trace exact streamlines (smoke rake).
7. `computeSectionFlow` runs the 2D panel method at the chosen station's effective α (geometric
   - twist − induced) to produce the cross-section view.

Stages stream back to the UI cheapest-first: aero → section → polar → streamlines → field.
A newer request cancels the remaining stages of an older one.

A separate `probe` message evaluates the same exact flow (step 6) at one point around the last
solved wing, for the 3D flow probe; the local pressure comes from the isentropic relation
(`physics/everyday.ts`). The 2D probe, the pressure terrain and the air's view work from the
section's velocity grid on the main thread (`ui/charts/sectionFields.ts`).

## Colour language

`shared/colormaps.ts` is shared by 3D and 2D views. Blue means low pressure (suction, fast air),
white means freestream, red means high pressure (stagnation). Wing surfaces and streamlines use
the same map.

## Module ownership (initial build)

| Module           | Files                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| physics-airfoil  | `physics/airfoil/{panel,polar,index,sectionFlow}.ts`                                                                            |
| physics-geometry | `physics/atmosphere.ts`, `physics/wing/{geometry,tipDevices}.ts`                                                                |
| physics-vlm      | `physics/wing/vlm.ts` (+ internal helpers in `physics/wing/`)                                                                   |
| physics-flow     | `physics/flow/*`                                                                                                                |
| render-scene     | `render/SceneManager.ts`, `render/tunnel/*`, `render/wing/*`, `render/forces/*`                                                 |
| render-flow      | `render/flow/*`                                                                                                                 |
| ui-shell         | `ui/AppShell.ts`, `ui/components/*`, `ui/panels/{Controls,Readout}Panel.ts`, `ui/styles/*`, `ui/urlState.ts`, `shared/units.ts` |
| ui-viz           | `ui/charts/*`, `ui/panels/{Charts,Section,Compare}*.ts`                                                                         |
| content          | `state/presets.ts`, `content/*`, `ui/panels/LessonPanel.ts`, `docs/AIRCRAFT_DATA.md`                                            |
| integration      | `physics/aero.ts`, `worker/*`, `app/*`, `main.ts`                                                                               |
