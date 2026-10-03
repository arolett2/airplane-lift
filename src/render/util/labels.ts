/**
 * CSS2D label helpers. Labels are plain DOM elements positioned by `CSS2DRenderer`, so they stay
 * crisp and are styled inline (no stylesheet dependency). They never take pointer events.
 */
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export interface LabelStyle {
  /** CSS colour of the text and border. */
  color: string;
  /** Extra class name so the UI layer can restyle labels. */
  className?: string;
}

/** Create a label, or null when there is no DOM (tests, workers). */
export function createLabel(text: string, style: LabelStyle): CSS2DObject | null {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.className = `al-label ${style.className ?? ''}`.trim();
  const s = el.style;
  s.pointerEvents = 'none';
  s.whiteSpace = 'nowrap';
  s.font = '600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif';
  s.letterSpacing = '0.01em';
  s.padding = '3px 8px';
  s.borderRadius = '6px';
  s.color = style.color;
  s.border = `1px solid ${style.color}`;
  s.background = 'rgba(8, 14, 24, 0.72)';
  s.textShadow = '0 1px 2px rgba(0, 0, 0, 0.6)';
  s.opacity = '0.95';
  el.textContent = text;
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1.15);
  return label;
}

/** Update label text, touching the DOM only when it changed. */
export function setLabelText(label: CSS2DObject, text: string): void {
  if (label.element.textContent !== text) label.element.textContent = text;
}

/** Format a force in newtons as kN (or N when tiny) with sensible precision. */
export function formatKilonewtons(newtons: number): string {
  if (!Number.isFinite(newtons)) return '-- kN';
  const kn = newtons / 1000;
  const a = Math.abs(kn);
  if (a < 0.1) return `${Math.round(newtons)} N`;
  if (a < 10) return `${kn.toFixed(2)} kN`;
  if (a < 100) return `${kn.toFixed(1)} kN`;
  return `${Math.round(kn).toLocaleString('en-US')} kN`;
}
