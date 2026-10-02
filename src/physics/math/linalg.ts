/**
 * Dense linear algebra for the panel and vortex-lattice solvers.
 * Matrices are row-major Float64Arrays of size n*n.
 */

export interface LuFactorization {
  n: number;
  /** Combined L (unit diagonal, below) and U (on/above diagonal), row-major. */
  lu: Float64Array;
  /** Row permutation: row i of the factorization is row perm[i] of the original. */
  perm: Int32Array;
}

/** LU factorization with partial pivoting. Does not modify `a`. Throws if singular. */
export function luFactor(a: Float64Array, n: number): LuFactorization {
  if (a.length !== n * n) throw new Error(`luFactor: expected ${n * n} entries, got ${a.length}`);
  const lu = Float64Array.from(a);
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;

  for (let k = 0; k < n; k++) {
    // Pivot: largest magnitude in column k at or below the diagonal.
    let p = k;
    let max = Math.abs(lu[k * n + k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(lu[i * n + k]!);
      if (v > max) {
        max = v;
        p = i;
      }
    }
    if (max < 1e-300) throw new Error(`luFactor: matrix is singular at column ${k}`);
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = lu[k * n + j]!;
        lu[k * n + j] = lu[p * n + j]!;
        lu[p * n + j] = t;
      }
      const t = perm[k]!;
      perm[k] = perm[p]!;
      perm[p] = t;
    }
    const pivot = lu[k * n + k]!;
    for (let i = k + 1; i < n; i++) {
      const f = (lu[i * n + k]! /= pivot);
      if (f === 0) continue;
      const rowI = i * n;
      const rowK = k * n;
      for (let j = k + 1; j < n; j++) lu[rowI + j] = lu[rowI + j]! - f * lu[rowK + j]!;
    }
  }
  return { n, lu, perm };
}

/** Solve A x = b using a factorization from `luFactor`. Writes into `out` if given. */
export function luSolve(
  f: LuFactorization,
  b: ArrayLike<number>,
  out?: Float64Array,
): Float64Array {
  const { n, lu, perm } = f;
  const x = out ?? new Float64Array(n);
  // Forward substitution (L has unit diagonal), applying the permutation.
  for (let i = 0; i < n; i++) {
    let s = b[perm[i]!]!;
    const row = i * n;
    for (let j = 0; j < i; j++) s -= lu[row + j]! * x[j]!;
    x[i] = s;
  }
  // Back substitution.
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    const row = i * n;
    for (let j = i + 1; j < n; j++) s -= lu[row + j]! * x[j]!;
    x[i] = s / lu[row + i]!;
  }
  return x;
}

/** Convenience: solve A x = b once. */
export function solveDense(a: Float64Array, b: ArrayLike<number>, n: number): Float64Array {
  return luSolve(luFactor(a, n), b);
}
