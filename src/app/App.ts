/**
 * Application wiring: stores <-> physics worker <-> three.js renderers <-> DOM panels.
 * Contains no physics and no drawing of its own — only data flow and scheduling.
 */
import { domainForGeometry, type TunnelDomain } from '../physics/domain';
import type { WingGeometry } from '../physics/types';
import { ParticleSystem } from '../render/flow/ParticleSystem';
import { simSecondsPerSecond } from '../render/flow/playback';
import { StreamlineRenderer } from '../render/flow/StreamlineRenderer';
import { ForceArrows } from '../render/forces/ForceArrows';
import { SpanLoadViz } from '../render/forces/SpanLoadViz';
import { SceneManager } from '../render/SceneManager';
import { WindTunnel } from '../render/tunnel/WindTunnel';
import { WingMesh } from '../render/wing/WingMesh';
import { DEFAULT_STATE, INITIAL_PRESET_ID, type AppState } from '../state/params';
import { applyPreset, getPreset } from '../state/presets';
import { EMPTY_RESULTS, type ResultsState } from '../state/results';
import { Store, deepEqual } from '../state/store';
import { createAppShell } from '../ui/AppShell';
import { ChartsPanel } from '../ui/panels/ChartsPanel';
import { ComparePanel } from '../ui/panels/ComparePanel';
import { ControlsPanel } from '../ui/panels/ControlsPanel';
import { LessonPanel } from '../ui/panels/LessonPanel';
import { ReadoutPanel } from '../ui/panels/ReadoutPanel';
import { SectionView } from '../ui/panels/SectionView';
import { TopBar } from '../ui/panels/TopBar';
import { decodeState, encodeState } from '../ui/urlState';
import { PhysicsClient } from '../worker/PhysicsClient';
import { STAGE_ORDER, type PhysicsResponse, type PhysicsStage } from '../worker/protocol';

const STANDARD_GRAVITY = 9.80665;
/** Expensive stages wait until the person stops dragging a slider for this long (ms). */
const IDLE_STAGE_DELAY_MS = 220;
const IDLE_STAGES: readonly PhysicsStage[] = ['polar', 'field'];
const DEFAULT_COMPARE: [string, string] = ['b747-400', 'b737-800'];

function initialState(): AppState {
  const fallback = getPreset(INITIAL_PRESET_ID)
    ? applyPreset(DEFAULT_STATE, INITIAL_PRESET_ID, 'cruise')
    : DEFAULT_STATE;
  const hash = window.location.hash.replace(/^#/, '');
  return hash ? decodeState(hash, fallback) : fallback;
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!canvas.getContext('webgl2');
  } catch {
    return false;
  }
}

function showFallback(root: HTMLElement): void {
  root.innerHTML = `<div class="fallback">
    <h1>Wind Tunnel — How Wings Lift</h1>
    <p>This interactive wind tunnel needs WebGL 2, which this browser or device does not provide.
    Try a recent version of Chrome, Edge, Firefox or Safari.</p></div>`;
}

const sameStages = (a: readonly PhysicsStage[], b: readonly PhysicsStage[]) =>
  a.length === b.length && a.every((s, i) => s === b[i]);

