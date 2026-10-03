/** 3D wing benchmarks: inviscid lattice vs AVL, full model vs NACA swept-wing tests. */
import { describe, expect, it } from 'vitest';
import { buildWingGeometry } from '../wing/geometry';
import { benchmarkWing, sweptWingExperimentChecks, vlmChecks } from './checks';
import { runChecks } from './benchmarkTest';
import vlm3d from './reference/vlm_3d.json';

describe('benchmark geometry matches the reference runs', () => {
  for (const c of vlm3d.cases) {
    it(`${c.id}: buildWingGeometry reproduces the sections given to AVL`, () => {
      const g = buildWingGeometry(benchmarkWing(c.config));
      const right = g.surfaces.find((s) => s.side === 'right' && s.role === 'wing')!;
      expect(right.sections.length).toBe(c.sections.length);
      right.sections.forEach((s, k) => {
        const ref = c.sections[k]!;
        for (let i = 0; i < 3; i++) expect(s.le[i]).toBeCloseTo(ref.le[i]!, 9);
        expect(s.chord).toBeCloseTo(ref.chord, 9);
        expect(s.twist).toBeCloseTo(ref.twist, 9);
        expect(s.roll).toBeCloseTo(ref.roll, 9);
      });
      expect(g.referenceArea).toBeCloseTo(c.reference.S, 9);
      expect(g.meanAeroChord).toBeCloseTo(c.reference.mac, 9);
    });
  }
});

describe('3D lattice vs AVL', () => runChecks(vlmChecks()));
describe('3D wing vs NACA swept-wing tunnel tests', () => runChecks(sweptWingExperimentChecks()));
