/**
 * Small SVG drawing of a NACA 4-digit airfoil section with its mean camber line, redrawn live
 * as the camber / thickness sliders move.
 */
import { generateAirfoil, nacaCamber, nacaName } from '../../physics/airfoil/naca';
import type { Naca4Params } from '../../physics/types';
import { svg } from '../dom';
import type { Control } from './control';

const CAMBER_STEPS = 20;

export interface AirfoilThumb extends Control<Naca4Params, SVGSVGElement> {
  /** The designation currently drawn, e.g. "NACA 2412". */
  readonly name: () => string;
}

export function createAirfoilThumb(initial: Naca4Params): AirfoilThumb {
  const outline = svg('path', { class: 'airfoil-thumb__outline' });
  const camberLine = svg('path', { class: 'airfoil-thumb__camber' });
  const chordLine = svg('path', { class: 'airfoil-thumb__chord', d: 'M0 0H1' });
  const el = svg(
    'svg',
    {
      class: 'airfoil-thumb',
      // y is flipped below so up is up; the box leaves room for 25% thick, 9% cambered sections.
      viewBox: '-0.04 -0.19 1.08 0.38',
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
    },
    chordLine,
    outline,
    camberLine,
  );
  let currentName = '';

  const draw = (params: Naca4Params) => {
    const { coords, nPoints } = generateAirfoil(params, 64);
    let d = '';
    for (let i = 0; i < nPoints; i++) {
      d += `${i === 0 ? 'M' : 'L'}${coords[2 * i]!.toFixed(4)} ${(-coords[2 * i + 1]!).toFixed(4)}`;
    }
    outline.setAttribute('d', `${d}Z`);

    let c = '';
    for (let i = 0; i <= CAMBER_STEPS; i++) {
      const x = i / CAMBER_STEPS;
      c += `${i === 0 ? 'M' : 'L'}${x.toFixed(3)} ${(-nacaCamber(params, x).yc).toFixed(4)}`;
    }
    camberLine.setAttribute('d', c);

    currentName = nacaName(params);
    el.setAttribute('aria-label', `${currentName} wing section`);
  };
  draw(initial);

  let last = initial;
  return {
    el,
    name: () => currentName,
    set(params) {
      if (
        params === last ||
        (params.camber === last.camber &&
          params.camberPos === last.camberPos &&
          params.thickness === last.thickness)
      ) {
        last = params;
        return;
      }
      last = params;
      draw(params);
    },
    destroy() {
      /* nothing to release */
    },
  };
}
