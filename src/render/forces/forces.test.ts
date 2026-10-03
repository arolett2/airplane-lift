// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  ARROW_REFERENCE_SEMISPANS,
  DRAG_VISUAL_SCALE,
  MAX_DRAG_SEMISPANS,
  arrowLengths,
  arrowShape,
} from './arrowMath';
import {
  AMBER_FULL,
  AMBER_START,
  curtainBasis,
  curtainScale,
  ellipticalLoad,
  stallMarginColor,
} from './curtainMath';
import { ForceArrows } from './ForceArrows';
import { SpanLoadViz } from './SpanLoadViz';
import { makeTestAero, makeTestStrips, makeTestWing } from '../util/testFixtures';
import { getFrameTick } from '../util/frameTick';
import type { RGB } from '../../shared/colormaps';
import type { Vec3 } from '../../physics/types';

describe('arrowLengths', () => {
  it('scales lift and weight together against the larger one', () => {
    const l = arrowLengths(10, 1000, 100, null);
    expect(l.lift).toBeCloseTo(ARROW_REFERENCE_SEMISPANS * 10, 10);
    expect(l.weight).toBe(0);
    expect(l.drag).toBeCloseTo(ARROW_REFERENCE_SEMISPANS * 10 * 0.1 * DRAG_VISUAL_SCALE, 10);

    const heavy = arrowLengths(10, 1000, 100, 2000);
    expect(heavy.weight).toBeCloseTo(ARROW_REFERENCE_SEMISPANS * 10, 10);
    expect(heavy.lift).toBeCloseTo(0.5 * ARROW_REFERENCE_SEMISPANS * 10, 10);

    const level = arrowLengths(10, 1000, 100, 1000);
    expect(level.lift).toBeCloseTo(level.weight, 12);
  });

  it('clamps drag, and treats missing or bad forces as zero length', () => {
    expect(arrowLengths(10, 100, 100, null).drag).toBeCloseTo(MAX_DRAG_SEMISPANS * 10, 10);
    const z = arrowLengths(10, NaN, -5, NaN);
    expect(z).toEqual({ lift: 0, drag: 0, weight: 0 });
    expect(arrowLengths(10, 0, 0, null)).toEqual({ lift: 0, drag: 0, weight: 0 });
  });
});

describe('arrowShape', () => {
  it('adds up to the requested length and stays sane for tiny arrows', () => {
    for (const len of [0.01, 0.2, 1, 6]) {
      const s = arrowShape(len, 10);
      expect(s.shaftLength + s.headLength).toBeCloseTo(len, 10);
      expect(s.shaftLength).toBeGreaterThanOrEqual(0);
      expect(s.headRadius).toBeGreaterThan(s.shaftRadius);
    }
  });
});

