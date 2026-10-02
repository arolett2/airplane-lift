/**
 * 2D cross-section of the wing at one span station (the slice the slider picks).
 *
 * The solver gives the flow in the airfoil frame, with the air arriving at the effective angle
 * of attack. We rotate the picture so the air moves horizontally left to right and the wing
 * appears pitched up. Layers, back to front:
 *   pressure-field tint -> streamlines -> separated-flow patch -> airfoil -> pressure arrows ->
 *   stagnation point -> lift arrow -> angle inset -> animated smoke puffs -> timing markers.
 * Everything except the animated parts is rendered once into an offscreen layer; the animation
 * loop only blits that layer and draws puffs, and runs only while the view is visible and the
 * simulation is not paused.
 */
import { pressureColor, rgbToCss } from '../../shared/colormaps';
import type { SectionFlow } from '../../physics/types';
import type { AppState } from '../../state/params';
import type { ResultsState } from '../../state/results';
import type { Store } from '../../state/store';
import { readChartTheme } from '../charts/chartTheme';
import {
  centerOfPressureX,
  contourToDisplay,
  displayX,
  displayY,
  fillFieldImage,
  fitView,
  positionAtTime,
  prepareStreamlines,
  separationPolygon,
  speedGrid,
  surfaceArrows,
  surfaceProfile,
  surfaceY,
  type PreparedStreamlines,
  type SurfaceArrow,
  type SurfaceProfile,
  type ViewTransform,
} from '../charts/sectionMath';
import '../styles/viz.css';

/** Chord-times (chord / V_inf) that pass per real second at playback speed 1. */
const CHORDS_PER_SECOND = 0.9;
/** Fixed time between successive smoke puffs on a streamline (chord / V_inf). */
const PUFF_SPACING = 0.16;
/** How long the pulse label stays after the markers have finished (seconds). */
const PULSE_HOLD_SECONDS = 1.8;

