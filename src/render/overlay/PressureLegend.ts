/**
 * A compact colour key floating at the bottom of the 3D view, in plain words:
 * "Low pressure · fast air" (blue) <-> "High pressure · slowed air" (red), or the speed scale
 * when the smoke is coloured by speed. DOM only (styled inline, so it needs no stylesheet); the
 * app places it in the uncovered part of the canvas and lifts it above the lesson card.
 */
import type { ColorBy } from '../../state/params';
import { flowSpeedColor, cssRgb, wingPressureColor } from '../util/palette';

const LABELS: Record<ColorBy, { low: string; high: string; aria: string }> = {
  pressure: {
    low: 'Low pressure · fast air',
    high: 'High pressure · slowed air',
    aria: 'Colour key: blue means low pressure and fast air, white means undisturbed air, red means high pressure and slowed air.',
  },
  speed: {
    low: 'Slow air',
    high: 'Fast air',
    aria: 'Colour key for the smoke: purple means slow air, teal means undisturbed air, yellow means fast air.',
  },
};

function gradient(mode: ColorBy): string {
  const stops: string[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    // Pressure: Cp from strong suction (left) to stagnation (right). Speed: slow -> fast.
    const c =
      mode === 'pressure'
        ? wingPressureColor(f < 0.5 ? -1.4 * (1 - 2 * f) : 2 * f - 1)
        : flowSpeedColor(0.2 + 1.6 * f);
    stops.push(`${cssRgb(c)} ${(f * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export class PressureLegend {
  readonly element: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly low: HTMLElement;
  private readonly high: HTMLElement;
  private mode: ColorBy | null = null;
  private compact: boolean | null = null;

  constructor(container: HTMLElement) {
    const doc = container.ownerDocument;
    const el = doc.createElement('div');
    el.className = 'al-legend';
    el.setAttribute('role', 'img');
    Object.assign(el.style, {
      position: 'absolute',
      left: '50%',
      bottom: '16px',
      transform: 'translateX(-50%)',
      zIndex: '5',
      display: 'grid',
      alignItems: 'center',
      justifyItems: 'center',
      maxWidth: 'calc(100% - 32px)',
      boxSizing: 'border-box',
      background: 'rgba(9, 15, 28, 0.72)',
      border: '1px solid rgba(150, 180, 220, 0.16)',
      boxShadow: '0 4px 18px rgba(0, 0, 0, 0.35)',
      backdropFilter: 'blur(6px)',
      color: 'rgba(222, 232, 246, 0.88)',
      font: '500 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
      letterSpacing: '0.01em',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      transition: 'left 0.25s ease',
    } satisfies Partial<CSSStyleDeclaration>);

    this.low = doc.createElement('span');
    this.high = doc.createElement('span');
    this.bar = doc.createElement('span');
    Object.assign(this.bar.style, {
      display: 'inline-block',
      width: '128px',
      height: '8px',
      borderRadius: '4px',
      boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.12)',
    } satisfies Partial<CSSStyleDeclaration>);
    el.append(this.low, this.bar, this.high);
    this.element = el;
    container.appendChild(el);
    this.setMode('pressure');
    this.setCompact(false);
  }

  /**
   * Compact layout for narrow views: the colour bar on top with the two labels under its ends,
   * instead of one line "label - bar - label".
   */
  setCompact(on: boolean): void {
    if (on === this.compact) return;
    this.compact = on;
    const s = this.element.style;
    const bar = this.bar.style;
    if (on) {
      s.gridTemplateColumns = 'auto auto';
      s.gridTemplateRows = 'auto auto';
      s.gap = '5px 18px';
      s.padding = '7px 12px 6px';
      s.borderRadius = '12px';
      s.fontSize = '11px';
      bar.gridColumn = '1 / span 2';
      bar.gridRow = '1';
      bar.width = '100%';
      this.low.style.gridRow = this.high.style.gridRow = '2';
      this.low.style.justifySelf = 'start';
      this.high.style.justifySelf = 'end';
    } else {
      s.gridTemplateColumns = 'auto 128px auto';
      s.gridTemplateRows = 'auto';
      s.gap = '10px';
      s.padding = '7px 12px';
      s.borderRadius = '999px';
      s.fontSize = '12px';
      bar.gridColumn = '2';
      bar.gridRow = '1';
      bar.width = '128px';
      this.low.style.gridRow = this.high.style.gridRow = '1';
      this.low.style.justifySelf = this.high.style.justifySelf = 'center';
    }
  }

  /** What the smoke colours mean: pressure (default) or speed. */
  setMode(mode: ColorBy): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const l = LABELS[mode];
    this.low.textContent = l.low;
    this.high.textContent = l.high;
    this.element.setAttribute('aria-label', l.aria);
    this.bar.style.background = gradient(mode);
  }

  /**
   * Place the key `offset` px above the container's bottom edge, centred on `x` (px from the
   * container's left edge); or, with `fromTop` (while a lesson card occupies the bottom),
   * `offset` px below the top edge, starting at `x`.
   */
  setPlacement(x: number, offset: number, fromTop = false): void {
    const s = this.element.style;
    // At the bottom the key is centred on x; at the top (out of the way) it starts at x.
    s.transform = fromTop ? 'none' : 'translateX(-50%)';
    if (Number.isFinite(x)) s.left = `${Math.round(x)}px`;
    if (!Number.isFinite(offset)) return;
    const px = `${Math.round(Math.max(0, offset))}px`;
    if (fromTop) {
      s.top = px;
      s.bottom = 'auto';
    } else {
      s.bottom = px;
      s.top = 'auto';
    }
  }

  setVisible(on: boolean): void {
    this.element.style.display = on ? 'grid' : 'none';
  }

  dispose(): void {
    this.element.remove();
  }
}
