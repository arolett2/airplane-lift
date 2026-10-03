// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three';
import { tunnelDomain } from '../../physics/domain';
import { WindTunnel } from './WindTunnel';

/** happy-dom has no 2D canvas; a recording stub is enough to paint the marking. */
function stubCanvas2D(): { texts: string[] } {
  const texts: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'fillText') return (s: string) => texts.push(s);
        if (prop === 'measureText') return () => ({ width: 40 });
        return () => {};
      },
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  return { texts };
}

afterEach(() => vi.restoreAllMocks());

describe('WindTunnel AIRFLOW floor marking', () => {
  it('paints the word once, lays it on the floor reading along +x, and reuses the texture', () => {
    const { texts } = stubCanvas2D();
    const t = new WindTunnel();
    const domain = tunnelDomain(30, 3);
    t.setDomain(domain);
    const mark = t.object.getObjectByName('AirflowMarking') as THREE.Mesh;
    expect(mark).toBeDefined();
    expect(texts.join('')).toBe('AIRFLOW');
    // On the floor, left of the wing's path, flat (no rotation: text +x = flow, text up = +y).
    expect(mark.position.z).toBeGreaterThan(domain.min[2]);
    expect(mark.position.z).toBeLessThan(domain.min[2] + 0.2);
    expect(mark.position.y).toBeLessThan(-0.3 * (domain.max[1] - domain.min[1]) * 0.5);
    expect(mark.quaternion.w).toBeCloseTo(1, 12);
    const tex = (mark.material as THREE.MeshBasicMaterial).map!;
    let disposed = false;
    tex.addEventListener('dispose', () => (disposed = true));

    t.setDomain(tunnelDomain(60, 5)); // rebuild
    const mark2 = t.object.getObjectByName('AirflowMarking') as THREE.Mesh;
    expect(mark2).not.toBe(mark);
    expect((mark2.material as THREE.MeshBasicMaterial).map).toBe(tex);
    expect(disposed).toBe(false);
    expect(texts.join('')).toBe('AIRFLOW'); // not repainted

    t.dispose();
    expect(disposed).toBe(true);
  });
});
