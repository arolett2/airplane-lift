/**
 * Plain-text benchmark table for `npm run benchmark` (and the table in docs/VALIDATION.md).
 */
import type { EvaluatedCheck } from './checks';
import { allChecks, evaluate } from './checks';
import { TOLERANCES } from './tolerances';

function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1e4)) return v.toExponential(2);
  return v.toFixed(a < 0.1 ? 4 : 3);
}

function errorText(c: EvaluatedCheck): string {
  const tol = TOLERANCES[c.tolerance];
  return tol.kind === 'rel' ? `${(c.error * 100).toFixed(1)}%` : num(c.error);
}

function toleranceText(c: EvaluatedCheck): string {
  const tol = TOLERANCES[c.tolerance];
  return tol.kind === 'rel' ? `±${Math.round(tol.value * 1000) / 10}%` : `±${tol.value}`;
}

function status(c: EvaluatedCheck): string {
  if (c.pass) return c.knownDeviation ? 'PASS (listed as known!)' : 'PASS';
  return c.knownDeviation ? 'KNOWN' : 'FAIL';
}

export function evaluateAll(): EvaluatedCheck[] {
  return allChecks().map(evaluate);
}

/** Rows as string cells: group, quantity, model, reference, error, tolerance, result. */
export function tableRows(results: EvaluatedCheck[]): string[][] {
  return results.map((c) => [
    c.group,
    `${c.quantity}${c.unit !== '-' && c.unit !== 'bool' ? ` [${c.unit}]` : ''}`,
    num(c.model),
    num(c.reference),
    errorText(c),
    toleranceText(c),
    status(c),
  ]);
}

const HEADER = ['Group', 'Quantity', 'Model', 'Reference', 'Error', 'Tolerance', 'Result'];

export function formatTable(results: EvaluatedCheck[]): string {
  const rows = [HEADER, ...tableRows(results)];
  const widths = HEADER.map((_, j) => Math.max(...rows.map((r) => r[j]!.length)));
  const line = (r: string[]) => r.map((cell, j) => cell.padEnd(widths[j]!)).join('  ');
  const out = [line(rows[0]!), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows.slice(1)) out.push(line(r));
  const pass = results.filter((c) => c.pass).length;
  const known = results.filter((c) => !c.pass && c.knownDeviation).length;
  const fail = results.length - pass - known;
  out.push('', `${results.length} checks: ${pass} pass, ${known} known deviations, ${fail} fail`);
  return out.join('\n');
}

export function formatMarkdown(results: EvaluatedCheck[]): string {
  const rows = tableRows(results).map((r) => `| ${r.join(' | ')} |`);
  return [`| ${HEADER.join(' | ')} |`, `|${HEADER.map(() => ' --- ').join('|')}|`, ...rows].join(
    '\n',
  );
}
