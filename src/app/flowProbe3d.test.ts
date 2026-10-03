import { describe, expect, it } from 'vitest';
import { computeAero, createAeroCache } from '../physics/aero';
import { domainForGeometry } from '../physics/domain';
import { probeFlow } from '../physics/flow/probe';
import { DEFAULT_FLOW, DEFAULT_WING } from '../state/params';
import {
  clampToDomain,
  defaultProbePoint,
  flowAngles,
  nudgeProbe,
  probeReadout,
  probeSlice,
} from './flowProbe3d';

const DEG = Math.PI / 180;
const { geometry, aero } = computeAero(DEFAULT_WING, DEFAULT_FLOW, 1, createAeroCache());
const domain = domainForGeometry(geometry);

describe('3D probe helpers', () => {
  it('starts just above the wing at the cross-section station, in the air', () => {
    const p = defaultProbePoint(aero, geometry, 0.35);
    expect(p[1]).toBeCloseTo(0.35 * 5, 0);
    const sample = probeFlow(geometry, aero, p);
    expect(sample.inside).toBe(false);
    expect(sample.deltaPressure).toBeLessThan(0); // low pressure over the wing
  });

  it('moves with the keys inside the tunnel', () => {
    const p: [number, number, number] = [0, 1, 0];
    expect(nudgeProbe(p, 'ArrowRight', false, 0.1, domain)).toEqual([0.1, 1, 0]);
    expect(nudgeProbe(p, 'ArrowDown', true, 0.1, domain)![2]).toBeCloseTo(-1, 12);
    expect(nudgeProbe(p, 'PageUp', false, 0.1, domain)![1]).toBeCloseTo(1.1, 12);
    expect(nudgeProbe(p, 'a', false, 0.1, domain)).toBeNull();
    const far = nudgeProbe([domain.max[0], 0, 0], 'ArrowRight', true, 1, domain)!;
    expect(far[0]).toBe(domain.max[0]);
    expect(clampToDomain([1e9, -1e9, 0], domain)).toEqual([domain.max[0], domain.min[1], 0]);
  });

  it('spans the tunnel in the slice', () => {
    const s = probeSlice(domain, 1.2);
    expect(s).toEqual({
      y: 1.2,
      xMin: domain.min[0],
      xMax: domain.max[0],
      zMin: domain.min[2],
      zMax: domain.max[2],
    });
  });

  it('measures flow angles from the wind, sideways positive toward the near tip', () => {
    const a = flowAngles([10, 1, -1], 2);
    expect(a.up).toBeLessThan(0);
    expect(a.side).toBeGreaterThan(0);
    expect(flowAngles([10, 1, 0], -2).side).toBeLessThan(0);
    expect(flowAngles([1, 0, Math.tan(5 * DEG)], 0).up).toBeCloseTo(5 * DEG, 9);
  });

  it('words the readout card, including inside the wing', () => {
    const above = probeReadout(
      probeFlow(geometry, aero, defaultProbePoint(aero, geometry, 0.35)),
      'metric',
    );
    expect(above.readout.tone).toBe('low');
    expect(above.readout.lines[0]).toMatch(/km\/h · \d.*faster than the wind/);
    expect(above.readout.lines[1]).toMatch(/below the air around it \(−\d/);
    const strip = aero.strips.find((s) => s.side === 'right' && s.eta > 0.3)!;
    const inside = probeReadout(probeFlow(geometry, aero, strip.center), 'metric');
    expect(inside.readout.tone).toBe('inside');
    expect(inside.readout.lines[0]).toBe('Inside the wing');
  });
});
