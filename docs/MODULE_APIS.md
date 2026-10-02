# Module APIs (render, UI, content, worker)

Physics contracts are TypeScript stubs in `src/physics/**`. The classes below are the
contracts for the browser-side modules. `app/App.ts` wires them together, so **keep these
names and signatures exactly**. Adding extra public methods is fine.

Shared conventions:

- Each three.js class exposes `readonly object: THREE.Object3D` (added by App to
  `SceneManager.modelRoot`, which is in physics meters, tunnel frame, Z-up) and `dispose()`.
- Each UI class takes the `root: HTMLElement` it renders into, plus stores. It subscribes
  to stores itself and exposes `destroy()`.
- Stores: `Store<AppState>` (`src/state/store.ts`, `src/state/params.ts`) and
  `Store<ResultsState>` (`src/state/results.ts`).

## render-scene

```ts
// render/SceneManager.ts — implements SceneManagerApi (already declared in that file)
export class SceneManager implements SceneManagerApi {
  constructor(container: HTMLElement);
  // + CSS2DRenderer overlay: any class may add CSS2DObject labels anywhere in the scene.
}

// render/tunnel/WindTunnel.ts
export class WindTunnel {
  readonly object: THREE.Object3D;
  setDomain(domain: TunnelDomain): void; // walls, floor grid, inlet honeycomb, outlet, mount sting
  setMountPoint(pivot: Vec3): void; // sting reaches the wing pivot (tunnel frame)
  dispose(): void;
}

// render/wing/WingMesh.ts
export class WingMesh {
  readonly object: THREE.Object3D;
  setGeometry(geometry: WingGeometry): void; // loft all surfaces (body frame)
  setAlpha(alphaRad: number): void; // pitch about geometry.pivot, same as physics
  setStrips(strips: StripResult[] | null): void; // Cp vertex colours + stall tint
  setPressureVisible(on: boolean): void; // off => plain metallic wing
  dispose(): void;
}

// render/forces/ForceArrows.ts
export class ForceArrows {
  readonly object: THREE.Object3D;
  /** weightN: aircraft weight to draw as a downward arrow for comparison, or null. */
  update(aero: AeroResult | null, geometry: WingGeometry | null, weightN: number | null): void;
  setVisible(on: boolean): void;
  dispose(): void;
}

// render/forces/SpanLoadViz.ts
export class SpanLoadViz {
  readonly object: THREE.Object3D;
  update(aero: AeroResult | null, geometry: WingGeometry | null): void;
  setVisible(on: boolean): void;
  dispose(): void;
}
```

## render-flow

```ts
// render/flow/playback.ts
/** Simulated seconds per real second: air crosses the tunnel in ~4 s at playbackSpeed 1. */
export function simSecondsPerSecond(
  domain: TunnelDomain,
  vInf: number,
  playbackSpeed: number,
): number;

// render/flow/StreamlineRenderer.ts
export class StreamlineRenderer {
  readonly object: THREE.Object3D;
  setStreamlines(lines: Streamline3D[] | null, vInf: number): void;
  setColorBy(mode: ColorBy): void;
  setVisible(on: boolean): void;
  /** Release a "timeline": one marker on every streamline at the same instant. */
  firePulse(): void;
  /** Advance animation; simTime/dtSim are physical seconds. */
  update(simTime: number, dtSim: number): void;
  dispose(): void;
}

// render/flow/ParticleSystem.ts
export class ParticleSystem {
  readonly object: THREE.Object3D;
  setField(grid: FlowFieldGrid | null): void;
  setDomain(domain: TunnelDomain, geometry: WingGeometry | null): void; // spawn region
  setDensity(multiplier: number): void; // 0.25 .. 2
  setColorBy(mode: ColorBy): void;
  setVisible(on: boolean): void;
  update(dtSim: number): void;
  dispose(): void;
}
```

## ui-shell