describe('curtain math', () => {
  it('colours green when far from stall, amber near it, red at or beyond it', () => {
    const c: RGB = [0, 0, 0];
    stallMarginColor(0.3, 1.5, c);
    const green = [...c];
    expect(green[1]).toBeGreaterThan(green[0]!);
    stallMarginColor(AMBER_START * 1.5 + 0.5 * (AMBER_FULL - AMBER_START) * 1.5, 1.5, c);
    const amber = [...c];
    expect(amber[0]).toBeGreaterThan(green[0]!);
    expect(amber[1]).toBeGreaterThan(0.3);
    stallMarginColor(1.6, 1.5, c);
    const red = [...c];
    expect(red[0]).toBeGreaterThan(red[1]! * 3);
    stallMarginColor(-1.6, 1.5, c); // negative stall counts too
    expect(c[0]).toBeCloseTo(red[0]!, 9);
    stallMarginColor(1, 0, c); // no clMax -> not alarming
    expect(c[1]).toBeGreaterThan(c[0]!);
  });

  it('builds a right-handed orthonormal basis, even for degenerate normals', () => {
    for (const n of [
      [0, 0, 1],
      [0, -0.97, 0.22],
      [0.3, 0.2, 0.93],
      [1, 0, 0],
      [0, 0, 0],
    ] as Vec3[]) {
      const c: Vec3 = [0, 0, 0];
      const t: Vec3 = [0, 0, 0];
      const nn: Vec3 = [0, 0, 0];
      curtainBasis(n, c, t, nn);
      const cc = new THREE.Vector3(...c);
      const tt = new THREE.Vector3(...t);
      const n3 = new THREE.Vector3(...nn);
      expect(cc.length()).toBeCloseTo(1, 9);
      expect(tt.length()).toBeCloseTo(1, 9);
      expect(n3.length()).toBeCloseTo(1, 9);
      expect(cc.dot(tt)).toBeCloseTo(0, 9);
      expect(cc.dot(n3)).toBeCloseTo(0, 9);
      expect(cc.clone().cross(tt).dot(n3)).toBeCloseTo(1, 9);
    }
  });

  it('elliptical load integrates to the total lift', () => {
    const b = 12;
    const L = 5000;
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const y = -b / 2 + ((i + 0.5) * b) / n;
      sum += ellipticalLoad(y, b, L) * (b / n);
    }
    expect(sum).toBeCloseTo(L, 0);
    expect(ellipticalLoad(7, b, L)).toBe(0);
  });

  it('curtainScale makes the larger of the two peaks reach the target height', () => {
    expect(curtainScale(200, 100, 2)).toBeCloseTo(0.01, 12);
    expect(curtainScale(100, 400, 2)).toBeCloseTo(0.005, 12);
    expect(curtainScale(0, 0, 2)).toBe(0);
  });
});

function labelsOf(obj: THREE.Object3D): CSS2DObject[] {
  const out: CSS2DObject[] = [];
  obj.traverse((o) => {
    if (o instanceof CSS2DObject) out.push(o);
  });
  return out;
}

