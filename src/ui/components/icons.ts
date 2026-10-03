/**
 * A small set of line icons (24x24 grid, stroked with currentColor) so the UI needs no icon
 * font or image files. Decorative: they are hidden from assistive tech, so every button that
 * uses one must carry its own accessible name.
 */
import { svg } from '../dom';

export type IconName =
  | 'menu'
  | 'sliders'
  | 'numbers'
  | 'charts'
  | 'section'
  | 'book'
  | 'compare'
  | 'pulse'
  | 'camera'
  | 'share'
  | 'check'
  | 'close'
  | 'chevron'
  | 'info'
  | 'play'
  | 'pause'
  | 'plane'
  | 'airfoil'
  | 'winglet'
  | 'flaps'
  | 'eye'
  | 'gear'
  | 'expand'
  | 'probe';

/** SVG path data per icon. Several sub-paths are joined with spaces. */
const PATHS: Record<IconName, string[]> = {
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  sliders: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 4.5v5', 'M9 14.5v5'],
  numbers: ['M5 20v-6', 'M12 20V5', 'M19 20v-10'],
  charts: ['M3 17l5-6 4 3 8-9', 'M3 21h18'],
  section: ['M3 12c4-7 12-7 18 0', 'M3 12c4 3 12 3 18 0', 'M3 20h18'],
  book: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z', 'M5 17a3 3 0 0 1 3-3h11'],
  compare: ['M3.5 5h7v14h-7z', 'M13.5 5h7v14h-7z'],
  pulse: ['M2 12h4l3-8 4 16 3-8h6'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 11a3.2 3.2 0 1 0 0 6.4A3.2 3.2 0 0 0 12 11z'],
  share: ['M12 4v11', 'M8 8l4-4 4 4', 'M5 13v6h14v-6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chevron: ['M6 9l6 6 6-6'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5.5', 'M12 7.6h.01'],
  play: ['M8 5.5v13l10.5-6.5z'],
  pause: ['M8.5 5v14', 'M15.5 5v14'],
  plane: [
    'M12 2.5c1 0 1.6 1 1.6 2.4v4.6l8 4.6v2l-8-2.2v4.2l2.2 1.8v1.6L12 19.8l-3.8 1.7v-1.6l2.2-1.8v-4.2l-8 2.2v-2l8-4.6V4.9c0-1.4.6-2.4 1.6-2.4z',
  ],
  airfoil: ['M3 14c3-4.5 9-6 18-2.5-8 4.5-14 4.5-18 2.5z'],
  winglet: ['M3 19h11', 'M14 19l5-13', 'M14 19l3 2'],
  flaps: ['M3 9h11', 'M14 9l6 7', 'M3 9v4h9'],
  eye: [
    'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z',
    'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  ],
  expand: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  probe: ['M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M10 9.2v1.6', 'M14.5 14.5L20 20'],
  gear: [
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    'M19.5 12h1.5M3 12h1.5M12 3v1.5M12 19.5V21M17.3 6.7l1-1M5.7 18.3l1-1M17.3 17.3l1 1M5.7 5.7l1 1',
  ],
};

/** Build an icon element. `size` is in CSS pixels. */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const root = svg('svg', {
    class: `icon icon--${name}`,
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  for (const d of PATHS[name]) root.append(svg('path', { d }));
  return root;
}