const FALLBACK_BG = '#0c1420';
const SMOKE = 'rgba(236, 244, 255, 0.55)';
const STREAMLINE = 'rgba(255, 255, 255, 0.26)';
const TEXT = 'rgba(236, 243, 252, 0.95)';
const TEXT_MUTED = 'rgba(190, 203, 222, 0.85)';
const HALO = 'rgba(8, 14, 24, 0.85)';
const TOP_COLOR = '#ffb454';
const BOTTOM_COLOR = '#5ad1ff';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PulseState {
  /** Time since release (chord / V_inf). */
  age: number;
  /** All markers have left the picture. */
  done: boolean;
  /** Seconds left to show the label after finishing. */
  hold: number;
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

let viewCounter = 0;

export class SectionView {
  /** The drawing canvas (exposed for tests and for the app to snapshot). */
  readonly canvas: HTMLCanvasElement;

  private readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly sliderLabel: HTMLLabelElement;
  private readonly arrowsToggle: HTMLInputElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: CanvasRenderingContext2D | null;
  private readonly field: HTMLCanvasElement;
  private readonly fieldCtx: CanvasRenderingContext2D | null;
  private fieldImage: ImageData | null = null;

  private readonly unsubscribe: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private readonly onVisibility = (): void => this.updateAnimation();

  // Derived from the current SectionFlow.
  private section: SectionFlow | null = null;
  private speed: Float32Array | null = null;
  private prep: PreparedStreamlines | null = null;
  private profile: SurfaceProfile | null = null;
  private arrows: SurfaceArrow[] = [];
  private contourDisp: Float32Array | null = null;
  private separation: Float32Array | null = null;
  private cpX = 0.25;

  // Layout and rendering state.
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private vt: ViewTransform | null = null;
  private staticDirty = true;
  private fieldDirty = true;
  private drawQueued = 0;
  private raf = 0;
  private lastTime = 0;
  private visible = true;
  private reducedMotion = false;
  private showArrows = true;
  private destroyed = false;

  // Animation state.
  private clock = 0;
  private pulse: PulseState | null = null;
  private readonly scratch = new Float32Array(2);

  constructor(
    root: HTMLElement,
    private readonly store: Store<AppState>,
    private readonly results: Store<ResultsState>,
  ) {
    const doc = root.ownerDocument;
    const uid = ++viewCounter;

    this.el = doc.createElement('section');
    this.el.className = 'viz-root viz-section';
    this.el.setAttribute('aria-label', 'Cross-section of the wing');

    const head = doc.createElement('div');
    head.className = 'viz-section-head';
    const title = doc.createElement('h3');
    title.className = 'viz-title';
    title.textContent = 'Cross-section';
    const actions = doc.createElement('div');
    actions.className = 'viz-section-actions';

    const toggle = doc.createElement('label');
    toggle.className = 'viz-toggle';
    this.arrowsToggle = doc.createElement('input');
    this.arrowsToggle.type = 'checkbox';
    this.arrowsToggle.checked = true;
    this.arrowsToggle.addEventListener('change', () => {
      this.showArrows = this.arrowsToggle.checked;
      this.staticDirty = true;
      this.requestDraw();
    });
    toggle.append(this.arrowsToggle, doc.createTextNode('Pressure arrows'));

    const pulseButton = doc.createElement('button');
    pulseButton.type = 'button';
    pulseButton.className = 'viz-button';
    pulseButton.textContent = 'Timing dots';
    pulseButton.title = 'Release a line of dots together and watch which side arrives first';
    pulseButton.addEventListener('click', () => this.firePulse());
    actions.append(toggle, pulseButton);
    head.append(title, actions);

    this.stage = doc.createElement('div');
    this.stage.className = 'viz-section-stage';
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'viz-section-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute(
      'aria-label',
      'Air flowing past a slice of the wing: blue marks low pressure above, red high pressure below.',
    );
    this.stage.appendChild(this.canvas);

    const sliderBox = doc.createElement('div');
    sliderBox.className = 'viz-slider';
    this.sliderLabel = doc.createElement('label');
    this.sliderLabel.htmlFor = `viz-section-eta-${uid}`;
    this.slider = doc.createElement('input');
    this.slider.type = 'range';
    this.slider.id = `viz-section-eta-${uid}`;
    this.slider.min = '0';
    this.slider.max = '1';
    this.slider.step = '0.01';
    this.slider.addEventListener('input', () => this.onSlider());
    sliderBox.append(this.sliderLabel, this.slider);

    const caption = doc.createElement('p');
    caption.className = 'viz-caption';
    caption.textContent =
      'Blue is low pressure pulling the wing up, red is high pressure pushing it up. Watch the smoke speed up over the curved top.';

    this.el.append(head, this.stage, sliderBox, caption);
    root.appendChild(this.el);

    this.ctx = this.getContext(this.canvas);
    this.layer = doc.createElement('canvas');
    this.layerCtx = this.getContext(this.layer);
    this.field = doc.createElement('canvas');
    this.fieldCtx = this.getContext(this.field);

    try {
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      this.reducedMotion = false;
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[entries.length - 1]?.contentRect;
        if (rect) this.setSize(rect.width, rect.height);
      });
      this.resizeObserver.observe(this.stage);
    } else {
      this.setSize(this.stage.clientWidth, this.stage.clientHeight);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) {
          this.visible = last.isIntersecting;
          this.updateAnimation();
        }
      });
      this.intersectionObserver.observe(this.el);
    }
    doc.addEventListener('visibilitychange', this.onVisibility);

    this.unsubscribe.push(
      store.select(
        (s) => s.view.sectionEta,
        (eta) => this.syncSlider(eta),
        { fireNow: true },
      ),
      store.select(
        (s) => s.view.paused,
        () => this.updateAnimation(),
      ),
      store.select(
        (s) => s.view.colorBy,
        () => {
          this.fieldDirty = true;
          this.staticDirty = true;
          this.requestDraw();
        },
      ),
      store.select(
        (s) => s.wing.flaps,
        () => {
          this.staticDirty = true;
          this.requestDraw();
        },
      ),
      results.select(
        (r) => r.section,
        (section) => this.setSection(section),
      ),
      results.select(
        (r) => r.pending.includes('section'),
        () => {
          // Only the placeholder message depends on this.
          if (!this.section) {
            this.staticDirty = true;
            this.requestDraw();
          }
        },
      ),
    );
    this.setSection(results.get().section);
  }

  /**
   * Release a vertical line of markers together and let them race along the streamlines.
   * The markers over the top reach the trailing edge sooner. (Frozen while paused.)
   */
  firePulse(): void {
    if (!this.section || !this.prep || this.prep.lines.length === 0) return;
    this.pulse = { age: 0, done: false, hold: PULSE_HOLD_SECONDS };
    this.requestDraw();
    this.updateAnimation();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    if (this.drawQueued && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.drawQueued);
    }
    this.raf = 0;
    this.drawQueued = 0;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.el.ownerDocument.removeEventListener('visibilitychange', this.onVisibility);
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.el.remove();
  }

  /** True while the requestAnimationFrame loop is running. */
  isAnimating(): boolean {
    return this.raf !== 0;
  }

  /** True while a timing pulse is on screen. */
  isPulseActive(): boolean {
    return this.pulse !== null;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* State                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  private getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    try {
      return canvas.getContext('2d');
    } catch {
      return null; // no canvas implementation (some test environments)
    }
  }

  private onSlider(): void {
    const eta = Math.min(1, Math.max(0, Number(this.slider.value)));
    this.store.set((s) =>
      s.view.sectionEta === eta ? s : { ...s, view: { ...s.view, sectionEta: eta } },
    );
  }

  private syncSlider(eta: number): void {
    if (Number(this.slider.value) !== eta) this.slider.value = String(eta);
    const pct = Math.round(eta * 100);
    const where = pct <= 0 ? ' (at the body)' : pct >= 100 ? ' (at the wingtip)' : '';
    const text = `Slice at ${pct}% of the half-span${where}`;
    this.sliderLabel.textContent = text;
    this.slider.setAttribute('aria-valuetext', text);
  }

  private setSection(section: SectionFlow | null): void {
    this.section = section;
    this.pulse = null;
    if (section) {
      this.speed = speedGrid(section);
      this.prep = prepareStreamlines(section);
      this.profile = surfaceProfile(section.contour);
      this.arrows = surfaceArrows(section);
      this.contourDisp = contourToDisplay(section.contour, section.alphaEffective);
      this.separation = separationPolygon(section);
      this.cpX = centerOfPressureX(section.cp);
      if (this.cssW > 0) this.vt = fitView(this.cssW, this.cssH, section.alphaEffective);
    } else {
      this.speed = null;
      this.prep = null;
      this.profile = null;
      this.arrows = [];
      this.contourDisp = null;
      this.separation = null;
    }
    this.fieldDirty = true;
    this.staticDirty = true;
    this.requestDraw();
    this.updateAnimation();
  }

  private setSize(width: number, height: number): void {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    const dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.vt = this.section && w > 0 ? fitView(w, h, this.section.alphaEffective) : null;
    this.fieldDirty = true;
    this.staticDirty = true;
    this.requestDraw();
    this.updateAnimation();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Animation loop                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  private shouldAnimate(): boolean {
    if (this.destroyed || !this.section || !this.prep || this.cssW === 0) return false;
    if (!this.visible || this.el.ownerDocument.hidden) return false;
    if (this.store.get().view.paused) return false;
    // Reduced motion: only the explicit timing pulse moves.
    return !this.reducedMotion || this.pulse !== null;
  }

  private updateAnimation(): void {
    const should = this.shouldAnimate();
    if (should && !this.raf) {
      this.lastTime = 0;
      this.raf = requestAnimationFrame(this.tick);
    } else if (!should && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.lastTime = 0;
    }
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (!this.shouldAnimate()) {
      this.lastTime = 0;
      return;
    }
    const dt = this.lastTime ? Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000)) : 0;
    this.lastTime = now;
    this.advance(dt, this.store.get().view.playbackSpeed);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Advance the animation clocks by `dt` real seconds. Exposed (not private) for tests. */
  advance(dt: number, playbackSpeed: number): void {
    const dtChord = dt * CHORDS_PER_SECOND * playbackSpeed;
    if (!this.reducedMotion) this.clock += dtChord;
    const pulse = this.pulse;
    if (pulse && this.prep) {
      if (!pulse.done) {
        pulse.age += dtChord;
        let longest = 0;
        for (const line of this.prep.lines) {
          longest = Math.max(longest, line.total - line.pulseStart);
        }
        if (pulse.age > longest + 0.05) pulse.done = true;
      } else {
        pulse.hold -= dt;
        if (pulse.hold <= 0) this.pulse = null;
      }
    }
  }

  /** Current clock values, for tests. */
  getClock(): { clock: number; pulseAge: number | null } {
    return { clock: this.clock, pulseAge: this.pulse ? this.pulse.age : null };
  }

  private requestDraw(): void {
    if (this.destroyed || this.raf || this.drawQueued) return; // the running loop will draw
    this.drawQueued = requestAnimationFrame(() => {
      this.drawQueued = 0;
      if (!this.destroyed) this.draw();
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Drawing                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.cssW < 20 || this.cssH < 20) return;
    const pxW = Math.round(this.cssW * this.dpr);
    const pxH = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;

    if (this.staticDirty) this.renderStatic(pxW, pxH);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);
    if (this.layerCtx) ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawPuffs(ctx);
    this.drawPulse(ctx);
  }

  /** Render the parts that only change with the data, size or toggles into the offscreen layer. */
  private renderStatic(pxW: number, pxH: number): void {
    const ctx = this.layerCtx;
    if (!ctx) return;
    this.staticDirty = false;
    if (this.layer.width !== pxW) this.layer.width = pxW;
    if (this.layer.height !== pxH) this.layer.height = pxH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = this.backgroundColor();
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.font = this.font(11);

    const section = this.section;
    const vt = this.vt;
    if (!section || !vt || !this.prep || !this.contourDisp || !this.profile) {
      const pending = this.results.get().pending.includes('section');
      ctx.fillStyle = TEXT_MUTED;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        pending
          ? 'Working out the flow…'
          : 'The cross-section appears after the first calculation.',
        this.cssW / 2,
        this.cssH / 2,
      );
      return;
    }

    this.renderField(vt);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.fieldImage) ctx.drawImage(this.field, 0, 0, this.cssW, this.cssH);

    this.drawStreamlines(ctx, vt);
    if (this.separation) this.drawSeparation(ctx, vt, this.separation);
    this.drawAirfoil(ctx, vt, this.contourDisp);
    this.drawFlapHinge(ctx, vt, section);
    if (this.showArrows) this.drawSurfaceArrows(ctx, vt, section);
    this.drawStagnation(ctx, vt, section);
    const liftBox = this.drawLiftArrow(ctx, vt, section);
    this.drawInset(ctx, section, [this.airfoilBounds(vt, this.contourDisp), liftBox]);
  }

  private backgroundColor(): string {
    try {
      const bg = getComputedStyle(this.stage).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    } catch {
      /* fall through */
    }
    return FALLBACK_BG;
  }

  private font(px: number, weight = ''): string {
    return `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`.trim();
  }

  /** Resample the velocity grid into the offscreen field canvas (view-aligned). */
  private renderField(vt: ViewTransform): void {
    const ctx = this.fieldCtx;
    const section = this.section;
    if (!ctx || !section || !this.speed) return;
    if (!this.fieldDirty && this.fieldImage) return;
    this.fieldDirty = false;
    const w = Math.max(64, Math.min(240, Math.round(this.cssW / 2.2)));
    const h = Math.max(36, Math.round((w * this.cssH) / this.cssW));
    if (this.field.width !== w) this.field.width = w;
    if (this.field.height !== h) this.field.height = h;
    if (!this.fieldImage || this.fieldImage.width !== w || this.fieldImage.height !== h) {
      this.fieldImage = ctx.createImageData(w, h);
    }
    const win = {
      Xmin: vt.worldX(0),
      Xmax: vt.worldX(this.cssW),
      Ymax: vt.worldY(0),
      Ymin: vt.worldY(this.cssH),
    };
    const mode = this.store.get().view.colorBy;
    fillFieldImage(section, this.speed, win, w, h, mode, this.fieldImage.data);
    ctx.putImageData(this.fieldImage, 0, 0);
  }

  private drawStreamlines(ctx: CanvasRenderingContext2D, vt: ViewTransform): void {
    const prep = this.prep!;
    ctx.strokeStyle = STREAMLINE;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const line of prep.lines) {
      const d = line.disp;
      if (d.length < 4) continue;
      ctx.moveTo(vt.x(d[0]!), vt.y(d[1]!));
      for (let i = 2; i + 1 < d.length; i += 2) ctx.lineTo(vt.x(d[i]!), vt.y(d[i + 1]!));
    }
    ctx.stroke();
  }

  private drawSeparation(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    poly: Float32Array,
  ): void {
    ctx.beginPath();
    for (let i = 0; i + 1 < poly.length; i += 2) {
      const px = vt.x(poly[i]!);
      const py = vt.y(poly[i + 1]!);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(190, 160, 230, 0.34)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(210, 190, 245, 0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Label above the rear half of the patch, clear of the lift arrow near the front.
    const prep = this.prep;
    const minX = vt.x(prep ? prep.teX : 1) - 20;
    let labelX = 0;
    let labelY = Infinity;
    for (let i = 0; i + 1 < poly.length; i += 2) {
      const px = vt.x(poly[i]!);
      const py = vt.y(poly[i + 1]!);
      if (px >= minX && py < labelY) {
        labelY = py;
        labelX = px;
      }
    }
    if (Number.isFinite(labelY)) {
      this.label(
        ctx,
        'Separated air (stall)',
        Math.min(labelX, this.cssW - 70),
        labelY - 7,
        'center',
        TEXT,
      );
    }
  }

  private drawAirfoil(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    contour: Float32Array,
  ): void {
    ctx.beginPath();
    for (let i = 0; i + 1 < contour.length; i += 2) {
      const px = vt.x(contour[i]!);
      const py = vt.y(contour[i + 1]!);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = '#232d3f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(222, 233, 250, 0.82)';
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private airfoilBounds(vt: ViewTransform, contour: Float32Array): Rect {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < contour.length; i += 2) {
      const px = vt.x(contour[i]!);
      const py = vt.y(contour[i + 1]!);
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
    const m = 10;
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
  }

  /** A faint hinge line when a flap is deployed on this slice. */
  private drawFlapHinge(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const flaps = this.store.get().wing.flaps;
    if (!this.profile || flaps.deflectionDeg < 0.5 || section.eta > flaps.spanFrac + 1e-6) return;
    const x = 1 - flaps.chordFrac;
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const yu = surfaceY(this.profile.upperX, this.profile.upperY, x);
    const yl = surfaceY(this.profile.lowerX, this.profile.lowerY, x);
    ctx.strokeStyle = 'rgba(222, 233, 250, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(vt.x(displayX(c, s, x, yu)), vt.y(displayY(c, s, x, yu)));
    ctx.lineTo(vt.x(displayX(c, s, x, yl)), vt.y(displayY(c, s, x, yl)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawSurfaceArrows(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const suction = rgbToCss(pressureColor(-1.6));
    const pressure = rgbToCss(pressureColor(1));
    const head = Math.max(5, vt.scale * 0.035);
    for (const a of this.arrows) {
      const X = displayX(c, s, a.x, a.y);
      const Y = displayY(c, s, a.x, a.y);
      const nX = displayX(c, s, a.nx, a.ny);
      const nY = displayY(c, s, a.nx, a.ny);
      const len = a.length * vt.scale;
      const bx = vt.x(X);
      const by = vt.y(Y);
      // Screen y runs down, so a display-frame normal (nX, nY) points to (nX, -nY) on screen.
      const tx = bx + nX * len;
      const ty = by - nY * len;
      if (a.cp < 0) {
        // Suction pulls the surface outward: tail on the surface, head outside.
        this.arrow(ctx, bx + nX, by - nY, tx, ty, suction, 1.8, head);
      } else {
        // Pressure pushes inward: tail outside, head on the surface.
        this.arrow(ctx, tx, ty, bx + nX * 0.5, by - nY * 0.5, pressure, 1.8, head);
      }
    }
  }

  private drawStagnation(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): void {
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const [sx, sy] = section.stagnation;
    const px = vt.x(displayX(c, s, sx, sy));
    const py = vt.y(displayY(c, s, sx, sy));
    ctx.beginPath();
    ctx.arc(px, py, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = HALO;
    ctx.stroke();
    if (this.cssW >= 300) {
      const text = 'Stagnation point';
      ctx.font = this.font(10.5);
      const width = ctx.measureText(text).width;
      this.label(ctx, text, Math.max(width + 4, px - 8), py + 14, 'right', TEXT_MUTED);
    }
  }

  /** Lift arrow from the centre of pressure, perpendicular to the oncoming air. */
  private drawLiftArrow(
    ctx: CanvasRenderingContext2D,
    vt: ViewTransform,
    section: SectionFlow,
  ): Rect {
    const profile = this.profile!;
    const c = Math.cos(section.alphaEffective);
    const s = Math.sin(section.alphaEffective);
    const x = this.cpX;
    const y =
      (surfaceY(profile.upperX, profile.upperY, x) + surfaceY(profile.lowerX, profile.lowerY, x)) /
      2;
    const X = displayX(c, s, x, y);
    const Y = displayY(c, s, x, y);
    const lengthChords = Math.max(-0.9, Math.min(0.9, 0.55 * section.cl));
    const bx = vt.x(X);
    const by = vt.y(Y);
    // Keep the arrow head inside the picture, even for a big lift coefficient.
    const ty = Math.max(16, Math.min(this.cssH - 16, vt.y(Y + lengthChords)));
    const color = readChartTheme(this.stage).tokens['--lift'] ?? '#4ade80';
    if (Math.abs(ty - by) > 6) {
      this.arrow(ctx, bx, by, bx, ty, color, 3, 9, HALO);
      this.label(ctx, 'Lift', bx + 7, ty + (ty < by ? 8 : -8), 'left', color);
    }
    return { x: bx - 12, y: Math.min(by, ty) - 14, w: 60, h: Math.abs(ty - by) + 24 };
  }

  /** Inset: geometric angle, induced downwash and effective angle. */
  private drawInset(ctx: CanvasRenderingContext2D, section: SectionFlow, keepOut: Rect[]): void {
    if (this.cssW < 240 || this.cssH < 120) return;
    const compact = this.cssW < 320;
    const W = compact ? 164 : 184;
    const H = compact ? 62 : 72;
    const m = 8;
    const candidates: Rect[] = [
      { x: m, y: this.cssH - H - m, w: W, h: H },
      { x: this.cssW - W - m, y: this.cssH - H - m, w: W, h: H },
      { x: m, y: m, w: W, h: H },
      { x: this.cssW - W - m, y: m, w: W, h: H },
    ];
    const box = candidates.find((c) => keepOut.every((k) => !intersects(c, k))) ?? candidates[0]!;
    const { x, y } = box;

    ctx.beginPath();
    ctx.roundRect?.(x, y, W, H, 8);
    if (!ctx.roundRect) ctx.rect(x, y, W, H);
    ctx.fillStyle = 'rgba(8, 14, 24, 0.84)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const toDeg = 180 / Math.PI;
    const geo = section.alphaGeometric;
    const eff = section.alphaEffective;
    const ind = section.alphaInduced;
    const dragColor = readChartTheme(this.stage).tokens['--drag'] ?? '#ff8a5c';
    const greyColor = 'rgba(190, 203, 222, 0.85)';

    // Diagram: chord horizontal, air arriving from below-left at the two angles. The angles
    // are enlarged so the small difference caused by the downwash can be seen.
    const enlarge = Math.max(2, Math.min(10, 30 / 57.2958 / Math.max(Math.abs(geo), 2 / 57.2958)));
    const maxAngle = 0.7;
    const angG = Math.max(-maxAngle, Math.min(maxAngle, geo * enlarge));
    const angE = Math.max(-maxAngle, Math.min(maxAngle, eff * enlarge));
    const ox = x + 40;
    const oy = y + H * 0.5 + 6;
    const L = 34;
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(ox - 26, oy);
    ctx.lineTo(ox + 10, oy);
    ctx.stroke();
    ctx.lineCap = 'butt';
    this.arrow(ctx, ox - L * Math.cos(angG), oy + L * Math.sin(angG), ox, oy, greyColor, 1.4, 6);
    this.arrow(ctx, ox - L * Math.cos(angE), oy + L * Math.sin(angE), ox, oy, '#ffffff', 1.8, 6);
    this.arrow(ctx, x + 12, y + 10, x + 12, y + 30, dragColor, 1.8, 6);

    const tx = x + 72;
    const size = compact ? 10 : 10.5;
    const rows: [string, string, string][] = [
      [greyColor, 'Wing tilt', `${(geo * toDeg).toFixed(1)}°`],
      [dragColor, '− Downwash', `${(ind * toDeg).toFixed(1)}°`],
      ['#ffffff', '= Air feels', `${(eff * toDeg).toFixed(1)}°`],
    ];
    ctx.font = this.font(size);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    rows.forEach(([color, name, value], i) => {
      const ry = y + 14 + i * 14;
      ctx.fillStyle = color;
      ctx.fillRect(tx - 9, ry - 3, 5, 5);
      ctx.fillStyle = TEXT;
      ctx.fillText(name, tx, ry);
      ctx.textAlign = 'right';
      ctx.fillText(value, x + W - 8, ry);
      ctx.textAlign = 'left';
    });
    ctx.font = this.font(9);
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(`angles drawn ${enlarge.toFixed(0)}× larger`, tx - 9, y + H - 8);
  }

  private drawPuffs(ctx: CanvasRenderingContext2D): void {
    const prep = this.prep;
    const vt = this.vt;
    if (!prep || !vt) return;
    const out = this.scratch;
    const phase = ((this.clock % PUFF_SPACING) + PUFF_SPACING) % PUFF_SPACING;
    ctx.fillStyle = SMOKE;
    ctx.beginPath();
    for (let li = 0; li < prep.lines.length; li++) {
      const line = prep.lines[li]!;
      if (line.total <= 0) continue;
      // Constant time spacing: where the air is fast the puffs are spread further apart.
      // Each line gets its own phase so the smoke looks like smoke, not a grid.
      const offset = ((li * 0.618034) % 1) * PUFF_SPACING;
      for (let t = (phase + offset) % PUFF_SPACING; t < line.total; t += PUFF_SPACING) {
        if (!positionAtTime(line, t, out)) continue;
        const r = 1.3 + 1.5 * (t / line.total);
        const px = vt.x(out[0]!);
        const py = vt.y(out[1]!);
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  private drawPulse(ctx: CanvasRenderingContext2D): void {
    const pulse = this.pulse;
    const prep = this.prep;
    const vt = this.vt;
    if (!pulse || !prep || !vt) return;
    const out = this.scratch;

    // Guide lines: where the markers start and the trailing edge they race towards.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    const yTop = 0;
    const yBottom = this.cssH;
    if (!pulse.done || pulse.age < 0.3) {
      ctx.moveTo(vt.x(prep.pulseX), yTop);
      ctx.lineTo(vt.x(prep.pulseX), yBottom);
    }
    ctx.moveTo(vt.x(prep.teX), yTop);
    ctx.lineTo(vt.x(prep.teX), yBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    for (let li = 0; li < prep.lines.length; li++) {
      const line = prep.lines[li]!;
      if (!positionAtTime(line, line.pulseStart + pulse.age, out)) continue;
      const px = vt.x(out[0]!);
      const py = vt.y(out[1]!);
      ctx.beginPath();
      ctx.arc(px, py, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = HALO;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fillStyle =
        line.side === 'top' ? TOP_COLOR : line.side === 'bottom' ? BOTTOM_COLOR : '#d5dbe6';
      ctx.fill();
    }

    const showResult =
      pulse.done &&
      Number.isFinite(prep.topArrival) &&
      Number.isFinite(prep.bottomArrival) &&
      prep.topArrival < prep.bottomArrival - 0.005;
    ctx.beginPath();
    ctx.rect(4, 4, 204, showResult ? 58 : 42);
    ctx.fillStyle = 'rgba(8, 14, 24, 0.72)';
    ctx.fill();
    this.label(ctx, 'Same start, different arrival', 10, 16, 'left', TEXT, this.font(11.5, '600'));
    ctx.fillStyle = TOP_COLOR;
    ctx.fillRect(10, 28, 6, 6);
    ctx.fillStyle = BOTTOM_COLOR;
    ctx.fillRect(98, 28, 6, 6);
    this.label(ctx, 'over the top', 20, 31, 'left', TEXT_MUTED);
    this.label(ctx, 'underneath', 108, 31, 'left', TEXT_MUTED);
    if (showResult) {
      this.label(ctx, 'The air over the top gets there first.', 10, 49, 'left', TEXT);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Small drawing helpers                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  private label(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
    color: string,
    font = this.font(10.5),
  ): void {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = HALO;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /** Line with a triangular head at (x1, y1); an optional dark outline keeps it readable. */
  private arrow(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    width: number,
    head: number,
    outline?: string,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const h = Math.min(head, len * 0.7);
    const bx = x1 - ux * h * 0.8;
    const by = y1 - uy * h * 0.8;
    const lx = x1 - ux * h - uy * h * 0.5;
    const ly = y1 - uy * h + ux * h * 0.5;
    const rx = x1 - ux * h + uy * h * 0.5;
    const ry = y1 - uy * h - ux * h * 0.5;
    ctx.lineCap = 'butt';
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = width + 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(lx, ly);
    ctx.lineTo(rx, ry);
    ctx.closePath();
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.fill();
  }
}
