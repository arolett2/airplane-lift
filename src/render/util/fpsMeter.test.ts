import { describe, expect, it } from 'vitest';
import { FpsMeter } from './fpsMeter';

describe('FpsMeter', () => {
  it('reports the initial value until enough frames are measured', () => {
    const m = new FpsMeter(60);
    m.tick(1 / 30);
    expect(m.fps).toBe(60);
  });

  it('converges to the steady frame rate', () => {
    for (const hz of [30, 60, 144]) {
      const m = new FpsMeter(60);
      for (let i = 0; i < hz * 3; i++) m.tick(1 / hz);
      expect(m.fps).toBeCloseTo(hz, 0);
    }
  });

  it('forgets old frames after about a second', () => {
    const m = new FpsMeter(60);
    for (let i = 0; i < 120; i++) m.tick(1 / 120);
    for (let i = 0; i < 60; i++) m.tick(1 / 20);
    expect(m.fps).toBeCloseTo(20, 0);
  });

  it('ignores invalid samples', () => {
    const m = new FpsMeter(60);
    m.tick(NaN);
    m.tick(-1);
    m.tick(Infinity);
    expect(m.fps).toBe(60);
  });
});