```ts
// ui/AppShell.ts
export interface ShellSlots {
  viewport: HTMLElement; // full-bleed 3D canvas container
  topBar: HTMLElement;
  controls: HTMLElement; // left panel
  readouts: HTMLElement; // right column, top
  charts: HTMLElement; // right column, middle
  section: HTMLElement; // right column, 2D cross-section view
  lesson: HTMLElement; // bottom-centre overlay card
  compare: HTMLElement; // modal / drawer host
}
export interface AppShell extends ShellSlots {
  setBusy(on: boolean): void;
  toast(message: string): void;
}
export function createAppShell(root: HTMLElement): AppShell;

// ui/panels/TopBar.ts
export interface TopBarActions {
  onPulse(): void;
  onOpenLessons(): void;
  onOpenCompare(): void;
}
export class TopBar {
  constructor(root: HTMLElement, store: Store<AppState>, actions: TopBarActions);
  destroy(): void;
}

// ui/panels/ControlsPanel.ts  — every parameter control carries data-param="<ParamSpec.path>"
export class ControlsPanel {
  constructor(root: HTMLElement, store: Store<AppState>);
  destroy(): void;
}

// ui/panels/ReadoutPanel.ts
export class ReadoutPanel {
  constructor(root: HTMLElement, store: Store<AppState>, results: Store<ResultsState>);
  destroy(): void;
}

// ui/urlState.ts
export function encodeState(state: AppState): string; // compact, URL-hash safe
export function decodeState(hash: string, fallback: AppState): AppState; // validates & clamps

// shared/units.ts — pure formatters keyed by UnitSystem (speed, altitude, force, length, area, mass, angle)
```

## ui-viz

```ts
// ui/panels/ChartsPanel.ts
export class ChartsPanel {
  constructor(root: HTMLElement, store: Store<AppState>, results: Store<ResultsState>);
  destroy(): void;
}
// ui/panels/SectionView.ts
export class SectionView {
  constructor(root: HTMLElement, store: Store<AppState>, results: Store<ResultsState>);
  firePulse(): void;
  destroy(): void;
}
// ui/panels/ComparePanel.ts
export type CompareRequester = (
  cases: { id: string; wing: WingConfig; flow: FlowConditions }[],
) => Promise<{ id: string; geometry: WingGeometry; aero: AeroResult }[]>;
export class ComparePanel {
  /** Shows itself whenever AppState.compare is non-null; closing sets compare to null. */
  constructor(root: HTMLElement, store: Store<AppState>, requestCompare: CompareRequester);
  destroy(): void;
}
```

## content

```ts
// content/applyStep.ts
export const applyLessonStep: ApplyStep; // (state, step) => state, pure
// ui/panels/LessonPanel.ts
export class LessonPanel {
  constructor(root: HTMLElement, store: Store<AppState>);
  open(): void; // show the lesson picker
  destroy(): void;
}
```

## worker / integration

```ts
// worker/PhysicsClient.ts
export class PhysicsClient {
  constructor(createWorker?: () => Worker);
  /** Send a compute request; returns its requestId. Responses arrive via onResponse. */
  compute(input: Omit<ComputeRequest, 'type' | 'requestId'>): number;
  onResponse(listener: (msg: PhysicsResponse) => void): () => void;
  compare: CompareRequester;
  dispose(): void;
}
// physics/aero.ts
export interface AeroCache {
  /* memoised geometry + VLM model + airfoil models */
}
export function createAeroCache(): AeroCache;
export function computeAero(
  wing: WingConfig,
  flow: FlowConditions,
  requestId: number,
  cache: AeroCache,
): { geometry: WingGeometry; aero: AeroResult };
export function computePolarSweep(
  wing: WingConfig,
  flow: FlowConditions,
  requestId: number,
  cache: AeroCache,
): PolarSweep;
export function computeSection(
  wing: WingConfig,
  flow: FlowConditions,
  eta: number,
  cache: AeroCache,
): SectionFlow;
// app/App.ts
export function startApp(root: HTMLElement): Promise<void>;
```
