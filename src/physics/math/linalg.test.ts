import { describe, expect, it } from 'vitest';
import { luFactor, luSolve, solveDense } from './linalg';

describe('linalg', () => {
  it('solves a system that needs pivoting', () => {
    const a = Float64Array.from([0, 2, 1, 1, 1, 1, 2, 1, 0]);
    const x = solveDense(a, [5, 6, 4], 3);
    // Check A x = b.
    expect(0 * x[0]! + 2 * x[1]! + 1 * x[2]!).toBeCloseTo(5, 12);
    expect(x[0]! + x[1]! + x[2]!).toBeCloseTo(6, 12);
    expect(2 * x[0]! + x[1]!).toBeCloseTo(4, 12);
  });

  it('reuses a factorisation for many right-hand sides', () => {
    const n = 30;
    const a = new Float64Array(n * n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) a[i * n + j] = i === j ? n : 1 / (1 + i + j);
    const f = luFactor(a, n);
    for (let trial = 0; trial < 3; trial++) {
      const xTrue = Float64Array.from({ length: n }, (_, i) => Math.sin(i + trial));
      const b = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i]! += a[i * n + j]! * xTrue[j]!;
      const x = luSolve(f, b);
      for (let i = 0; i < n; i++) expect(x[i]).toBeCloseTo(xTrue[i]!, 10);
    }
  });

  it('throws on a singular matrix', () => {
    expect(() => luFactor(Float64Array.from([1, 2, 2, 4]), 2)).toThrow(/singular/);
  });
});
