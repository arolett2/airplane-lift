import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraTween } from './cameraTween';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('CameraTween', () => {
  it('starts inactive and does not touch outputs', () => {
    const t = new CameraTween();
    const p = v(1, 2, 3);
    const g = v(0, 0, 0);
    expect(t.update(0.1, p, g)).toBe(false);
    expect(p.toArray()).toEqual([1, 2, 3]);
  });

  it('lands exactly on the destination and then deactivates', () => {
    const t = new CameraTween();
    t.start(v(-10, 0, 2), v(0, 0, 0), v(0, -8, 1), v(1, 0, 0), 0.9);
    const p = v(0, 0, 0);
    const g = v(0, 0, 0);
    let steps = 0;
    while (t.update(1 / 60, p, g) && steps++ < 200) {
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    }
    expect(t.isActive).toBe(false);
    expect(p.distanceTo(v(0, -8, 1))).toBeLessThan(1e-9);
    expect(g.distanceTo(v(1, 0, 0))).toBeLessThan(1e-9);
    // ~0.9 s at 60 fps
    expect(steps).toBeGreaterThan(50);
    expect(steps).toBeLessThan(60);
  });

  it('is eased: slow at both ends, fast in the middle', () => {
    const t = new CameraTween();
    t.start(v(-10, 0, 0), v(0, 0, 0), v(-2, 0, 0), v(0, 0, 0), 1);
    const p = v(0, 0, 0);
    const g = v(0, 0, 0);
    t.update(0.1, p, g);
    const early = Math.abs(p.x - -10);
    t.update(0.4, p, g); // t = 0.5
    const mid = p.x;
    expect(early).toBeLessThan(0.3);
    expect(mid).toBeGreaterThan(-8);
    expect(mid).toBeLessThan(-3);
  });

  it('swings around the model between opposite views instead of passing through it', () => {
    const t = new CameraTween();
    t.start(v(-10, 0, 0), v(0, 0, 0), v(10, 0, 0), v(0, 0, 0), 1);
    const p = v(0, 0, 0);
    const g = v(0, 0, 0);
    let minDist = Infinity;
    for (let i = 0; i < 100; i++) {
      t.update(0.01, p, g);
      minDist = Math.min(minDist, p.distanceTo(g));
    }
    expect(minDist).toBeGreaterThan(9.9);
  });

  it('can be cancelled', () => {
    const t = new CameraTween();
    t.start(v(-10, 0, 0), v(0, 0, 0), v(0, -8, 1), v(0, 0, 0));
    t.cancel();
    expect(t.isActive).toBe(false);
  });
});
