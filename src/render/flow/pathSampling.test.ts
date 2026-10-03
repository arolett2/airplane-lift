import { describe, expect, it } from 'vitest';
import { findSegment, pathDuration, positionAtTime, sampleLineAtTime } from './pathSampling';
import type { Streamline3D } from '../../physics/types';

function line(points: number[], time: number[], speed?: number[]): Streamline3D {
  return {
    points: new Float32Array(points),
    time: new Float32Array(time),
    speed: new Float32Array(speed ?? time.map(() => 1)),
    group: 'rake',
  };
}

describe('findSegment', () => {
  const t = new Float32Array([0, 1, 2, 4, 8]);
  it('finds the bracketing segment', () => {
    expect(findSegment(t, 5, 0)).toBe(0);
    expect(findSegment(t, 5, 0.5)).toBe(0);
    expect(findSegment(t, 5, 1)).toBe(1);
    expect(findSegment(t, 5, 3.9)).toBe(2);
    expect(findSegment(t, 5, 4)).toBe(3);
    expect(findSegment(t, 5, 7.99)).toBe(3);
  });
  it('clamps at the ends', () => {
    expect(findSegment(t, 5, -5)).toBe(0);
    expect(findSegment(t, 5, 8)).toBe(3);
    expect(findSegment(t, 5, 100)).toBe(3);
  });
});

describe('positionAtTime', () => {
  const l = line([0, 0, 0, 10, 0, 0, 10, 20, 0, 10, 20, 30], [0, 1, 3, 4]);

  it('returns the vertices exactly at the knot times', () => {
    const out = [0, 0, 0];
    expect(positionAtTime(l, 0, out)).toBe(true);
    expect(out).toEqual([0, 0, 0]);
    expect(positionAtTime(l, 1, out)).toBe(true);
    expect(out).toEqual([10, 0, 0]);
    expect(positionAtTime(l, 3, out)).toBe(true);
    expect(out).toEqual([10, 20, 0]);
    expect(positionAtTime(l, 4, out)).toBe(true);
    expect(out).toEqual([10, 20, 30]);
  });

  it('interpolates linearly in time, including across uneven spacing', () => {
    const out = new Float32Array(3);
    positionAtTime(l, 0.5, out);
    expect([...out]).toEqual([5, 0, 0]);
    positionAtTime(l, 2, out); // midway through the 2 s segment
    expect([...out]).toEqual([10, 10, 0]);
    positionAtTime(l, 3.25, out);
    expect([...out]).toEqual([10, 20, 7.5]);
  });

  it('returns false and leaves out untouched outside the time span', () => {
    const out = [7, 8, 9];
    expect(positionAtTime(l, -0.001, out)).toBe(false);
    expect(positionAtTime(l, 4.001, out)).toBe(false);
    expect(positionAtTime(l, NaN, out)).toBe(false);
    expect(out).toEqual([7, 8, 9]);
  });

  it('respects a non-zero starting time', () => {
    const shifted = line([0, 0, 0, 4, 0, 0], [2, 4]);
    const out = [0, 0, 0];
    expect(positionAtTime(shifted, 1, out)).toBe(false);
    expect(positionAtTime(shifted, 3, out)).toBe(true);
    expect(out[0]).toBeCloseTo(2, 6);
  });

  it('handles degenerate lines', () => {
    const out = [0, 0, 0];
    expect(positionAtTime(line([1, 2, 3], [0]), 0, out)).toBe(false);
    expect(positionAtTime(line([], []), 0, out)).toBe(false);
    // Repeated time stamps must not divide by zero.
    const dup = line([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 1]);
    expect(positionAtTime(dup, 1, out)).toBe(true);
    expect(Number.isFinite(out[0])).toBe(true);
  });

  it('does not allocate: the supplied array is written in place', () => {
    const out = new Float32Array(6);
    sampleLineAtTime(l, 0.5, out, 3);
    expect([...out]).toEqual([0, 0, 0, 5, 0, 0]);
  });
});

describe('sampleLineAtTime', () => {
  it('interpolates the speed ratio alongside the position', () => {
    const l = line([0, 0, 0, 2, 0, 0], [0, 2], [1, 2]);
    const out = [0, 0, 0];
    expect(sampleLineAtTime(l, 1.5, out, 0)).toBeCloseTo(1.75, 6);
    expect(sampleLineAtTime(l, 5, out, 0)).toBe(-1);
  });
});

describe('pathDuration', () => {
  it('is the span of the time array', () => {
    expect(pathDuration(line([0, 0, 0, 1, 0, 0], [1, 3.5]))).toBeCloseTo(2.5, 6);
    expect(pathDuration(line([0, 0, 0], [0]))).toBe(0);
  });
});
