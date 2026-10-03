/**
 * Shared vitest driver: one test per check. A check listed in KNOWN_DEVIATIONS runs as
 * `it.fails`, so it must keep failing (the gap stays visible) until it is fixed and unlisted.
 */
import { expect, it } from 'vitest';
import type { BenchmarkCheck } from './checks';
import { evaluate } from './checks';
import { TOLERANCES } from './tolerances';

export function runChecks(checks: BenchmarkCheck[]): void {
  for (const check of checks) {
    const r = evaluate(check);
    const tol = TOLERANCES[check.tolerance];
    const name = `${check.quantity}: model ${fmt(r.model)} vs ${fmt(r.reference)} (${check.source})`;
    const body = () => {
      expect(Number.isFinite(r.model), 'model value is finite').toBe(true);
      expect(
        Math.abs(r.error),
        `${check.id}: error ${fmt(r.error)} (${tol.kind}) vs tolerance ${tol.value}`,
      ).toBeLessThanOrEqual(tol.value + 1e-12);
    };
    if (r.knownDeviation) it.fails(`[known deviation] ${name}`, body);
    else it(name, body);
  }
}

function fmt(v: number): string {
  return Number.isFinite(v) ? Number(v.toPrecision(4)).toString() : String(v);
}