export async function startApp(root: HTMLElement): Promise<void> {
  if (!webglAvailable()) {
    showFallback(root);
    return;
  }

  const store = new Store<AppState>(initialState());
  const results = new Store<ResultsState>(EMPTY_RESULTS);

  /* ---------------------------------------------------------------- layout + 3D scene */
  const shell = createAppShell(root);
  const scene = new SceneManager(shell.viewport);
  const tunnel = new WindTunnel();
  const wingMesh = new WingMesh();
  const forces = new ForceArrows();
  const spanLoad = new SpanLoadViz();
  const streamlines = new StreamlineRenderer();
  const particles = new ParticleSystem();
  scene.modelRoot.add(
    tunnel.object,
    wingMesh.object,
    spanLoad.object,
    forces.object,
    streamlines.object,
    particles.object,
  );

  /* ---------------------------------------------------------------- physics worker */
  const physics = new PhysicsClient();

  /* ---------------------------------------------------------------- panels */
  const lessons = new LessonPanel(shell.lesson, store);
  const section = new SectionView(shell.section, store, results);
  const panels = [
    new TopBar(shell.topBar, store, {
      onPulse: () => {
        streamlines.firePulse();
        section.firePulse();
      },
      onOpenLessons: () => lessons.open(),
      onOpenCompare: () => store.set((s) => ({ ...s, compare: s.compare ?? DEFAULT_COMPARE })),
    }),
    new ControlsPanel(shell.controls, store),
    new ReadoutPanel(shell.readouts, store, results),
    new ChartsPanel(shell.charts, store, results),
    new ComparePanel(shell.compare, store, physics.compare),
    lessons,
    section,
  ];

  /* ---------------------------------------------------------------- request scheduling */
  // Stages are coalesced per animation frame; expensive ones wait for an idle moment.
  const wanted = new Set<PhysicsStage>();
  let frameRequested = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let fieldQuality = 1;

  const particlesShown = () => {
    const mode = store.get().view.flowMode;
    return mode === 'particles' || mode === 'both';
  };

  const flush = () => {
    frameRequested = false;
    if (wanted.size === 0) return;
    const stages = STAGE_ORDER.filter((s) => wanted.has(s) && (s !== 'field' || particlesShown()));
    wanted.clear();
    if (stages.length === 0) return;
    const s = store.get();
    physics.compute({
      wing: s.wing,
      flow: s.flow,
      rake: s.view.rake,
      sectionEta: s.view.sectionEta,
      stages,
      fieldQuality,
    });
    results.set((r) => {
      const pending = STAGE_ORDER.filter((st) => r.pending.includes(st) || stages.includes(st));
      return sameStages(pending, r.pending) ? r : { ...r, pending };
    });
  };

  const request = (stages: readonly PhysicsStage[]) => {
    for (const s of stages) {
      if (IDLE_STAGES.includes(s)) continue;
      wanted.add(s);
    }
    const idle = stages.filter((s) => IDLE_STAGES.includes(s));
    if (idle.length > 0) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // Re-send the cheap stages too: a newer request cancels an older one's remaining stages.
        for (const s of ['aero', 'section', 'streamlines', ...idle] as PhysicsStage[])
          wanted.add(s);
        flush();
      }, IDLE_STAGE_DELAY_MS);
    }
    if (!frameRequested && wanted.size > 0) {
      frameRequested = true;
      requestAnimationFrame(flush);
    }
  };

  store.select(
    (s) => [s.wing, s.flow] as const,
    () => request(STAGE_ORDER),
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  store.select(
    (s) => s.view.rake,
    () => request(['streamlines']),
    { equals: deepEqual },
  );
  store.select(
    (s) => s.view.sectionEta,
    () => request(['section']),
  );
  store.select(
    () => particlesShown() && results.get().field === null,
    (needField) => {
      if (needField) request(['field']);
    },
  );

  /* ---------------------------------------------------------------- results -> store */
  const settle = (r: ResultsState, stage: PhysicsStage): PhysicsStage[] =>
    r.pending.filter((s) => s !== stage);

  physics.onResponse((msg: PhysicsResponse) => {
    switch (msg.type) {
      case 'aero':
        results.set((r) => ({
          ...r,
          geometry: msg.geometry,
          aero: msg.aero,
          pending: settle(r, 'aero'),
          error: null,
        }));
        break;
      case 'section':
        results.set((r) => ({ ...r, section: msg.section, pending: settle(r, 'section') }));
        break;
      case 'polar':
        results.set((r) => ({ ...r, polar: msg.polar, pending: settle(r, 'polar') }));
        break;
      case 'streamlines':
        results.set((r) => ({
          ...r,
          streamlines: msg.streamlines,
          pending: settle(r, 'streamlines'),
        }));
        break;
      case 'field':
        results.set((r) => ({ ...r, field: msg.field, pending: settle(r, 'field') }));
        break;
      case 'done':
        results.set((r) => (r.pending.length === 0 ? r : { ...r, pending: [] }));
        break;
      case 'error':
        console.error(`[physics:${msg.stage}]`, msg.message);
        results.set((r) => ({ ...r, error: msg.message }));
        break;
      case 'compare':
        break;
    }
  });

  /* ---------------------------------------------------------------- results -> renderers */
  let domain: TunnelDomain | null = null;
  let geometry: WingGeometry | null = null;
  let firstFrame = true;

  const weightN = () => {
    const preset = store.get().presetId ? getPreset(store.get().presetId!) : undefined;
    return preset ? preset.typicalCruiseMassKg * STANDARD_GRAVITY : null;
  };

  results.select(
    (r) => r.geometry,
    (g) => {
      if (!g) return;
      geometry = g;
      wingMesh.setGeometry(g);
      const next = domainForGeometry(g);
      if (!domain || !deepEqual(domain, next)) {
        domain = next;
        scene.setDomain(next);
        tunnel.setDomain(next);
        if (firstFrame) {
          scene.flyTo(store.get().view.camera);
          firstFrame = false;
        }
      }
      tunnel.setMountPoint(g.pivot);
      scene.setFocus(g.pivot, g.overallSpan / 2);
      particles.setDomain(next, g);
    },
  );

  results.select(
    (r) => r.aero,
    (aero) => {
      if (!aero) return;
      wingMesh.setAlpha(aero.alpha);
      wingMesh.setStrips(aero.strips);
      forces.update(aero, geometry, weightN());
      spanLoad.update(aero, geometry);
    },
  );

  results.select(
    (r) => r.streamlines,
    (lines) => streamlines.setStreamlines(lines, results.get().aero?.velocity ?? 1),
  );
  results.select(
    (r) => r.field,
    (field) => particles.setField(field),
  );
  results.select(
    (r) => r.pending.length > 0,
    (busy) => shell.setBusy(busy),
  );
  results.select(
    (r) => r.error,
    (error) => {
      if (error) shell.toast(`Physics problem: ${error}`);
    },
  );

  /* ---------------------------------------------------------------- view settings */
  store.select(
    (s) => s.view,
    (view, prev) => {
      const showLines = view.flowMode === 'streamlines' || view.flowMode === 'both';
      streamlines.setVisible(showLines);
      particles.setVisible(view.flowMode === 'particles' || view.flowMode === 'both');
      streamlines.setColorBy(view.colorBy);
      particles.setColorBy(view.colorBy);
      particles.setDensity(view.particleDensity);
      wingMesh.setPressureVisible(view.showSurfacePressure);
      forces.setVisible(view.showForces);
      spanLoad.setVisible(view.showSpanLoad);
      if (view.camera !== prev.camera && !firstFrame) scene.flyTo(view.camera);
    },
    { fireNow: true },
  );

  // Re-apply the camera when a lesson asks for the shot that is already selected.
  store.select(
    (s) => s.lesson,
    () => {
      if (!firstFrame) scene.flyTo(store.get().view.camera);
    },
    { equals: deepEqual },
  );

  /* ---------------------------------------------------------------- animation loop */
  let simTime = 0;
  let qualityClock = 0;
  scene.onFrame((dt) => {
    const view = store.get().view;
    const aero = results.get().aero;
    if (!view.paused && aero && domain) {
      const dtSim = dt * simSecondsPerSecond(domain, aero.velocity, view.playbackSpeed);
      simTime += dtSim;
      streamlines.update(simTime, dtSim);
      particles.update(dtSim);
    }
    // Adaptive quality: thin the particles if the frame rate sags.
    qualityClock += dt;
    if (qualityClock > 2) {
      qualityClock = 0;
      if (scene.fps > 0 && scene.fps < 35 && view.particleDensity > 0.3) {
        particles.setDensity(view.particleDensity * 0.75);
        fieldQuality = Math.max(0.5, fieldQuality * 0.85);
      }
    }
  });

  /* ---------------------------------------------------------------- URL sharing */
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  store.subscribe((s) => {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      history.replaceState(null, '', `#${encodeState(s)}`);
    }, 400);
  });

  /* ---------------------------------------------------------------- go */
  request(STAGE_ORDER);

  // Dev-only handle for debugging and browser-driven integration checks.
  if (import.meta.env.DEV) {
    (window as unknown as { __tunnel?: unknown }).__tunnel = { store, results, scene };
  }

  window.addEventListener('pagehide', () => {
    for (const p of panels) p.destroy();
    physics.dispose();
    for (const r of [tunnel, wingMesh, forces, spanLoad, streamlines, particles]) r.dispose();
    scene.dispose();
  });
}
