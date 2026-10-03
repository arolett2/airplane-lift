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

## Additions from the polish round

These are optional extras on top of the contracts above. App uses them.

```ts
// render/SceneManager.ts
setFocus(pivot: Vec3, semispan: number, framing?: WingFraming): void; // frame shots on the wing, not the tunnel
setViewInsets(insets: Partial<ViewInsets>): void; // CSS px covered by floating UI; centres the projection in the rest
readonly cutaway: CutawayKind;       // 'none' | 'span' (side/section shots) | 'cross' (behind/tip shots)
readonly cutawayActive: boolean;
onCutawayChange(cb: (kind: CutawayKind) => void): () => void;

// render/flow/ParticleSystem.ts
setAlpha(alphaRad: number): void;               // spawn band follows the pitched wing
setLightSheet(sheet: LightSheet | null): void;  // show particles only in a thin slab (cutaway shots)
setTrailLength(transitFraction: number | null): void;
setTrailDrift(fraction: number): void;
setTrails(on: boolean): void;

// render/overlay/PressureLegend.ts — viewport colour key ("Low pressure · fast air" ↔ "High pressure · slowed air")

// ui/AppShell.ts
getViewInsets(): ViewInsets;
onViewInsetsChange(listener: (insets: ViewInsets) => void): () => void;

// ui/panels/SectionView.ts
setExpanded(on: boolean): void; // large dialog view of the cross-section (Esc / backdrop closes)
isExpanded(): boolean;

// ui/panels/ReadoutPanel.ts
export function machLevel(mach: number, critical: number, divergence: number): 'none' | 'info' | 'warning';
export function isApproachingStall(aero: AeroResult): boolean; // any strip above 90% of its clMax

// physics/types.ts — AeroResult.stall.highSpeed?: boolean (shock-induced buffet stall);
// SectionFlow.separated?: Uint8Array and SectionFlow.fieldCl?: number (stall bubble rendering)
```

## Additions: making pressure intuitive

The probe, the pressure terrain, the air's view and the "same lift, two views" readouts. All
optional extras; App wires them.

```ts
// state/params.ts — ViewSettings gains (defaults in DEFAULT_VIEW; lessons set them):
sectionBackdrop: 'tint' | 'terrain';      // cross-section background: colours or pressure relief
sectionFrame: 'wing' | 'air';             // wing's view (tunnel) or air's view (wind subtracted)
sectionProbe: { x: number; y: number } | null; // 2D probe, display frame (chords from the LE)
// ui/urlState.ts shares backdrop + frame in an optional `s` entry; the probe is session-only.

// worker/protocol.ts
interface ProbeRequest { type: 'probe'; requestId: number; point: [number, number, number] }
// response: { type: 'probe'; requestId; sample: FlowProbeSample | null } (null before any solve);
// errors arrive as { type: 'error', stage: 'probe' }. The worker probes its last solved wing.

// worker/PhysicsClient.ts
probe(point: [number, number, number]): Promise<FlowProbeSample | null>; // never broadcast

// physics/flow/probe.ts — exact vortex-lattice flow + thickness sources at one point
interface FlowProbeSample { point; inside; velocity; speedRatio; pressure; deltaPressure;
  pressureFraction; pInf; vInf }
function probeFlow(geometry: WingGeometry, aero: AeroResult, point: Vec3): FlowProbeSample;

// physics/everyday.ts — pure, SI
function staticPressureFromSpeed(speedRatio, mach, pInf): number; // isentropic
function pressureAtSpeed(speedRatio, mach, pInf): PointPressure;  // { pressure, delta, fraction }
function pressureFromCp(cp, q, pInf): PointPressure;
function prandtlGlauertFactor(mach): number;
function pressurePush(lift, area, pInf): PressurePush; // wing loading as Pa, kg/m², share of p∞
function momentumEstimate(lift, density, velocity, span): MomentumEstimate;
// ṁ = ρ V π b² / 4, downwash = L / ṁ (lifting-line momentum estimate; signed)

// shared/everydayFormat.ts — wording shared by the 2D card, the 3D label and the Numbers card
probeText(input, system): ProbeText; describeSpeedRatio; describePressureFraction;
describeDirection; formatPressureChange (kPa, psi for imperial); formatPressure;
formatPushPerArea → { amount, area }; formatAirMass; formatDownwashSpeed; formatPercent; roundSig

// ui/charts/sectionFields.ts — pure helpers over SectionFlow (display frame)
sampleSection(section, X, Y): SectionSample;  probeSection(section, X, Y, free): ProbeReading;
sampleCpRaster(...); terrainHeight(cp); terrainHeights(cp, fade?); terrainColor(cp, out);
fillTerrainImage(cp, w, h, relief, out, fade?); smoothField(field, w, h, passes);
contourSegments(field, w, h, level); TERRAIN_LEVELS; TERRAIN_STEP;
disturbanceArrows(section, win, spacing); farFieldDisturbance(section, X, Y);
disturbanceGain(arrows, targetLength); niceFloor(x); circulationAround(section, box);

// ui/panels/SectionView.ts
toggleProbe(): void;                                   // probe on (default spot) / off
export const DEFAULT_SECTION_PROBE: SectionProbe;
export function sectionCaption(backdrop, frame, cl): string; // worded for the sign of the lift

// ui/panels/ReadoutPanel.ts
export function liftViewsText(aero, geometry, system): { pressure: string; newton: string };

// ui/panels/TopBar.ts
interface TopBarActions { onToggleProbe?(on: boolean): void }  // optional Probe button
setProbeActive(on: boolean): void;

// render/probe/ProbeMarker.ts — ball, flow arrow, slice outline and CSS2D readout card
class ProbeMarker { object; setVisible; setSize; setPoint; setFlow(velocity | null, vInf, len);
  setSlice(slice | null); setReadout({ title, lines, tone }); dispose }

// app/flowProbe3d.ts — pointer / keyboard / worker glue for the 3D probe
class FlowProbe3D { constructor(deps); isActive(); setActive(on); dispose() }
// pure helpers: defaultProbePoint, probeSlice, clampToDomain, nudgeProbe, flowAngles, probeReadout

// content/lessons.ts
export const EXTRA_HIGHLIGHTS: readonly string[]; // non-slider controls a step may highlight
```

The dev handle `window.__tunnel` also carries `flowProbe` (the FlowProbe3D) for snapshots.

## Visual integration checks

`npm run snapshot` (with `npm run dev` running) drives headless Chrome over the DevTools protocol
through a list of scenarios and writes screenshots and console errors. See
`scripts/snapshot.mjs`. The dev-only `window.__tunnel` handle (`store`, `results`, `scene`) lets
scenarios set any app state.