describe('ForceArrows', () => {
  const geo = makeTestWing(); // semispan 5
  const aero = makeTestAero(geo);

  it('is hidden without data and draws nothing until updated', () => {
    const fa = new ForceArrows();
    fa.tick(0.1);
    fa.object.traverse((o) => {
      if (o.name.endsWith('Arrow')) expect(o.visible).toBe(false);
    });
    fa.update(null, geo, null);
    fa.snap();
    expect(fa.object.getObjectByName('LiftArrow')!.visible).toBe(false);
    fa.dispose();
  });

  it('sizes arrows from the forces: lift 0.6 semispan, drag x5, weight shares the lift scale', () => {
    const fa = new ForceArrows();
    fa.update(aero, geo, 120_000); // weight twice the lift
    fa.snap();
    const lift = fa.object.getObjectByName('LiftArrow')!;
    const drag = fa.object.getObjectByName('DragArrow')!;
    const weight = fa.object.getObjectByName('WeightArrow')!;
    const semispan = 5;
    const length = (g: THREE.Object3D) => {
      const shaft = g.children[0] as THREE.Mesh;
      const head = g.children[1] as THREE.Mesh;
      return shaft.scale.z + head.scale.z;
    };
    expect(length(weight)).toBeCloseTo(0.6 * semispan, 6);
    expect(length(lift)).toBeCloseTo(0.3 * semispan, 6);
    expect(length(drag)).toBeCloseTo(0.6 * semispan * (4000 / 120_000) * 5, 6);
    fa.dispose();
  });

  it('points lift up, drag downstream and weight down, from the centre of pressure', () => {
    const fa = new ForceArrows();
    const a = makeTestAero(geo, undefined, { centerOfPressure: [0.7, 0.1, 0.2] });
    fa.update(a, geo, 60_000);
    fa.snap();
    const dirOf = (name: string) =>
      new THREE.Vector3(0, 0, 1).applyQuaternion(fa.object.getObjectByName(name)!.quaternion);
    const up = dirOf('LiftArrow');
    const dn = dirOf('WeightArrow');
    const dr = dirOf('DragArrow');
    expect(up.z).toBeCloseTo(1, 9);
    expect(dn.z).toBeCloseTo(-1, 9);
    expect(dr.x).toBeCloseTo(1, 9);
    for (const n of ['LiftArrow', 'DragArrow', 'WeightArrow']) {
      expect(fa.object.getObjectByName(n)!.position.toArray()).toEqual([0.7, 0.1, 0.2]);
    }
    fa.dispose();
  });

  it('eases toward new lengths instead of jumping', () => {
    const fa = new ForceArrows();
    fa.update(aero, geo, null);
    fa.tick(1 / 60);
    const lift = fa.object.getObjectByName('LiftArrow')!;
    const len = () =>
      (lift.children[0] as THREE.Mesh).scale.z + (lift.children[1] as THREE.Mesh).scale.z;
    const first = len();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.6 * 5 * 0.5);
    for (let i = 0; i < 120; i++) fa.tick(1 / 60);
    expect(len()).toBeCloseTo(0.6 * 5, 3);
    // Shrink back to nothing when the result disappears.
    fa.update(null, geo, null);
    for (let i = 0; i < 200; i++) fa.tick(1 / 60);
    expect(lift.visible).toBe(false);
    fa.dispose();
  });

  it('shows kN labels with the true values, and only a weight label when weight is given', () => {
    const fa = new ForceArrows();
    fa.update(aero, geo, null);
    fa.snap();
    const texts = labelsOf(fa.object).map((l) => l.element.textContent);
    expect(texts.some((t) => t === 'Lift 60.0 kN')).toBe(true);
    expect(texts.some((t) => t?.startsWith('Drag 4.00 kN') && t.includes('x5'))).toBe(true);
    expect(fa.object.getObjectByName('WeightArrow')!.visible).toBe(false);
    fa.update(aero, geo, 50_000);
    fa.snap();
    expect(labelsOf(fa.object).some((l) => l.element.textContent === 'Weight 50.0 kN')).toBe(true);
    fa.dispose();
  });

  it('setVisible hides the whole group (labels follow) and registers a frame tick', () => {
    const fa = new ForceArrows();
    expect(getFrameTick(fa.object)).toBeTypeOf('function');
    fa.setVisible(false);
    expect(fa.object.visible).toBe(false);
    fa.setVisible(true);
    expect(fa.object.visible).toBe(true);
    fa.dispose();
    expect(getFrameTick(fa.object)).toBeUndefined();
  });
});

