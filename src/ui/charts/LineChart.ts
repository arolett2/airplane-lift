/**
 * A small reusable HiDPI canvas chart for the wind tunnel's side panels.
 *
 * Features: nice ticks and gridlines, axis labels, several line / scatter series (solid or
 * dashed), shaded bands, a highlighted "you are here" marker, optional inverted y axis, vertical
 * and horizontal annotation lines, a legend, and a hover crosshair with a value tooltip.
 *
 * The chart only redraws when its data, size, theme or hover target changes; draws are coalesced
 * with requestAnimationFrame, and a chart whose container is hidden (zero size) draws nothing.
 */
import { LinearScale, extentOf, nearestPoint, resolveAxisRange } from './chartMath';
import { readChartTheme, resolveColor, type ChartTheme } from './chartTheme';
import { formatTick, formatValue } from './ticks';

export interface ChartSeries {
  id: string;
  /** Legend / tooltip name. */
  label: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** CSS colour, or `var(--series-1, #5aa9ff)` which is resolved against the theme. */
  color: string;
  /** Line width in CSS pixels (default 2). */
  width?: number;
  /** Dash pattern in CSS pixels, e.g. [6, 4]. */
  dash?: number[];
  /** 'line' (default), 'scatter' (markers only) or 'line+points'. */
  style?: 'line' | 'scatter' | 'line+points';
  pointRadius?: number;
  /** Show in the legend (default true). */
  legend?: boolean;
}

/** A highlighted point, such as "you are here". */
export interface ChartMarker {
  x: number;
  y: number;
  color: string;
  label?: string;
  /** Draw a ring halo (default true). */
  ring?: boolean;
  radius?: number;
}

export interface ChartVLine {
  x: number;
  label?: string;
  color?: string;
  dash?: number[];
  /** Stretch the x axis to include this line. */
  includeInRange?: boolean;
}

export interface ChartHLine {
  y: number;
  label?: string;
  color?: string;
  dash?: number[];
  includeInRange?: boolean;
}

/** Area between two curves that share x values. */
export interface ChartBand {
  x: ArrayLike<number>;
  y0: ArrayLike<number>;
  y1: ArrayLike<number>;
  color: string;
  /** Fill opacity 0..1 (default 0.18). */
  alpha?: number;
}

export interface ChartAxis {
  /** Axis title, e.g. "Angle of attack (°)". */
  label: string;
  /** Short name used in the tooltip, e.g. "α". Defaults to `label`. */
  short?: string;
  min?: number;
  max?: number;
  /** Reverse the direction (used for Cp, where suction plots upward). */
  inverted?: boolean;
  includeZero?: boolean;
  tickCount?: number;
  /** Tick label formatter; default picks decimals from the tick step. */
  format?: (value: number, step: number) => string;
  /** Tooltip value formatter; default `formatValue`. */
  tooltipFormat?: (value: number) => string;
}

export interface ChartConfig {
  x: ChartAxis;
  y: ChartAxis;
  series: ChartSeries[];
  markers?: ChartMarker[];
  vlines?: ChartVLine[];
  hlines?: ChartHLine[];
  bands?: ChartBand[];
  /** Values the x / y axis range must cover even if no data reaches them. */
  xInclude?: number[];
  yInclude?: number[];
  /** Draw the legend (default true when there are two or more labelled series). */
  legend?: boolean;
  /** Accessible description of the chart. */
  ariaLabel?: string;
}

interface Layout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  xScale: LinearScale;
  yScale: LinearScale;
  xStep: number;
  yStep: number;
  xTicks: number[];
  yTicks: number[];
}

interface HoverState {
  active: boolean;
  seriesIndex: number;
  pointIndex: number;
}

const TICK_FONT_PX = 11;
const ROW_HEIGHT = 16;

export class LineChart {
  readonly canvas: HTMLCanvasElement;
  /** Number of completed draws; handy for tests and for checking redraw frequency. */
  drawCount = 0;

