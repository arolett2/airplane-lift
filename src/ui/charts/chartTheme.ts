/**
 * Chart colours. The shell defines CSS custom properties (--chart-grid, --chart-text,
 * --series-1..4, --lift, --drag); we read them with getComputedStyle and fall back to a palette
 * that works on both a dark and a light page when they are missing.
 */

export interface ChartTheme {
  /** Gridline colour. */
  grid: string;
  /** Slightly stronger line for the zero axes and plot frame. */
  gridStrong: string;
  /** Tick and axis label colour. */
  text: string;
  /** De-emphasised text (axis titles, annotations). */
  textMuted: string;
  /** Tooltip panel. */
  tooltipBg: string;
  tooltipText: string;
  /** Surface behind the markers' halo (the panel colour, roughly). */
  halo: string;
  /** Font family for canvas text. */
  fontFamily: string;
  /** Resolved values of the custom properties we know about, keyed "--series-1" etc. */
  tokens: Record<string, string>;
  dark: boolean;
}

const SERIES_DARK = ['#5aa9ff', '#ffb454', '#7ddc9a', '#d08cff'];
const SERIES_LIGHT = ['#1f6feb', '#d9730d', '#1a9b55', '#8a4fd0'];

/** True when the page is (or prefers to be) dark. `data-theme` on <html> wins over the OS. */
export function prefersDark(): boolean {
  if (typeof document === 'undefined') return true;
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

function readProperty(style: CSSStyleDeclaration | null, name: string): string {
  if (!style) return '';
  try {
    return style.getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

/** Read the chart theme as seen from `el` (custom properties inherit from the shell). */
export function readChartTheme(el: Element): ChartTheme {
  let style: CSSStyleDeclaration | null;
  try {
    style = getComputedStyle(el);
  } catch {
    style = null;
  }
  const dark = prefersDark();
  const series = dark ? SERIES_DARK : SERIES_LIGHT;
  const fallbacks: Record<string, string> = {
    '--chart-grid': dark ? 'rgba(160, 175, 200, 0.16)' : 'rgba(40, 55, 80, 0.14)',
    '--chart-text': dark ? '#aab6c6' : '#4a5565',
    '--series-1': series[0]!,
    '--series-2': series[1]!,
    '--series-3': series[2]!,
    '--series-4': series[3]!,
    '--lift': dark ? '#4ade80' : '#1a9b55',
    '--drag': dark ? '#ff8a5c' : '#d9480f',
  };
  const tokens: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(fallbacks)) {
    tokens[name] = readProperty(style, name) || fallback;
  }
  const font = style?.fontFamily?.trim();
  return {
    grid: tokens['--chart-grid']!,
    gridStrong: dark ? 'rgba(180, 195, 220, 0.38)' : 'rgba(40, 55, 80, 0.38)',
    text: tokens['--chart-text']!,
    textMuted: dark ? 'rgba(170, 182, 198, 0.78)' : 'rgba(74, 85, 101, 0.82)',
    tooltipBg: dark ? 'rgba(14, 20, 30, 0.94)' : 'rgba(255, 255, 255, 0.96)',
    tooltipText: dark ? '#e8eef7' : '#17202c',
    halo: dark ? '#0f1621' : '#ffffff',
    fontFamily: font || 'system-ui, -apple-system, "Segoe UI", sans-serif',
    tokens,
    dark,
  };
}

const VAR_PATTERN = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+?))?\s*\)$/;

/**
 * Canvas cannot parse `var(--x, fallback)`, so resolve it against the theme.
 * Plain colours pass through unchanged.
 */
export function resolveColor(value: string, theme: ChartTheme): string {
  const match = VAR_PATTERN.exec(value.trim());
  if (!match) return value;
  const [, name, fallback] = match;
  return theme.tokens[name!] ?? fallback ?? value;
}
