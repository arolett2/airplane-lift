# Wind Tunnel — How Wings Lift

An interactive three.js wind tunnel for curious people. Put a wing in moving air, see the smoke
bend around it, and watch the pressure, lift and drag change as you reshape the wing. You can
change its span, sweep, airfoil, winglets and flaps, or load the wing of a real aircraft:
747-400, 747-8, 737-800, 737 MAX, 787, A320neo, A380, Cessna 172, a glider or an F-16.

The numbers come from real (simplified) aerodynamics rather than canned animation:

- a **2D panel method** for each airfoil section, with an empirical viscous stall model;
- a **3D vortex-lattice method** for the whole wing, which handles winglets, sweep, twist,
  Prandtl–Glauert compressibility and Trefftz-plane induced drag, coupled strip by strip to the
  airfoil polars so stall shows up;
- **Biot–Savart** velocities from the solved vortex system, used to trace the smoke lines and
  move the particles. This is where the wingtip vortices and downwash come from.

These are teaching-grade models with documented approximations. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the aircraft data sources in
[docs/AIRCRAFT_DATA.md](docs/AIRCRAFT_DATA.md).

## Getting started

Requires Node 22.12+ (see `.nvmrc`).

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script                            | What it does                               |
| --------------------------------- | ------------------------------------------ |
| `npm run dev`                     | Vite dev server with hot reload            |
| `npm run build`                   | Type-check and build to `dist/`            |
| `npm test`                        | Unit and physics-validation tests (Vitest) |
| `npm run lint` / `npm run format` | ESLint / Prettier                          |
| `npm run check`                   | Everything CI runs                         |

## Project layout

```
src/
  physics/   pure TypeScript solvers (no DOM, no three.js); runs in a Web Worker
  worker/    worker entry + typed request/response protocol + client
  render/    three.js scene: tunnel, wing mesh, streamlines, particles, force arrows
  ui/        DOM panels, controls, charts, 2D cross-section view, lessons
  state/     app state types, defaults, parameter specs, aircraft presets, store
  content/   guided lessons and glossary
  shared/    colour maps and unit formatting shared by every layer
docs/        architecture, module APIs, aircraft data sources
```