  private readonly host: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private config: ChartConfig | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private pending = 0;
  private dirty = false;
  private destroyed = false;
  private layout: Layout | null = null;
  private readonly hover: HoverState = { active: false, seriesIndex: -1, pointIndex: -1 };
  private resizeObserver: ResizeObserver | null = null;
  private colorQuery: MediaQueryList | null = null;
  private themeObserver: MutationObserver | null = null;

  private readonly onPointerMove = (e: PointerEvent): void => this.handlePointer(e);
  private readonly onPointerLeave = (): void => this.clearHover();
  private readonly onThemeChange = (): void => this.invalidate();

  constructor(host: HTMLElement) {
    this.host = host;
    this.canvas = host.ownerDocument.createElement('canvas');
    this.canvas.className = 'viz-chart-canvas';
    this.canvas.setAttribute('role', 'img');
    try {
      this.ctx = this.canvas.getContext('2d');
    } catch {
      this.ctx = null; // e.g. happy-dom without a canvas implementation
    }
    host.appendChild(this.canvas);

    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('pointercancel', this.onPointerLeave);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[entries.length - 1]?.contentRect;
        if (rect) this.setSize(rect.width, rect.height);
      });
      this.resizeObserver.observe(host);
    } else {
      this.setSize(host.clientWidth, host.clientHeight);
    }

    try {
      this.colorQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.colorQuery.addEventListener('change', this.onThemeChange);
    } catch {
      this.colorQuery = null;
    }
    if (typeof MutationObserver !== 'undefined') {
      this.themeObserver = new MutationObserver(this.onThemeChange);
      this.themeObserver.observe(host.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      });
    }
  }

  /** Replace the chart contents. Redraws on the next animation frame. */
  setConfig(config: ChartConfig): void {
    this.config = config;
    this.canvas.setAttribute(
      'aria-label',
      config.ariaLabel ?? `${config.y.label} versus ${config.x.label}`,
    );
    // The hover target may no longer exist in the new data.
    this.hover.active = false;
    this.invalidate();
  }

  /** Current layout (null before the first successful draw). Exposed for tests. */
  getLayout(): Readonly<Layout> | null {
    return this.layout;
  }

  /** Update the CSS size; normally called by the ResizeObserver. */
  setSize(width: number, height: number): void {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    const dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (w === this.cssWidth && h === this.cssHeight && dpr === this.dpr) return;
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = dpr;
    this.invalidate();
  }

  /** Request a redraw (coalesced). */
  invalidate(): void {
    if (this.destroyed || this.dirty) return;
    this.dirty = true;
    const run = (): void => {
      this.pending = 0;
      this.dirty = false;
      if (!this.destroyed) this.draw();
    };
    if (typeof requestAnimationFrame === 'function') {
      this.pending = requestAnimationFrame(run);
    } else {
      this.pending = 0;
      queueMicrotask(run);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pending && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.pending);
    }
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.colorQuery?.removeEventListener('change', this.onThemeChange);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointercancel', this.onPointerLeave);
    this.canvas.remove();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Interaction                                                                               */
  /* ---------------------------------------------------------------------------------------- */

  private handlePointer(e: PointerEvent): void {
    const layout = this.layout;
    const cfg = this.config;
    if (!layout || !cfg) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const inside =
      px >= layout.left - 4 &&
      px <= layout.right + 4 &&
      py >= layout.top - 4 &&
      py <= layout.bottom + 4;
    if (!inside) {
      this.clearHover();
      return;
    }
    const hit = nearestPoint(cfg.series, layout.xScale, layout.yScale, px, py, 48);
    if (!hit) {
      this.clearHover();
      return;
    }
    const h = this.hover;
    if (h.active && h.seriesIndex === hit.seriesIndex && h.pointIndex === hit.pointIndex) return;
    h.active = true;
    h.seriesIndex = hit.seriesIndex;
    h.pointIndex = hit.pointIndex;
    this.invalidate();
  }

  private clearHover(): void {
    if (!this.hover.active) return;
    this.hover.active = false;
    this.invalidate();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Drawing                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private draw(): void {
    const cfg = this.config;
    const ctx = this.ctx;
    if (!cfg || !ctx || this.cssWidth < 40 || this.cssHeight < 40) return;

    const pxW = Math.round(this.cssWidth * this.dpr);
    const pxH = Math.round(this.cssHeight * this.dpr);
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    const theme = readChartTheme(this.host);
    const font = (px: number, weight = ''): string =>
      `${weight} ${px}px ${theme.fontFamily}`.trim();
    ctx.font = font(TICK_FONT_PX);
    ctx.textBaseline = 'middle';

    const layout = this.computeLayout(cfg, ctx, font);
    this.layout = layout;
    const plotW = layout.right - layout.left;
    const plotH = layout.bottom - layout.top;
    if (plotW < 20 || plotH < 20) return;

    this.drawGrid(ctx, cfg, layout, theme, font);
    this.drawHeader(ctx, cfg, theme, font);

    // Everything data-related is clipped to the plot rectangle.
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.left, layout.top - 2, plotW, plotH + 4);
    ctx.clip();
    this.drawBands(ctx, cfg, layout, theme);
    this.drawAnnotationLines(ctx, cfg, layout, theme, font);
    this.drawSeries(ctx, cfg, layout, theme);
    this.drawMarkers(ctx, cfg, layout, theme, font);
    ctx.restore();

    if (this.hover.active) this.drawHover(ctx, cfg, layout, theme, font);
    this.drawCount++;
  }

  private computeLayout(
    cfg: ChartConfig,
    ctx: CanvasRenderingContext2D,
    font: (px: number, weight?: string) => string,
  ): Layout {
    const xs: ArrayLike<number>[] = [];
    const ys: ArrayLike<number>[] = [];
    for (const s of cfg.series) {
      xs.push(s.x);
      ys.push(s.y);
    }
    for (const b of cfg.bands ?? []) {
      xs.push(b.x);
      ys.push(b.y0, b.y1);
    }
    if (cfg.markers?.length) {
      xs.push(cfg.markers.map((m) => m.x));
      ys.push(cfg.markers.map((m) => m.y));
    }
    const vIn = (cfg.vlines ?? []).filter((v) => v.includeInRange).map((v) => v.x);
    if (vIn.length) xs.push(vIn);
    const hIn = (cfg.hlines ?? []).filter((h) => h.includeInRange).map((h) => h.y);
    if (hIn.length) ys.push(hIn);

    if (cfg.xInclude?.length) xs.push(cfg.xInclude);
    if (cfg.yInclude?.length) ys.push(cfg.yInclude);

    const xr = resolveAxisRange(extentOf(xs), cfg.x);
    const yr = resolveAxisRange(extentOf(ys), cfg.y);
    const xFmt = cfg.x.format ?? formatTick;
    const yFmt = cfg.y.format ?? formatTick;

    // Header: the legend, wrapped into rows above the plot.
    const headerRows = this.layoutHeader(cfg, ctx, font);
    const header = headerRows.length ? headerRows.length * ROW_HEIGHT + 2 : 0;

    ctx.font = font(TICK_FONT_PX);
    let yLabelWidth = 0;
    for (const t of yr.ticks)
      yLabelWidth = Math.max(yLabelWidth, ctx.measureText(yFmt(t, yr.step)).width);
    const lastX = xr.ticks.length ? xFmt(xr.ticks[xr.ticks.length - 1]!, xr.step) : '';
    const lastXHalf = ctx.measureText(lastX).width / 2;

    const yTitleWidth = cfg.y.label ? 16 : 0;
    const left = Math.round(6 + yTitleWidth + yLabelWidth + 6);
    const right = Math.round(this.cssWidth - Math.max(10, lastXHalf + 2));
    const top = 4 + header;
    const bottom = Math.round(this.cssHeight - (cfg.x.label ? 34 : 20));

    const xScale = new LinearScale(xr.min, xr.max, left, right);
    const yScale = cfg.y.inverted
      ? new LinearScale(yr.min, yr.max, top, bottom)
      : new LinearScale(yr.min, yr.max, bottom, top);
    return {
      left,
      right,
      top,
      bottom,
      xScale,
      yScale,
      xStep: xr.step,
      yStep: yr.step,
      xTicks: xr.ticks,
      yTicks: yr.ticks,
    };
  }

  /** Legend entries flowed into rows above the plot. */
  private layoutHeader(
    cfg: ChartConfig,
    ctx: CanvasRenderingContext2D,
    font: (px: number, weight?: string) => string,
  ): HeaderItem[][] {
    const labelled = cfg.series.filter((s) => s.legend !== false && s.label);
    const showLegend = cfg.legend ?? labelled.length >= 2;
    if (!showLegend) return [];
    ctx.font = font(TICK_FONT_PX);
    const rows: HeaderItem[][] = [];
    let row: HeaderItem[] = [];
    let x = 8;
    const maxX = this.cssWidth - 8;
    for (const s of labelled) {
      const item: HeaderItem = {
        series: s,
        text: s.label,
        width: 22 + ctx.measureText(s.label).width + 12,
      };
      if (row.length && x + item.width > maxX) {
        rows.push(row);
        row = [];
        x = 8;
      }
      row.push(item);
      x += item.width;
    }
    if (row.length) rows.push(row);
    return rows;
  }

  private drawHeader(
    ctx: CanvasRenderingContext2D,
    cfg: ChartConfig,
    theme: ChartTheme,
    font: (px: number, weight?: string) => string,
  ): void {
    const rows = this.layoutHeader(cfg, ctx, font);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    rows.forEach((row, r) => {
      const y = 4 + r * ROW_HEIGHT + ROW_HEIGHT / 2;
      let x = 8;
      for (const item of row) {
        const s = item.series;
        const color = resolveColor(s.color, theme);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = s.width ?? 2;
        ctx.setLineDash(s.dash ?? []);
        if (s.style !== 'scatter') {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 16, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        if (s.style === 'scatter' || s.style === 'line+points') {
          ctx.beginPath();
          ctx.arc(x + 8, y, s.pointRadius ?? 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.font = font(TICK_FONT_PX);
        ctx.fillStyle = theme.text;
        ctx.fillText(item.text, x + 22, y);
        x += item.width;
      }
    });
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    cfg: ChartConfig,
    layout: Layout,
    theme: ChartTheme,
    font: (px: number, weight?: string) => string,
  ): void {
    const { left, right, top, bottom, xScale, yScale } = layout;
    const xFmt = cfg.x.format ?? formatTick;
    const yFmt = cfg.y.format ?? formatTick;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);

    ctx.font = font(TICK_FONT_PX);
    ctx.fillStyle = theme.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const t of layout.yTicks) {
      const y = Math.round(yScale.map(t)) + 0.5;
      ctx.strokeStyle = Math.abs(t) < 1e-12 ? theme.gridStrong : theme.grid;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillText(yFmt(t, layout.yStep), left - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of layout.xTicks) {
      const x = Math.round(xScale.map(t)) + 0.5;
      ctx.strokeStyle = Math.abs(t) < 1e-12 ? theme.gridStrong : theme.grid;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.fillText(xFmt(t, layout.xStep), x, bottom + 5);
    }
    // Frame: left and bottom axes.
    ctx.strokeStyle = theme.gridStrong;
    ctx.beginPath();
    ctx.moveTo(left + 0.5, top);
    ctx.lineTo(left + 0.5, bottom + 0.5);
    ctx.lineTo(right, bottom + 0.5);
    ctx.stroke();

    if (cfg.x.label) {
      ctx.font = font(TICK_FONT_PX, '600');
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(cfg.x.label, right, this.cssHeight - 5);
    }
    if (cfg.y.label) {
      // Rotated title along the y axis; shrunk or shortened to fit the plot height.
      const available = bottom - top;
      let size = TICK_FONT_PX;
      ctx.font = font(size, '600');
      while (size > 9.5 && ctx.measureText(cfg.y.label).width > available) {
        size -= 0.5;
        ctx.font = font(size, '600');
      }
      ctx.save();
      ctx.translate(12, (top + bottom) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fitText(ctx, cfg.y.label, available), 0, 0);
      ctx.restore();
    }
  }

  private drawBands(
    ctx: CanvasRenderingContext2D,
    cfg: ChartConfig,
    layout: Layout,
    theme: ChartTheme,
  ): void {
    for (const band of cfg.bands ?? []) {
      const n = Math.min(band.x.length, band.y0.length, band.y1.length);
      if (n < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const px = layout.xScale.map(band.x[i]!);
        const py = layout.yScale.map(band.y1[i]!);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      for (let i = n - 1; i >= 0; i--) {
        ctx.lineTo(layout.xScale.map(band.x[i]!), layout.yScale.map(band.y0[i]!));
      }
      ctx.closePath();
      ctx.globalAlpha = band.alpha ?? 0.18;
      ctx.fillStyle = resolveColor(band.color, theme);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawAnnotationLines(
    ctx: CanvasRenderingContext2D,
    cfg: ChartConfig,
    layout: Layout,
    theme: ChartTheme,
    font: (px: number, weight?: string) => string,
  ): void {
    ctx.font = font(10.5, '600');
    ctx.textBaseline = 'top';
    for (const v of cfg.vlines ?? []) {
      if (!Number.isFinite(v.x)) continue;
      const x = Math.round(layout.xScale.map(v.x)) + 0.5;
      const color = v.color ? resolveColor(v.color, theme) : theme.textMuted;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(v.dash ?? [5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, layout.top);
      ctx.lineTo(x, layout.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      if (v.label) {
        const w = ctx.measureText(v.label).width;
        const rightSide = x + 4 + w <= layout.right;
        ctx.textAlign = rightSide ? 'left' : 'right';
        haloText(ctx, theme, v.label, rightSide ? x + 4 : x - 4, layout.top + 3, color);
      }
    }
    for (const h of cfg.hlines ?? []) {
      if (!Number.isFinite(h.y)) continue;
      const y = Math.round(layout.yScale.map(h.y)) + 0.5;
      const color = h.color ? resolveColor(h.color, theme) : theme.textMuted;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(h.dash ?? [5, 4]);
      ctx.beginPath();
      ctx.moveTo(layout.left, y);
      ctx.lineTo(layout.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (h.label) {
        ctx.textAlign = 'right';
        // Sit just above the line (or below if it would leave the plot).
        const above = y - 12 > layout.top;
        ctx.textBaseline = above ? 'bottom' : 'top';
        haloText(ctx, theme, h.label, layout.right - 4, above ? y - 2 : y + 3, color);
        ctx.textBaseline = 'top';
      }
    }
    ctx.lineWidth = 1;
  }

  private drawSeries(
    ctx: CanvasRenderingContext2D,
    cfg: ChartConfig,
    layout: Layout,
    theme: ChartTheme,
  ): void {
    const { xScale, yScale } = layout;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of cfg.series) {
      const n = Math.min(s.x.length, s.y.length);
      if (n === 0) continue;
      const color = resolveColor(s.color, theme);
      const style = s.style ?? 'line';
      if (style !== 'scatter') {
        ctx.strokeStyle = color;
        ctx.lineWidth = s.width ?? 2;
        ctx.setLineDash(s.dash ?? []);
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) {
          const xv = s.x[i]!;
          const yv = s.y[i]!;
          if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
            pen = false;
            continue;
          }
          const px = xScale.map(xv);
          const py = yScale.map(yv);
          if (pen) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
          pen = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (style !== 'line') {
        ctx.fillStyle = color;
        const r = s.pointRadius ?? 3;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const xv = s.x[i]!;
          const yv = s.y[i]!;
          if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
          const px = xScale.map(xv);
          const py = yScale.map(yv);
          ctx.moveTo(px + r, py);
          ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D,
    cfg: ChartConfig,
    layout: Layout,
    theme: ChartTheme,
    font: (px: number, weight?: string) => string,
  ): void {
    for (const m of cfg.markers ?? []) {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      const px = layout.xScale.map(m.x);
      const py = layout.yScale.map(m.y);
      const r = m.radius ?? 5;
      const color = resolveColor(m.color, theme);
      if (m.ring !== false) {
        ctx.beginPath();
        ctx.arc(px, py, r + 3, 0, Math.PI * 2);
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = theme.halo;
      ctx.stroke();
      if (m.label) {
        ctx.font = font(10.5, '600');
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(m.label).width;
        // Prefer the upper left, where rising curves leave room; flip if that leaves the plot.
        let tx = px - r - 6;
        let align: CanvasTextAlign = 'right';
        if (tx - w < layout.left) {
          tx = px + r + 6;
          align = 'left';
        }
        let ty = py - r - 9;
        if (ty < layout.top + 6) ty = py + r + 9;
        ctx.textAlign = align;
        haloText(ctx, theme, m.label, tx, ty, theme.text);
      }
    }
  }

  private drawHover(
    ctx: CanvasRenderingContext2D,
    cfg: ChartConfig,
    layout: Layout,
    theme: ChartTheme,
    font: (px: number, weight?: string) => string,
  ): void {
    const h = this.hover;
    const series = cfg.series[h.seriesIndex];
    if (!series) return;
    const xv = series.x[h.pointIndex];
    const yv = series.y[h.pointIndex];
    if (xv === undefined || yv === undefined || !Number.isFinite(xv) || !Number.isFinite(yv))
      return;
    const px = layout.xScale.map(xv);
    const py = layout.yScale.map(yv);

    // Crosshair.
    ctx.save();
    ctx.strokeStyle = theme.gridStrong;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, layout.top);
    ctx.lineTo(Math.round(px) + 0.5, layout.bottom);
    ctx.moveTo(layout.left, Math.round(py) + 0.5);
    ctx.lineTo(layout.right, Math.round(py) + 0.5);
    ctx.stroke();
    ctx.restore();

    // Values of every series that shares this x sample (aligned grids), hovered series first.
    const xFmt = cfg.x.tooltipFormat ?? formatValue;
    const yFmt = cfg.y.tooltipFormat ?? formatValue;
    const entries: { color: string; text: string }[] = [
      { color: resolveColor(series.color, theme), text: `${series.label}: ${yFmt(yv)}` },
    ];
    cfg.series.forEach((s, idx) => {
      if (idx === h.seriesIndex) return;
      const ox = s.x[h.pointIndex];
      const oy = s.y[h.pointIndex];
      if (ox === undefined || oy === undefined || !Number.isFinite(oy)) return;
      if (Math.abs(ox - xv) > 1e-9 * Math.max(1, Math.abs(xv))) return;
      entries.push({ color: resolveColor(s.color, theme), text: `${s.label}: ${yFmt(oy)}` });
    });
    const title = `${cfg.x.short ?? cfg.x.label} = ${xFmt(xv)}`;

    // Highlight dot on the hovered point.
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = entries[0]!.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.halo;
    ctx.stroke();

    // Tooltip box.
    ctx.font = font(11);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const swatch = 13;
    let w = ctx.measureText(title).width;
    for (const e of entries) w = Math.max(w, ctx.measureText(e.text).width + swatch);
    const boxW = w + 14;
    const rowH = 16;
    const boxH = (entries.length + 1) * rowH + 8;
    let bx = px + 12;
    if (bx + boxW > this.cssWidth - 2) bx = px - 12 - boxW;
    bx = Math.max(2, bx);
    let by = py - boxH - 10;
    if (by < 2) by = py + 12;
    by = Math.max(2, Math.min(by, this.cssHeight - boxH - 2));
    ctx.fillStyle = theme.tooltipBg;
    ctx.strokeStyle = theme.gridStrong;
    roundRect(ctx, bx, by, boxW, boxH, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.tooltipText;
    ctx.fillText(title, bx + 7, by + 4 + rowH / 2);
    entries.forEach((e, i) => {
      const ty = by + 4 + (i + 1) * rowH + rowH / 2;
      ctx.fillStyle = e.color;
      ctx.fillRect(bx + 7, ty - 4, 8, 8);
      ctx.fillStyle = theme.tooltipText;
      ctx.fillText(e.text, bx + 7 + swatch, ty);
    });
  }
}

interface HeaderItem {
  text: string;
  width: number;
  series: ChartSeries;
}

/** Shorten `text` with an ellipsis so it fits `maxWidth` in the context's current font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut--;
  return `${text.slice(0, cut)}…`;
}

/** Text with a thin halo in the panel colour so it stays legible over lines. */
function haloText(
  ctx: CanvasRenderingContext2D,
  theme: ChartTheme,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
