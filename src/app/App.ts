/**
 * Application wiring: stores <-> physics worker <-> three.js renderers <-> DOM panels.
 * Contains no physics and no drawing of its own — only data flow and scheduling.
 */
import { domainForGeometry, type TunnelDomain } from '../physics/domain';
import type { WingGeometry } from '../physics/types';
import { ParticleSystem, TRAIL_DRIFT } from '../render/flow/ParticleSystem';
import { simSecondsPerSecond } from '../render/flow/playback';
import { StreamlineRenderer } from '../render/flow/StreamlineRenderer';
import { ForceArrows } from '../render/forces/ForceArrows';
import { SpanLoadViz } from '../render/forces/SpanLoadViz';
import { PressureLegend } from '../render/overlay/PressureLegend';
import { SceneManager } from '../render/SceneManager';
import { crossCutX, wingFraming, type WingFraming } from '../render/util/framing';
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
/** Same breakpoint as the shell's floating-panel layout (ui/AppShell.ts). */
const WIDE_LAYOUT_QUERY = '(min-width: 1100px)';
/** Breathing room kept between a floating panel and the framed scene (CSS px). */
const PANEL_GAP_PX = 8;
/** Cross-flow light sheet half-thickness (semispans) and its smoke trail length (transits). */
const CROSS_SHEET_HALF = 0.14;
const CROSS_TRAIL_LENGTH = 0.3;

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
  const legend = new PressureLegend(shell.viewport);
  scene.modelRoot.add(
    tunnel.object,
    wingMesh.object,
    spanLoad.object,
    forces.object,
    streamlines.object,
    particles.object,
  );

  /* ---------------------------------------------------------------- framing around the panels */
  // The panels float over the full-bleed canvas; tell the camera which part is really visible so
  // the wing is centred and framed in the gap between them rather than hidden behind them.
  const shellRoot = shell.viewport.parentElement ?? root;
  const leftPanel = shell.controls.closest<HTMLElement>('.panel');
  const rightPanel = shell.readouts.closest<HTMLElement>('.panel');
  const tabBar = shellRoot.querySelector<HTMLElement>('.shell__tabs');
  const wideLayout = window.matchMedia?.(WIDE_LAYOUT_QUERY);
  const measureInsets = () => {
    const vp = shell.viewport.getBoundingClientRect();
    if (vp.width < 2 || vp.height < 2) return;
    const bar = shell.topBar.getBoundingClientRect();
    const card = shell.lesson.getBoundingClientRect();
    const lessonOpen = card.height > 1 && card.top < vp.bottom;
    const insets = { left: 0, right: 0, top: 0, bottom: 0 };
    if (bar.height > 0) insets.top = Math.max(0, bar.bottom - vp.top + PANEL_GAP_PX);
    // An open lesson card covers the bottom of the view: frame the scene above it, and below
    // the colour key, which moves to the top meanwhile.
    if (lessonOpen) {
      insets.bottom = Math.max(0, vp.bottom - card.top + PANEL_GAP_PX);
      insets.top += legend.element.offsetHeight + 4;
    }
    if (wideLayout?.matches ?? vp.width >= 1100) {
      const l = leftPanel?.getBoundingClientRect();
      const r = rightPanel?.getBoundingClientRect();
      if (l && l.width > 0) insets.left = Math.max(0, l.right - vp.left + PANEL_GAP_PX);
      if (r && r.width > 0) insets.right = Math.max(0, vp.right - r.left + PANEL_GAP_PX);
    } else if (tabBar) {
      const t = tabBar.getBoundingClientRect();
      if (t.height > 0 && t.top < vp.bottom) {
        insets.bottom = Math.max(insets.bottom, vp.bottom - t.top);
      }
    }
    scene.setViewInsets(insets);
    // The colour key sits at the bottom of the uncovered region; while a lesson card takes the
    // bottom it moves to the top, under the top bar.
    const region = scene.visibleRegion;
    const centerX = region.x + 0.5 * region.width;
    legend.setCompact(region.width < 540);
    if (lessonOpen) {
      legend.setPlacement(region.x + 10, region.y - legend.element.offsetHeight - 4, true);
    } else legend.setPlacement(centerX, vp.height - (region.y + region.height) + 14);
  };
  const insetObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measureInsets()) : null;
  for (const el of [shell.viewport, shell.topBar, shell.lesson, leftPanel, rightPanel, tabBar]) {
    if (el) insetObserver?.observe(el);
  }
  wideLayout?.addEventListener?.('change', measureInsets);
  requestAnimationFrame(measureInsets);
  measureInsets();

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
      focusCamera();
      particles.setDomain(next, g);
    },
  );

  // Side / section shots look at the smoke-rake station (or the 2D section's station).
  const focusEta = (s: AppState) =>
    s.view.rake.mode === 'vertical' ? s.view.rake.eta : s.view.sectionEta;
  let framing: WingFraming | null = null;
  function focusCamera(): void {
    if (!geometry) return;
    framing = wingFraming(geometry, focusEta(store.get()));
    scene.setFocus(geometry.pivot, geometry.overallSpan / 2, framing);
    applyCutaway();
  }
  store.select(focusEta, () => focusCamera());

  // Cutaways (see SceneManager). Side / section: the scene in front of the station is clipped
  // away; show only the smoke in a thin "light sheet" at the station, keep a slab of wing, and
  // hide the force arrows (they sit at the centreline, which the cut removes). Behind / tip:
  // the wake is cut across the flow; show the smoke in a slab just upstream of the cut, with
  // longer trails, so its swirl round the tips and the downwash between them read clearly.
  function applyCutaway(): void {
    const kind = scene.cutaway;
    const span = kind === 'span';
    forces.setVisible(store.get().view.showForces && !span);
    wingMesh.setClipPlanes(span ? [scene.cutawayFarPlane] : null);
    particles.setTrailLength(kind === 'cross' ? CROSS_TRAIL_LENGTH : null);
    // End-on, trails drawn moving with the air show only the cross-flow: arcs round each tip.
    particles.setTrailDrift(kind === 'cross' ? 1 : TRAIL_DRIFT);
    if (!framing || !geometry || kind === 'none') {
      particles.setLightSheet(null);
    } else if (span) {
      const st = framing.station;
      particles.setLightSheet({ normal: [0, 1, 0], offset: st.le[1], halfWidth: 0.6 * st.chord });
    } else {
      const s = 0.5 * geometry.overallSpan;
      const h = CROSS_SHEET_HALF * s;
      const cut = crossCutX(framing.max[0], s);
      particles.setLightSheet({ normal: [1, 0, 0], offset: cut - h, halfWidth: h });
    }
  }
  scene.onCutawayChange(() => applyCutaway());

  results.select(
    (r) => r.aero,
    (aero) => {
      if (!aero) return;
      wingMesh.setAlpha(aero.alpha);
      particles.setAlpha(aero.alpha);
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
      legend.setMode(view.colorBy);
      legend.setVisible(view.showSurfacePressure || view.flowMode !== 'off');
      particles.setDensity(view.particleDensity);
      wingMesh.setPressureVisible(view.showSurfacePressure);
      forces.setVisible(view.showForces && !scene.cutawayActive);
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
    insetObserver?.disconnect();
    wideLayout?.removeEventListener?.('change', measureInsets);
    for (const p of panels) p.destroy();
    physics.dispose();
    for (const r of [tunnel, wingMesh, forces, spanLoad, streamlines, particles, legend])
      r.dispose();
    scene.dispose();
  });
}
