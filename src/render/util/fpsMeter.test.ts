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

  it('does not report a low rate after one long gap such as returning to the tab', () => {
    for (const gap of [3, 20]) {
      for (let phase = 0; phase < 15; phase++) {
        const m = new FpsMeter(60);
        for (let i = 0; i < 120 + phase; i++) m.tick(1 / 60);
        m.tick(gap);
        for (let i = 0; i < 120; i++) {
          expect(m.fps).toBeGreaterThan(35);
          m.tick(1 / 60);
        }
        expect(m.fps).toBeCloseTo(60, 0);
      }
    }
  });

  it('still reports a genuinely slow frame rate', () => {
    const m = new FpsMeter(60);
    for (let i = 0; i < 10; i++) m.tick(0.5);
    expect(m.fps).toBeLessThan(5);
  });

  it('ignores invalid samples', () => {
    const m = new FpsMeter(60);
    m.tick(NaN);
    m.tick(-1);
    m.tick(Infinity);
    expect(m.fps).toBe(60);
  });
});
