import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tunnelDomain } from '../../physics/domain';
import { getFrameTick } from '../util/frameTick';
import { WindTunnel } from './WindTunnel';

function boundsOf(obj: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  obj.updateMatrixWorld(true);
  box.setFromObject(obj);
  return box;
}

describe('WindTunnel', () => {
  const domain = tunnelDomain(36, 4);

  it('builds the scenery inside (or just at) the domain bounds', () => {
    const t = new WindTunnel();
    t.setDomain(domain);
    const names = new Set<string>();
    t.object.traverse((o) => names.add(o.name));
    for (const n of [
      'FloorGrid',
      'FloorPlate',
      'WallLeft',
      'WallRight',
      'Ceiling',
      'Edges',
      'Ribs',
      'HoneycombFront',
      'HoneycombBack',
      'OutletPanel',
      'OutletFan',
    ]) {
      expect(names.has(n)).toBe(true);
    }
    const box = boundsOf(t.object);
    const tol = 0.05; // the floor plate sits a hair below the grid
    expect(box.min.x).toBeGreaterThanOrEqual(domain.min[0] - tol);
    expect(box.max.x).toBeLessThanOrEqual(domain.max[0] + tol);
    expect(box.min.y).toBeGreaterThanOrEqual(domain.min[1] - tol);
    expect(box.max.y).toBeLessThanOrEqual(domain.max[1] + tol);
    expect(box.min.z).toBeGreaterThanOrEqual(domain.min[2] - tol);
    expect(box.max.z).toBeLessThanOrEqual(domain.max[2] + tol);
    t.dispose();
  });

  it('keeps the middle of the tunnel clear: only the sting is near the wing', () => {
    const t = new WindTunnel();
    t.setDomain(domain);
    t.setMountPoint([1, 0, 0]);
    t.object.updateMatrixWorld(true);
    // Everything in the tunnel group other than the sting must stay out of the wing's volume,
    // i.e. nothing opaque-ish sits in the interior (walls/ceiling/floor/inlet/outlet only).
    const wing = new THREE.Box3(new THREE.Vector3(-3, -18, -2), new THREE.Vector3(8, 18, 2));
    t.object.traverse((o) => {
      if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.LineSegments)) return;
      if (o.name === 'Sting' || o.name === 'StingBase') return;
      const box = new THREE.Box3().setFromObject(o);
      // Large flat panes may span the volume but must be on the boundary planes.
      const size = box.getSize(new THREE.Vector3());
      const flat = Math.min(size.x, size.y, size.z) < 0.5;
      const edgeOnly = o instanceof THREE.LineSegments;
      if (!flat && !edgeOnly) expect(box.intersectsBox(wing)).toBe(false);
    });
    t.dispose();
  });

  it('sting runs from the floor to the mount point', () => {
    const t = new WindTunnel();
    t.setDomain(domain);
    t.setMountPoint([1.2, 0, 0.3]);
    const strut = t.object.getObjectByName('Sting')!;
    expect(strut.position.z).toBeCloseTo(domain.min[2], 9);
    expect(strut.position.x).toBeCloseTo(1.2, 9);
    expect(strut.scale.z).toBeCloseTo(0.3 - domain.min[2], 9);
    // Moving the mount point updates it in place.
    t.setMountPoint([2, 0.5, 1]);
    expect(strut.scale.z).toBeCloseTo(1 - domain.min[2], 9);
    expect(strut.position.y).toBeCloseTo(0.5, 9);
    t.dispose();
  });

  it('applies a mount point set before the domain, and rebuilds cleanly on a new domain', () => {
    const t = new WindTunnel();
    t.setMountPoint([0.5, 0, 0]);
    expect(t.object.getObjectByName('Sting')).toBeUndefined();
    t.setDomain(domain);
    expect(t.object.getObjectByName('Sting')).toBeDefined();
    const before = new Set<THREE.Object3D>();
    t.object.traverse((o) => before.add(o));
    t.setDomain(tunnelDomain(12, 1.5));
    const walls = t.object.children[0]!.children.filter((c) => c.name === 'WallLeft');
    expect(walls).toHaveLength(1);
    // Old shell objects are gone, the sting persists.
    const after = new Set<THREE.Object3D>();
    t.object.traverse((o) => after.add(o));
    expect(after.has(t.object.getObjectByName('Sting')!)).toBe(true);
    for (const o of before) {
      if (o.name === 'WallLeft') expect(after.has(o)).toBe(false);
    }
    t.dispose();
  });

  it('spins the fan through the frame-tick hook', () => {
    const t = new WindTunnel();
    t.setDomain(domain);
    const fan = t.object.getObjectByName('OutletFan')!;
    const tick = getFrameTick(fan);
    expect(tick).toBeTypeOf('function');
    const r0 = fan.rotation.x;
    tick!(0.1, 1);
    expect(fan.rotation.x).toBeGreaterThan(r0);
    t.dispose();
  });

  it('dispose releases GPU resources', () => {
    const t = new WindTunnel();
    t.setDomain(domain);
    const grid = t.object.getObjectByName('FloorGrid') as THREE.LineSegments;
    let geometryDisposed = false;
    let materialDisposed = false;
    grid.geometry.addEventListener('dispose', () => (geometryDisposed = true));
    (grid.material as THREE.Material).addEventListener('dispose', () => (materialDisposed = true));
    t.dispose();
    expect(geometryDisposed).toBe(true);
    expect(materialDisposed).toBe(true);
  });
});
