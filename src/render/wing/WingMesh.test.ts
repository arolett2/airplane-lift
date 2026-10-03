import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WingMesh } from './WingMesh';
import { makeTestStrips, makeTestWing } from '../util/testFixtures';
import { bodyToTunnel } from '../../physics/math/frames';
import type { Vec3 } from '../../physics/types';

function wingMeshOf(wm: WingMesh): THREE.Mesh {
  const mesh = wm.object.getObjectByName('Wing');
  if (!(mesh instanceof THREE.Mesh)) throw new Error('wing mesh missing');
  return mesh;
}

describe('WingMesh pitch matches the physics frames', () => {
  const geo = makeTestWing({ sweepDeg: 25, dihedralDeg: 4 });

  it('maps every body-frame vertex exactly like bodyToTunnel', () => {
    const wm = new WingMesh();
    wm.setGeometry(geo);
    const mesh = wingMeshOf(wm);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (const alphaDeg of [0, 5, -7, 18]) {
      const alpha = (alphaDeg * Math.PI) / 180;
      wm.setAlpha(alpha);
      wm.object.updateMatrixWorld(true);
      for (const i of [0, 40, 81, 500, 1000, Math.floor(pos.count / 2), pos.count - 1]) {
        const body: Vec3 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        const world = new THREE.Vector3(...body).applyMatrix4(mesh.matrixWorld);
        const expected = bodyToTunnel(body, geo.pivot, alpha);
        expect(world.x).toBeCloseTo(expected[0], 9);
        expect(world.y).toBeCloseTo(expected[1], 9);
        expect(world.z).toBeCloseTo(expected[2], 9);
      }
    }
    wm.dispose();
  });

  it('raises the leading edge for positive alpha and keeps the pivot fixed', () => {
    const wm = new WingMesh();
    wm.setGeometry(geo);
    wm.setAlpha(0.2);
    wm.object.updateMatrixWorld(true);
    const mesh = wingMeshOf(wm);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    // Root LE vertex of the right wing: ring 0, index 40 (x/c = 0).
    const le = new THREE.Vector3(pos.getX(40), pos.getY(40), pos.getZ(40)).applyMatrix4(
      mesh.matrixWorld,
    );
    expect(le.z).toBeGreaterThan(geo.surfaces[0]!.sections[0]!.le[2] + 0.05);
    const p = new THREE.Vector3(...geo.pivot).applyMatrix4(mesh.matrixWorld);
    // The pivot is a fixed point of the rotation (mesh offset by -pivot, group at +pivot).
    expect(p.x - geo.pivot[0]).toBeCloseTo(0, 9);
    expect(p.z - geo.pivot[2]).toBeCloseTo(0, 9);
    wm.dispose();
  });
});

describe('WingMesh state', () => {
  it('builds geometry, colours it from strips and toggles the pressure material', () => {
    const geo = makeTestWing({ winglet: true });
    const wm = new WingMesh();
    // Strips may arrive before geometry.
    wm.setStrips(makeTestStrips(geo));
    wm.setGeometry(geo);
    const mesh = wingMeshOf(wm);
    const color = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(color.count).toBe(mesh.geometry.getAttribute('position').count);
    expect(Array.from(color.array).some((c) => c > 0)).toBe(true);
    const before = Array.from(color.array.slice(0, 600));
    wm.setStrips(null);
    const after = Array.from(
      (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).array.slice(0, 600),
    );
    expect(after).not.toEqual(before);

    const pressure = mesh.material;
    wm.setPressureVisible(false);
    expect(mesh.material).not.toBe(pressure);
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    wm.setPressureVisible(true);
    expect(mesh.material).toBe(pressure);
    wm.dispose();
  });

  it('reuses GPU buffers when only the shape changes, and rebuilds when topology changes', () => {
    const wm = new WingMesh();
    wm.setGeometry(makeTestWing({ semispan: 5 }));
    const g1 = wingMeshOf(wm).geometry;
    wm.setGeometry(makeTestWing({ semispan: 6, sweepDeg: 30 }));
    expect(wingMeshOf(wm).geometry).toBe(g1);
    wm.setGeometry(makeTestWing({ winglet: true }));
    expect(wingMeshOf(wm).geometry).not.toBe(g1);
    wm.dispose();
  });

  it('dispose frees the geometry and materials', () => {
    const wm = new WingMesh();
    wm.setGeometry(makeTestWing());
    const mesh = wingMeshOf(wm);
    let geoDisposed = false;
    let matDisposed = false;
    mesh.geometry.addEventListener('dispose', () => (geoDisposed = true));
    (mesh.material as THREE.Material).addEventListener('dispose', () => (matDisposed = true));
    wm.dispose();
    expect(geoDisposed).toBe(true);
    expect(matDisposed).toBe(true);
  });
});
