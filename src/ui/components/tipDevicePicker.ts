/**
 * Wingtip device picker: illustrated radio cards (front view of a wing tip) for each device
 * kind, plus a one-line plain-language description of the selected one.
 */
import type { TipDeviceKind } from '../../state/params';
import { h, svg, uid } from '../dom';
import type { Control } from './control';

export interface TipDeviceInfo {
  kind: TipDeviceKind;
  name: string;
  /** Aircraft that use it, for the card caption. */
  aircraft: string;
  /** What it does, in plain language. */
  blurb: string;
}

export const TIP_DEVICES: readonly TipDeviceInfo[] = [
  {
    kind: 'none',
    name: 'None',
    aircraft: 'Plain tip',
    blurb:
      'The wing simply ends. Air curls around the tip from the high-pressure underside to the low-pressure top and forms a strong swirling vortex, which wastes energy.',
  },
  {
    kind: 'canted-winglet',
    name: 'Canted winglet',
    aircraft: '747-400',
    blurb:
      'A short fin tilted outward, joined at a sharp corner. It weakens the tip vortex a little and trims drag in cruise.',
  },
  {
    kind: 'blended-winglet',
    name: 'Blended winglet',
    aircraft: '737NG / A320neo',
    blurb:
      'The wing curves smoothly up into a tall winglet. The gentle bend avoids the extra drag of a sharp corner.',
  },
  {
    kind: 'raked-tip',
    name: 'Raked tip',
    aircraft: '747-8 / 787',
    blurb:
      'No fin at all: the tip adds span and sweeps back sharply. A longer wing spreads its lift over more air, so the vortex is weaker.',
  },
  {
    kind: 'split-winglet',
    name: 'Split winglet',
    aircraft: '737 MAX',
    blurb:
      'A winglet above the tip and a smaller fin below it. Two surfaces catch more of the swirling air.',
  },
  {
    kind: 'wingtip-fence',
    name: 'Wingtip fence',
    aircraft: 'A380',
    blurb:
      'A small plate above and below the tip. A simple way to stop some air from curling around the end.',
  },
];

/** Front-view drawings: the wing runs left to right, the tip is at the right. */
const ART: Record<TipDeviceKind, { wing: string; device?: string; dashed?: string }> = {
  none: { wing: 'M6 30H50' },
  'canted-winglet': { wing: 'M6 30H40', device: 'M40 30L50 13' },
  'blended-winglet': { wing: 'M6 30H34', device: 'M34 30C46 30 49 24 50 12' },
  'raked-tip': { wing: 'M6 30H40', dashed: 'M40 30L58 30' },
  'split-winglet': { wing: 'M6 30H42', device: 'M42 30L50 11M42 30L48 40' },
  'wingtip-fence': { wing: 'M6 30H46', device: 'M46 18V42' },
};

function art(kind: TipDeviceKind): SVGSVGElement {
  const spec = ART[kind];
  const root = svg('svg', {
    class: 'tip-card__svg',
    viewBox: '0 0 64 48',
    width: 64,
    height: 48,
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  root.append(svg('path', { d: spec.wing, class: 'tip-card__wing', 'stroke-width': 4 }));
  if (spec.dashed) {
    root.append(
      svg('path', {
        d: spec.dashed,
        class: 'tip-card__wing',
        'stroke-width': 4,
        'stroke-dasharray': '1 6',
      }),
    );
  }
  if (spec.device) {
    root.append(svg('path', { d: spec.device, class: 'tip-card__device', 'stroke-width': 3.5 }));
  }
  return root;
}

export interface TipDevicePickerOptions {
  value: TipDeviceKind;
  /** Written to the wrapper as `data-param`. */
  param?: string;
  onChange?(kind: TipDeviceKind): void;
}

export function createTipDevicePicker(options: TipDevicePickerOptions): Control<TipDeviceKind> {
  const name = uid('tip');
  const labelId = uid('tip-label');
  const descId = uid('tip-desc');
  const radios = new Map<TipDeviceKind, HTMLInputElement>();

  const grid = h('div', {
    class: 'tip-grid',
    role: 'radiogroup',
    'aria-labelledby': labelId,
    'aria-describedby': descId,
  });
  for (const info of TIP_DEVICES) {
    const input = h('input', { class: 'tip-card__input', type: 'radio', name, value: info.kind });
    radios.set(info.kind, input);
    grid.append(
      h(
        'label',
        { class: 'tip-card' },
        input,
        h('span', { class: 'tip-card__art' }, art(info.kind)),
        h('span', { class: 'tip-card__name' }, info.name),
        h('span', { class: 'tip-card__aircraft' }, info.aircraft),
      ),
    );
  }
  const desc = h('p', { class: 'tip-desc', id: descId });
  const el = h(
    'div',
    { class: 'field', dataset: { param: options.param } },
    h('div', { class: 'field__label', id: labelId }, 'Wingtip device'),
    grid,
    desc,
  );

  const show = (kind: TipDeviceKind) => {
    for (const [k, input] of radios) input.checked = k === kind;
    desc.textContent = TIP_DEVICES.find((d) => d.kind === kind)?.blurb ?? '';
  };
  show(options.value);

  const controller = new AbortController();
  grid.addEventListener(
    'change',
    (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement && target.checked) {
        const kind = target.value as TipDeviceKind;
        desc.textContent = TIP_DEVICES.find((d) => d.kind === kind)?.blurb ?? '';
        options.onChange?.(kind);
      }
    },
    { signal: controller.signal },
  );

  return { el, set: show, destroy: () => controller.abort() };
}
