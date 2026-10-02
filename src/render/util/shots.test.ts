import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tunnelDomain } from '../../physics/domain';
import type { CameraShot } from '../../state/params';
import { computeShot, DISPLAY_LENGTH, extentsFromDomain, fitDistance } from './shots';

const SHOTS: CameraShot[] = ['overview', 'side', 'front', 'top', 'tip', 'behind', 'section'];

function screenAxes(pos: number[], target: number[]) {
  // Camera basis for a Z-up camera, as three's lookAt builds it.
  const cam = new THREE.PerspectiveCamera();
  cam.up.set(0, 0, 1);
  cam.position.set(pos[0]!, pos[1]!, pos[2]!);
  cam.lookAt(target[0]!, target[1]!, target[2]!);
  cam.updateMatrixWorld();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  return { right, up };
}

describe('extentsFromDomain', () => {
  it('maps the domain length to the display length and centres it', () => {
    const d = tunnelDomain(40, 4);
    const e = extentsFromDomain(d);
    expect(e.size[0]).toBeCloseTo(DISPLAY_LENGTH, 10);
    expect(e.scale).toBeCloseTo(DISPLAY_LENGTH / (d.max[0] - d.min[0]), 12);
    // The wing pivot (physics origin) sits ahead of the centre because the tunnel is longer behind.
    expect(e.pivot[0]).toBeLessThan(0);
    expect(e.pivot[1]).toBeCloseTo(0, 10);
  });

  it('recovers the semispan from the domain width', () => {
    const span = 35;
    const e = extentsFromDomain(tunnelDomain(span, 3));
    expect(e.semispan / e.scale).toBeCloseTo(span / 2, 8);
  });
});

describe('fitDistance', () => {
  it('grows with the object size and shrinks for wide viewports', () => {
    const near = fitDistance(4, 2, 0, 40, 1.6);
    const far = fitDistance(8, 4, 0, 40, 1.6);
    expect(far).toBeCloseTo(2 * near, 8);
    expect(fitDistance(4, 2, 0, 40, 0.6)).toBeGreaterThan(near);
  });
});

describe('computeShot', () => {
  const ext = extentsFromDomain(tunnelDomain(30, 3));

  it('returns finite poses for every shot, at any aspect', () => {
    for (const shot of SHOTS) {
      for (const aspect of [0.5, 1, 1.78, 3]) {
        const p = computeShot(shot, ext, 40, aspect);
        for (const v of [...p.position, ...p.target]) expect(Number.isFinite(v)).toBe(true);
        const dist = Math.hypot(
          p.position[0] - p.target[0],
          p.position[1] - p.target[1],
          p.position[2] - p.target[2],
        );
        expect(dist).toBeGreaterThan(0.05);
      }
    }
  });

  it('side view: airflow (+x) runs left to right on screen', () => {
    const p = computeShot('side', ext, 40, 1.6);
    expect(p.position[1]).toBeLessThan(0); // camera at -y
    const { right, up } = screenAxes(p.position, p.target);
    expect(right.x).toBeGreaterThan(0.99);
    expect(up.z).toBeGreaterThan(0.99);
  });

  it('top view: airflow runs left to right and the right wing is up the screen', () => {
    const p = computeShot('top', ext, 40, 1.6);
    const { right, up } = screenAxes(p.position, p.target);
    expect(right.x).toBeGreaterThan(0.99);
    expect(up.y).toBeGreaterThan(0.99);
  });

  it('front view looks downstream and behind view looks upstream', () => {
    const f = computeShot('front', ext, 40, 1.6);
    expect(f.position[0]).toBeLessThan(f.target[0]);
    const b = computeShot('behind', ext, 40, 1.6);
    expect(b.position[0]).toBeGreaterThan(b.target[0]);
    // Looking from behind, the right wing (+y) is on the screen's right.
    const { right } = screenAxes(b.position, b.target);
    expect(right.y).toBeGreaterThan(0.99);
  });

  it('overview is from the front-left above', () => {
    const p = computeShot('overview', ext, 40, 1.6);
    expect(p.position[0]).toBeLessThan(p.target[0]); // upstream
    expect(p.position[1]).toBeLessThan(p.target[1]); // left (-y)
    expect(p.position[2]).toBeGreaterThan(p.target[2]); // above
  });

  it('tip view sits near the right tip, behind and outboard of it', () => {
    const p = computeShot('tip', ext, 40, 1.6);
    expect(p.position[1]).toBeGreaterThan(ext.pivot[1] + ext.semispan);
    expect(p.position[0]).toBeGreaterThan(ext.pivot[0]);
  });

  it('section view is much closer than the side view', () => {
    const sec = computeShot('section', ext, 40, 1.6);
    const side = computeShot('side', ext, 40, 1.6);
    expect(Math.abs(sec.position[1] - sec.target[1])).toBeLessThan(
      0.6 * Math.abs(side.position[1] - side.target[1]),
    );
  });
});
