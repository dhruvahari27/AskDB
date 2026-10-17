import { createHash } from 'node:crypto';
import type { Cell } from './schemas';

/**
 * Result comparison used both by the clarification engine (do two readings return the same
 * rows?) and by the eval scorer (does the predicted SQL return the gold rows?).
 *
 * Rules, chosen to match how a business user would judge "same answer":
 *  - column names and column order are ignored
 *  - row order is ignored
 *  - numbers are compared at 2 decimals (so round(x, 2) and x are the same answer)
 *  - dates/timestamps compare by their ISO string
 */
export function normalizeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const r = Math.round(value * 100) / 100;
    return Object.is(r, -0) ? '0' : String(r);
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Order-insensitive fingerprint of a result's rows. Column order is normalised by sorting each row's cells. */
export function resultFingerprint(rows: unknown[][]): string {
  const normalised = rows.map((row) => row.map(normalizeCell).map((c) => (c === null ? '\u0000null' : String(c))).sort().join('\u001f'));
  normalised.sort();
  const h = createHash('sha1');
  h.update(String(rows.length));
  h.update('\u001e');
  h.update(normalised.join('\u001e'));
  return h.digest('hex');
}

/** True when two results hold the same rows under the rules above. */
export function sameResult(a: unknown[][], b: unknown[][]): boolean {
  return resultFingerprint(a) === resultFingerprint(b);
}