describe('SpanLoadViz', () => {
  const geo = makeTestWing({ winglet: true });
  const strips = makeTestStrips(geo, {
    perSurface: 12,
    stallFromEta: 0.8,
    clMax: 1.0,
    peakCl: 0.9,
  });
  const aero = makeTestAero(geo, strips);

  it('is hidden without data', () => {
    const v = new SpanLoadViz();
    expect(v.object.visible).toBe(false);
    v.update(aero, geo);
    expect(v.object.visible).toBe(true);
    v.update(null, geo);
    expect(v.object.visible).toBe(false);
    v.update(aero, null);
    expect(v.object.visible).toBe(false);
    v.setVisible(false);
    v.update(aero, geo);
    expect(v.object.visible).toBe(false);
    v.dispose();
  });

  it('stands one bar per strip, taller where the load is higher, base on the strip centre', () => {
    const v = new SpanLoadViz();
    v.update(aero, geo);
    const bars = v.object.getObjectByName('LiftCurtainBars') as THREE.InstancedMesh;
    expect(bars.count).toBe(strips.length);
    const m = new THREE.Matrix4();
    const heightOf = (i: number) => {
      bars.getMatrixAt(i, m);
      const z = new THREE.Vector3();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      m.decompose(p, q, s);
      z.set(0, 0, 1);
      return {
        height: s.z,
        base: p.clone().sub(new THREE.Vector3(...strips[i]!.center)),
        scale: s,
      };
    };
    // Strips 0..11 are the right wing, rooted at eta ~ 0 where the elliptical load is highest.
    const root = heightOf(0);
    const near = heightOf(10);
    expect(root.height).toBeGreaterThan(near.height);
    // Bars stand on the strip centre: offset from the centre is half the height along +z.
    expect(root.base.z).toBeCloseTo(root.height / 2, 6);
    expect(root.base.x).toBeCloseTo(0, 6);
    expect(root.base.y).toBeCloseTo(0, 6);
    // Heights are proportional to liftPerSpan.
    const ratio = heightOf(0).height / strips[0]!.liftPerSpan;
    for (const i of [1, 5, 9]) {
      expect(heightOf(i).height / strips[i]!.liftPerSpan).toBeCloseTo(ratio, 6);
    }
    v.dispose();
  });

  it('colours stalled strips red, high-margin strips green and near-stall strips amber', () => {
    const custom = strips.map((s, k) => ({
      ...s,
      stalled: k === 3,
      cl: k === 4 ? 0.75 : k === 3 ? 0.3 : 0.2,
      clMax: 1.0,
    }));
    const v = new SpanLoadViz();
    v.update(makeTestAero(geo, custom), geo);
    const bars = v.object.getObjectByName('LiftCurtainBars') as THREE.InstancedMesh;
    const c = bars.instanceColor!;
    const rgb = (i: number) => [c.getX(i), c.getY(i), c.getZ(i)] as const;
    const red = rgb(3);
    expect(red[0]).toBeGreaterThan(red[1] * 3);
    const amber = rgb(4);
    expect(amber[0]).toBeGreaterThan(amber[2] * 3);
    expect(amber[1]).toBeGreaterThan(0.3);
    const green = rgb(5);
    expect(green[1]).toBeGreaterThan(green[0]);
    v.dispose();
  });

  it('draws a dashed ellipse of the same total lift on the base wing', () => {
    const flat = makeTestWing(); // no winglets, flat: strip centres at z = 0, normals +z
    const s = makeTestStrips(flat, { perSurface: 16 });
    const a = makeTestAero(flat, s);
    const v = new SpanLoadViz();
    v.update(a, flat);
    const ell = v.object.getObjectByName('EllipticalReference') as THREE.LineSegments;
    expect(ell.visible).toBe(true);
    const pos = ell.geometry.getAttribute('position') as THREE.BufferAttribute;
    const span = flat.referenceSpan;
    // Heights follow the ellipse shape: z(y) / z(0) = sqrt(1 - (2y/b)^2).
    let peak = 0;
    for (let i = 0; i < pos.count; i++) peak = Math.max(peak, pos.getZ(i));
    expect(peak).toBeGreaterThan(0);
    for (let i = 0; i < pos.count; i += 7) {
      const y = pos.getY(i);
      const expected = peak * Math.sqrt(Math.max(0, 1 - ((2 * y) / span) ** 2));
      expect(pos.getZ(i)).toBeCloseTo(expected, 3);
    }
    // Spans the full wing.
    expect(pos.getY(0)).toBeCloseTo(-span / 2, 6);
    expect(pos.getY(pos.count - 1)).toBeCloseTo(span / 2, 6);
    // Dashed: index buffer pairs every other point.
    expect(ell.geometry.index!.count).toBe(pos.count);
    v.dispose();
  });

  it('grows its instance buffers when the strip count increases', () => {
    const v = new SpanLoadViz();
    const big = makeTestStrips(geo, { perSurface: 80 });
    v.update(makeTestAero(geo, big), geo);
    const bars = v.object.getObjectByName('LiftCurtainBars') as THREE.InstancedMesh;
    expect(bars.count).toBe(big.length);
    expect(bars.instanceMatrix.count).toBeGreaterThanOrEqual(big.length);
    v.dispose();
  });
});
